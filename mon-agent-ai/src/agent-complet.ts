import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatMistralAI } from "@langchain/mistralai";
import { ChatOpenAI } from "@langchain/openai";   // ← Cerebras via wrapper OpenAI-compatible
import { ChatCohere } from "@langchain/cohere";
// ChatCerebras (@langchain/cerebras) SUPPRIMÉ : incompatible avec @langchain/core@0.3.x
// Cerebras est utilisé via ChatOpenAI avec baseURL custom (zéro conflit de dépendance)
import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { HumanMessage, AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { InMemoryCache } from "@langchain/core/caches";
import { outilsDeBase } from "./tools";
import { browserTools } from "./browser/browser-tools";
import { e2bTools } from "./browser/e2b-tools";
import { credentialTools } from "./browser/credentials";
import { debugTools } from "./browser/debug-tools";
import { fsMemoryTools, offloadSiVolumineux, INSTRUCTIONS_FILE, TODO_FILE } from "./memory/fs-memory";
import { navigateur } from "./browser/browser-manager";
import { e2bSandbox } from "./browser/e2b-sandbox";
import { AdvancedContextManager, ContextConfig } from "./context/context-manager";
import * as fs from "fs";
import * as readline from "readline";
import * as dotenv from "dotenv";
import console from "console";

dotenv.config();

// UTILITAIRES

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// CLASSIFICATION DES ERREURS API

type ErrorKind =
    | "QUOTA_EXHAUSTED"  // quota journalier épuisé → skip définitif dans la session
    | "SKIP_REQUEST"     // erreur de format pour CETTE requête → skip mais provider réutilisable
    | "RATE_LIMIT"       // trop de requêtes → attendre et réessayer
    | "RETRYABLE"        // erreur temporaire → réessayer
    | "FATAL";           // erreur irrécupérable → stopper

function classifierErreur(error: any): ErrorKind {
    const msg    = (error?.message ?? "").toLowerCase();
    const status = error?.status ?? 0;

    if (
        msg.includes("limit: 0") ||
        msg.includes("per_day") ||
        (msg.includes("quota") && msg.includes("exceeded") && msg.includes("day"))
    ) return "QUOTA_EXHAUSTED";

    if (
        status === 429 ||
        msg.includes("rate_limit") ||
        msg.includes("rate limit") ||
        msg.includes("too many requests") ||
        msg.includes("resource_exhausted") ||
        (msg.includes("quota") && msg.includes("exceeded") && !msg.includes("day"))
    ) return "RATE_LIMIT";

    if (
        status === 503 ||
        msg.includes("overloaded") ||
        msg.includes("timeout") ||
        msg.includes("unavailable")
    ) return "RETRYABLE";

    // 404 = modèle introuvable → passer au suivant
    if (status === 404 || msg.includes("model_not_found") || msg.includes("no body")) {
        return "QUOTA_EXHAUSTED";
    }

    // 413 = requête trop grande pour ce modèle → passer au suivant
    // (llama-3.1-8b a une petite fenêtre de contexte ~8K tokens)
    if (status === 413 || msg.includes("request too large") || msg.includes("too large")) {
        return "QUOTA_EXHAUSTED";
    }

    // Cohere : "Missing required key type" = incompatibilité de schema → passer au suivant
    if (msg.includes("missing required key") || msg.includes("parameterdefinitions")) {
        return "QUOTA_EXHAUSTED";
    }

    // Mistral / OpenAI : erreur de FORMAT de message pour cette requête spécifique.
    // → SKIP_REQUEST (pas QUOTA_EXHAUSTED) : le provider reste disponible pour la prochaine requête.
    if (
        msg.includes("tool call id has to be defined") ||
        msg.includes("expected last role") ||
        msg.includes("message_order") ||
        msg.includes("invalid_request_message") ||
        msg.includes("all openai tool calls must have an") ||
        msg.includes("id" field")
    ) {
        return "SKIP_REQUEST";
    }

    // Gemini thinking : thought_signature manquant → skip cette requête
    if (msg.includes("thought_signature") || msg.includes("missing a thought")) {
        return "SKIP_REQUEST";
    }

    return "FATAL";
}

// RATE LIMITER

class RateLimiter {
    private lastCallTime = 0;
    private readonly minDelay: number;

    constructor(requestsPerMinute: number) {
        this.minDelay = (60 / requestsPerMinute) * 1000;
    }

    async wait(): Promise<void> {
        const now     = Date.now();
        const elapsed = now - this.lastCallTime;
        if (elapsed < this.minDelay) {
            const waitMs = this.minDelay - elapsed;
            console.log(`🕒 Rate limiter : pause ${Math.round(waitMs)}ms...`);
            await sleep(waitMs);
        }
        this.lastCallTime = Date.now();
    }
}

// GESTIONNAIRE MULTI-PROVIDER AVEC FALLBACK AUTOMATIQUE

interface ProviderConfig {
    name: string;
    rpm: number;
    maxRetries: number;
    factory: (tools: any[]) => any;
}

/**
 * Chaîne de fallback — 7 providers, 7 quotas indépendants.
 *
 * ┌──────────────────────────────┬──────┬──────────────┬─────────────────────┐
 * │ Provider / Modèle            │ RPM  │ Req/jour     │ Notes               │
 * ├──────────────────────────────┼──────┼──────────────┼─────────────────────┤
 * │ Gemini 2.0 Flash             │  55  │    1 500     │ Meilleur pour agent │
 * │ Cerebras llama-3.3-70b       │  28  │  illimité    │ Via wrapper OpenAI  │
 * │ Groq llama-3.3-70b           │  25  │   14 400     │                     │
 * │ Cohere command-r             │  20  │    1 000     │                     │
 * │ Groq llama-3.1-8b            │  25  │   14 400 *   │ Quota séparé        │
 * │ Gemini 2.5 Flash             │   9  │      500 *   │ Quota séparé        │
 * │ Mistral small                │   4  │  illimité    │ 1 Md tokens/mois    │
 * │ Gemini gemini-3-flash-preview│   9  │      500 *   │ Dernier recours     │
 * └──────────────────────────────┴──────┴──────────────┴─────────────────────┘
 */
const PROVIDERS_CHAIN: ProviderConfig[] = [
    // ── 1. Gemini 2.0 Flash — meilleur pour l'agentic (60 RPM)
    {
        name: "Gemini 2.0 Flash",
        rpm: 55,
        maxRetries: 3,
        factory: (tools) => new ChatGoogleGenerativeAI({
            model: "gemini-2.0-flash",
            temperature: 0,
            apiKey: process.env.GOOGLE_API_KEY,
            maxRetries: 0,
        }).bindTools(tools),
    },

    // ── 2. Cerebras llama-3.3-70b — quota illimité, ultra-rapide
    //       Utilise ChatOpenAI avec baseURL custom : zéro conflit de dépendance,
    //       car @langchain/cerebras@1.0.x est incompatible avec @langchain/core@0.3.x
    {
        name: "Cerebras llama-3.3-70b",
        rpm: 28,
        maxRetries: 3,
        factory: (tools) => new ChatOpenAI({
            model: "llama-3.3-70b",
            temperature: 0,
            apiKey: process.env.CEREBRAS_API_KEY,
            configuration: {
                baseURL: "https://api.cerebras.ai/v1",
            },
            maxRetries: 0,
        // strict: false — désactive la validation Zod stricte d'OpenAI
        // Nécessaire car Cerebras n'impose pas le mode "structured outputs"
        // et nos tools utilisent .optional() sans .nullable()
        }).bindTools(tools, { strict: false }),
    },

    // ── 3. Groq llama-3.3-70b — 14 400 req/jour, très capable
    {
        name: "Groq llama-3.3-70b",
        rpm: 25,
        maxRetries: 3,
        factory: (tools) => new ChatGroq({
            model: "llama-3.3-70b-versatile",
            temperature: 0,
            apiKey: process.env.GROQ_API_KEY,
            maxRetries: 0,
        }).bindTools(tools),
    },

    // ── 4. Cohere command-r
    {
        name: "Cohere command-r",
        rpm: 20,
        maxRetries: 3,
        factory: (tools) => new ChatCohere({
            model: "command-r",
            temperature: 0,
            apiKey: process.env.COHERE_API_KEY,
            maxRetries: 0,
        }).bindTools(tools, { strict: false }),
    },

    // ── 5. Groq llama-3.1-8b — quota SÉPARÉ du 3.3-70b, très rapide
    {
        name: "Groq llama-3.1-8b",
        rpm: 25,
        maxRetries: 3,
        factory: (tools) => new ChatGroq({
            model: "llama-3.1-8b-instant",
            temperature: 0,
            apiKey: process.env.GROQ_API_KEY,
            maxRetries: 0,
        }).bindTools(tools),
    },

    // ── 6. Gemini 2.5 Flash — quota SÉPARÉ du 2.0 Flash
    {
        name: "Gemini 2.5 Flash",
        rpm: 9,
        maxRetries: 3,
        factory: (tools) => new ChatGoogleGenerativeAI({
            model: "gemini-2.5-flash",
            temperature: 0,
            apiKey: process.env.GOOGLE_API_KEY,
            maxRetries: 0,
        }).bindTools(tools),
    },

    // ── 7. Mistral small — 1 milliard de tokens/mois gratuits
    {
        name: "Mistral small",
        rpm: 4,
        maxRetries: 3,
        factory: (tools) => new ChatMistralAI({
            model: "mistral-small-latest",
            temperature: 0,
            apiKey: process.env.MISTRAL_API_KEY,
            maxRetries: 0,
        }).bindTools(tools),
    },

    // ── 8. Gemini gemini-3-flash-preview — DÉSACTIVÉ
    // Ce modèle exige des "thought_signatures" sur les tool_calls
    // provenant d'autres providers → incompatible en chaîne de fallback.
    // Voir : https://ai.google.dev/gemini-api/docs/thought-signatures
];

class MultiProviderLLM {
    // ── État par provider ─────────────────────────────────────────────────────
    // quotaEpuise[i] = true  → quota journalier épuisé, skip définitivement
    // rateLimitedUntil[i]    → timestamp jusqu'auquel ce provider est en cooldown
    //
    // IMPORTANT : ces états persistent entre les requêtes (même instance).
    // currentIndex est recalculé dynamiquement à chaque invoke() pour trouver
    // le premier provider disponible — il ne se bloque plus jamais en fin de liste.
    // ─────────────────────────────────────────────────────────────────────────

    private quotaEpuise      = new Map<number, boolean>();
    private rateLimitedUntil = new Map<number, number>();
    private rateLimiters     = new Map<number, RateLimiter>();
    private instances        = new Map<number, any>();
    private tools: any[];

    constructor(tools: any[]) {
        this.tools = tools;
        PROVIDERS_CHAIN.forEach((p, i) => {
            this.rateLimiters.set(i, new RateLimiter(p.rpm));
            this.quotaEpuise.set(i, false);
            this.rateLimitedUntil.set(i, 0);
        });
    }

    private getInstance(index: number): any {
        if (!this.instances.has(index)) {
            console.log(`Initialisation provider : ${PROVIDERS_CHAIN[index].name}`);
            this.instances.set(index, PROVIDERS_CHAIN[index].factory(this.tools));
        }
        return this.instances.get(index)!;
    }

    // Retourne le premier provider disponible (non épuisé, non en cooldown)
    private premierDisponible(): number {
        const now = Date.now();
        for (let i = 0; i < PROVIDERS_CHAIN.length; i++) {
            if (this.quotaEpuise.get(i)) continue;
            if ((this.rateLimitedUntil.get(i) ?? 0) > now) continue;
            return i;
        }
        return -1; // tous épuisés
    }

    getCurrentProviderName(): string {
        const i = this.premierDisponible();
        return i >= 0 ? PROVIDERS_CHAIN[i].name : "Aucun";
    }

    // Réinitialise les rate limits (pas les quotas épuisés) pour un nouveau jour
    resetRateLimits(): void {
        this.rateLimitedUntil.forEach((_, i) => this.rateLimitedUntil.set(i, 0));
        console.log("Rate limits réinitialisés.");
    }

    async invoke(messages: BaseMessage[]): Promise<any> {
        // Chercher le premier provider disponible — à chaque appel, pas en continu
        let startIndex = this.premierDisponible();

        if (startIndex < 0) {
            throw new Error(
                "Tous les providers LLM ont atteint leur quota journalier. " +
                "Reessaie demain ou active la facturation sur une cle API."
            );
        }

        // Essayer chaque provider disponible dans l'ordre
        for (let i = startIndex; i < PROVIDERS_CHAIN.length; i++) {
            if (this.quotaEpuise.get(i)) continue;

            const now = Date.now();
            const cooldownUntil = this.rateLimitedUntil.get(i) ?? 0;
            if (cooldownUntil > now) {
                const wait = cooldownUntil - now;
                console.log(`⏳ [${PROVIDERS_CHAIN[i].name}] en cooldown, attente ${Math.round(wait/1000)}s...`);
                await sleep(wait);
            }

            const config  = PROVIDERS_CHAIN[i];
            const limiter = this.rateLimiters.get(i)!;
            const llm     = this.getInstance(i);

            for (let attempt = 0; attempt < config.maxRetries; attempt++) {
                try {
                    await limiter.wait();
                    console.log(`[${config.name}] tentative ${attempt + 1}/${config.maxRetries}`);
                    const result = await llm.invoke(messages);
                    // Succès → retirer le cooldown éventuel
                    this.rateLimitedUntil.set(i, 0);
                    return result;
                } catch (error: any) {
                    const kind = classifierErreur(error);
                    console.warn(`[${config.name}] ${kind} : ${String(error?.message).slice(0, 120)}`);

                    switch (kind) {
                        case "QUOTA_EXHAUSTED":
                            // Quota journalier épuisé → marquer définitivement et passer au suivant
                            console.warn(`Quota epuise sur [${config.name}] → skip définitif pour cette session`);
                            this.quotaEpuise.set(i, true);
                            attempt = config.maxRetries;
                            break;

                        case "SKIP_REQUEST":
                            // Erreur de format pour CETTE requête (ex: tool_call sans id, message_order)
                            // → skip ce provider pour cette requête UNIQUEMENT, pas définitivement
                            console.warn(`[${config.name}] format incompatible pour cette requête → skip (provider conservé)`);
                            attempt = config.maxRetries;
                            break;

                        case "RATE_LIMIT": {
                            const match   = error?.message?.match(/retry.*?(\d+(?:\.\d+)?)\s*s/i);
                            const suggest = match ? parseFloat(match[1]) * 1000 : 0;
                            const waitMs  = Math.max(suggest, Math.pow(2, attempt + 1) * 1000);
                            console.warn(`Rate limit - attente ${Math.round(waitMs / 1000)}s...`);
                            // Mémoriser le cooldown pour ne pas réessayer avant ce délai
                            this.rateLimitedUntil.set(i, Date.now() + waitMs);
                            await sleep(waitMs);
                            break;
                        }

                        case "RETRYABLE": {
                            const waitMs = Math.pow(2, attempt + 1) * 1000;
                            console.warn(`Erreur temporaire - attente ${Math.round(waitMs / 1000)}s...`);
                            await sleep(waitMs);
                            break;
                        }

                        case "FATAL":
                            throw error;
                    }
                }
            }

            // Si on sort de la boucle de retries sans succès et sans exception fatale :
            // c'est soit quota épuisé, soit rate limit dépassé → passer au suivant
            if (!this.quotaEpuise.get(i)) {
                console.log(`[${config.name}] retries épuisés → provider suivant`);
            }
            const nextAvail = this.premierDisponible();
            if (nextAvail > i) {
                console.log(`Nouveau provider : ${PROVIDERS_CHAIN[nextAvail].name}`);
            }
        }

        throw new Error(
            "Tous les providers LLM ont atteint leur quota journalier. " +
            "Reessaie demain ou active la facturation sur une cle API."
        );
    }
}

// MIDDLEWARE D'OFFLOAD : INTERCEPTE LES RESULTATS D'OUTILS VOLUMINEUX

async function toolNodeAvecOffload(
    etat: typeof EtatAgent.State,
    toolNode: ToolNode
): Promise<{ messages: BaseMessage[] }> {
    const resultat = await toolNode.invoke(etat);

    const messagesOptimises = resultat.messages.map((msg: BaseMessage) => {
        if (!(msg instanceof ToolMessage)) return msg;
        if (typeof msg.content !== "string") return msg;

        const outilsExclus = ["screenshot_e2b", "obtenir_date", "calculer",
                              "grep_memoire", "lire_lignes", "resume_session",
                              "mettre_a_jour_todo", "lire_todo", "lire_instructions"];
        if (outilsExclus.some(nom => msg.name?.includes(nom))) return msg;

        const contenuOptimise = offloadSiVolumineux(msg.name ?? "tool", msg.content);

        if (contenuOptimise !== msg.content) {
            const ratio = Math.round(
                ((msg.content.length - contenuOptimise.length) / msg.content.length) * 100
            );
            console.log(`Offload FS : ${msg.name} | ${msg.content.length} -> ${contenuOptimise.length} chars (-${ratio}% tokens)`);
        }

        return new ToolMessage({
            content     : contenuOptimise,
            tool_call_id: msg.tool_call_id,
            name        : msg.name,
        });
    });

    return { messages: messagesOptimises };
}

// INITIALISATION GLOBALE

const TOUS_LES_TOOLS = [
    ...outilsDeBase,
    /* ...browserTools, */
    ...e2bTools,
    ...credentialTools,
    ...debugTools,
    ...fsMemoryTools,
];

const multiLLM = new MultiProviderLLM(TOUS_LES_TOOLS);

const llmPourContexte = new ChatGoogleGenerativeAI({
    model: "gemini-2.0-flash",
    temperature: 0,
    apiKey: process.env.GOOGLE_API_KEY,
    maxRetries: 2,
}) as any;

const contextConfig: ContextConfig = {
    maxTokens: 28000,
    compressionThreshold: 0.75,
    summaryInterval: 8,
    keepLastNMessages: 6,
};
export const contextManager = new AdvancedContextManager(contextConfig, llmPourContexte);

const memoireConversation = new InMemoryChatMessageHistory();

// MEMOIRE EVOLUTIVE

function chargerInstructionsMemoire(): string {
    try {
        if (!fs.existsSync(INSTRUCTIONS_FILE)) return "";
        const contenu = fs.readFileSync(INSTRUCTIONS_FILE, "utf-8").trim();
        if (contenu.length < 80) return "";
        console.log(`Instructions memorisees chargees (${contenu.length} chars)`);
        return "\n\n[INSTRUCTIONS MEMORISEES DES SESSIONS PRECEDENTES]\n" + contenu;
    } catch {
        return "";
    }
}

// SYSTEM PROMPT
// Règle KV cache : préfixe STABLE identique à chaque appel → pleinement caché.
// Contenu dynamique (instructions apprises) injecté À LA FIN uniquement.

const SYSTEME_PROMPT_BASE = `Tu es un expert IA autonome. Tu disposes des outils suivants pour interagir avec le monde exterieur. Reponds toujours en francais.

OUTILS DISPONIBLES :

Navigation (E2B Sandbox) :
  - demarrer_sandbox, aller_vers_e2b, cliquer_e2b, taper_e2b
  - lire_page_e2b, screenshot_e2b, attendre_e2b, cocher_case_e2b, scroller_e2b

Fichiers de base :
  - calculer, lire_fichier, ecrire_fichier, lister_fichiers, obtenir_date

Credentials :
  - sauvegarder_credential, lire_credential, generate_mot_de_passe

Debug :
  - diagnostic_navigateur, tester_selecteur

FS-Memory (PRIORITAIRE pour les grands resultats) :
  - grep_memoire       : chercher un mot dans un fichier sauvegarde
  - lire_lignes        : lire des lignes precises d'un fichier
  - rechercher_glob    : lister les fichiers par pattern
  - ecrire_decouverte  : sauvegarder une info importante trouvee
  - ecrire_plan        : sauvegarder un plan avant une tache complexe
  - mettre_a_jour_todo : mettre a jour la todo-list de la tache en cours
  - lire_todo          : lire la todo-list courante
  - apprendre_instruction : memoriser une instruction de l'utilisateur
  - lire_instructions  : charger les instructions des sessions precedentes
  - resume_session     : voir tous les fichiers crees dans la session

REGLE FONDAMENTALE - GESTION DU CONTEXTE :
Quand un outil retourne un resultat volumineux (page HTML, longue liste), il est
AUTOMATIQUEMENT sauvegarde dans ./agent-memory/tool-results/ et tu recois un message
court avec le chemin. Utilise grep_memoire ou lire_lignes pour extraire
UNIQUEMENT les informations dont tu as besoin.

REGLES D'OR :
1. TOUTE tache complexe commence par mettre_a_jour_todo (plan initial).
2. Apres CHAQUE etape terminee, appelle mettre_a_jour_todo pour cocher l'etape.
   Cela recite tes objectifs en fin de contexte et evite la derive.
3. Quand tu trouves une info importante (selecteur CSS, URL), utilise ecrire_decouverte.
4. Apres une creation de compte, sauvegarde les identifiants avec sauvegarder_credential.
5. Si tu rencontres une erreur, NOTE-LA dans le todo (champ note de l'etape).
   Ne cache jamais une erreur — elle met a jour tes croyances et evite la repetition.
6. Si l'utilisateur te donne un conseil, utilise apprendre_instruction.
7. Prends un screenshot avant/apres chaque action cle.
8. Utilise attendre_e2b pour laisser le temps aux elements d'apparaitre.

SELECTEURS COURANTS :
- Google : 'input[name="q"]', 'textarea[name="q"]'
- Formulaires : privilegier les selecteurs par texte (ex: button:has-text('Se connecter'))`;

function construireSystemePrompt(): string {
    return SYSTEME_PROMPT_BASE + chargerInstructionsMemoire();
}


// ─────────────────────────────────────────────────────────────────────────────
// SANITISATION DES MESSAGES POUR PROVIDERS STRICTS (Mistral)
//
// Mistral exige :
//   1. Chaque ToolMessage a un tool_call_id valide avec AIMessage parent
//   2. Dernier message = Human ou Tool (jamais AI)
// ─────────────────────────────────────────────────────────────────────────────

function sanitiserMessages(messages: BaseMessage[]): BaseMessage[] {


    // ── Passe 0 : garantir que tous les tool_calls ont un id ──
    // Groq/OpenAI exigent un "id" sur chaque tool_call.
    // Gemini peut générer des tool_calls sans id → on en assigne un.
    const pass0: BaseMessage[] = messages.map(msg => {
        if (!(msg instanceof AIMessage)) return msg;
        const toolCalls = msg.tool_calls ?? [];
        const needsFix  = toolCalls.some(tc => !tc.id);
        if (!needsFix) return msg;
        const fixedToolCalls = toolCalls.map(tc => {
            if (tc.id) return tc;
            const newId = Math.random().toString(36).slice(2, 11);
            console.warn(`⚠️  Sanitise Passe 0 : tool_call sans id (${tc.name}) → id généré: ${newId}`);
            return { ...tc, id: newId };
        });
        return new AIMessage({
            content: msg.content,
            tool_calls: fixedToolCalls,
            additional_kwargs: msg.additional_kwargs,
        });
    });

    // ── Passe 1 : ToolMessages orphelins ──
    const pass1: BaseMessage[] = [];
    for (const msg of pass0) {
        if (msg instanceof ToolMessage) {
            const prev = pass1.at(-1);
            const hasParent = prev instanceof AIMessage && (
                (prev.tool_calls?.length ?? 0) > 0 ||
                ((prev.additional_kwargs?.tool_calls as any[])?.length ?? 0) > 0
            );
            if (!hasParent || !msg.tool_call_id) {
                console.warn(`⚠️  Sanitise : ToolMessage orphelin ignoré (id: ${msg.tool_call_id ?? "undefined"})`);
                continue;
            }
        }
        pass1.push(msg);
    }

    // ── Passe 2 : AIMessages avec tool_calls sans ToolMessage suivant ──
    const pass2: BaseMessage[] = [];
    for (let i = 0; i < pass1.length; i++) {
        const msg  = pass1[i];
        const next = pass1[i + 1];
        const isAIWithTools = msg instanceof AIMessage && (
            (msg.tool_calls?.length ?? 0) > 0 ||
            ((msg.additional_kwargs?.tool_calls as any[])?.length ?? 0) > 0
        );
        if (isAIWithTools && !(next instanceof ToolMessage)) {
            console.warn(`⚠️  Sanitise : AIMessage avec tool_calls sans ToolMessage suivant ignoré`);
            continue;
        }
        pass2.push(msg);
    }

    // ── Passe 3 : retirer les AIMessages terminaux avec tool_calls ──
    const result = [...pass2];
    while (result.length > 0) {
        const last = result.at(-1)!;
        const isTrailingToolAI = last instanceof AIMessage && (
            (last.tool_calls?.length ?? 0) > 0 ||
            ((last.additional_kwargs?.tool_calls as any[])?.length ?? 0) > 0
        );
        if (isTrailingToolAI) {
            console.warn(`⚠️  Sanitise : AIMessage terminal avec tool_calls supprimé`);
            result.pop();
        } else {
            break;
        }
    }

    // ── Passe 4 : Mistral refuse si le DERNIER message est un AIMessage (même sans tool_calls)
    // Après suppression des orphelins, le contexte peut se terminer sur un AIMessage.
    // On ajoute un HumanMessage invisible pour satisfaire la contrainte de rôle.
    const last = result.at(-1);
    if (last instanceof AIMessage) {
        const lastText = String(last.content ?? "").trim();
        if (!lastText) {
            // AIMessage vide en fin → le retirer directement
            result.pop();
            console.warn(`⚠️  Sanitise : AIMessage vide terminal supprimé`);
        } else {
            // AIMessage avec contenu → ajouter un Human "relance"
            result.push(new HumanMessage(
                "[RELANCE SYSTÈME] Reprends la tâche là où tu t'es arrêté."
            ));
            console.warn(`⚠️  Sanitise : HumanMessage de relance ajouté (contexte terminait sur AIMessage)`);
        }
    }

    return result;
}

// GRAPHE LANGGRAPH

const EtatAgent = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (ancien, nouveau) => [...ancien, ...nouveau],
        default: () => [],
    }),
});

const toolNodeBase = new ToolNode(TOUS_LES_TOOLS);

async function noeudLLM(etat: typeof EtatAgent.State) {
    console.log(`noeudLLM - ${etat.messages.length} msgs | Provider : ${multiLLM.getCurrentProviderName()}`);

    const dernier = etat.messages.at(-1);
    if (dernier instanceof ToolMessage) {
        console.log("ToolMessage recu:", String(dernier.content).slice(0, 150));
    }

    try {
        const SYSTEME_PROMPT = construireSystemePrompt();
        const optimizedContext = await contextManager.getOptimizedContext(SYSTEME_PROMPT);
        const allMessages      = [...optimizedContext, ...etat.messages];

        const stats = contextManager.getContextStats();
        console.log(
            `Contexte : ${stats.totalMessages} msgs | ` +
            `${stats.currentTokens} tokens | ` +
            `compression : ${((1 - stats.compressionRatio) * 100).toFixed(0)}%`
        );

        const messagesSanitises = sanitiserMessages(allMessages);
        const reponse = await multiLLM.invoke(messagesSanitises);
        console.log("Reponse LLM recue.");

        // Détection réponse vide : pas de texte ET pas de tool calls
        // Cause : Gemini 2.5 Flash peut retourner un message vide si le contexte
        // contient des messages d'une session précédente qui le perturbent.
        // Solution : relancer avec un message de nudge qui force l'action.
        const texte = String(reponse.content ?? "").trim();
        const aDesTools =
            (reponse.tool_calls?.length > 0) ||
            (reponse.additional_kwargs?.tool_calls?.length > 0);

        if (!texte && !aDesTools) {
            console.warn("⚠️  Réponse vide détectée — relance avec nudge...");
            const messagesAvecNudge = [
                ...allMessages,
                reponse,
                new HumanMessage(
                    "Ta réponse était vide. Rappel : tu dois OBLIGATOIREMENT utiliser " +
                    "les outils disponibles pour répondre à la demande. " +
                    "Commence maintenant par l'action la plus logique."
                ),
            ];
            const reponseNudge = await multiLLM.invoke(messagesAvecNudge);
            console.log("Réponse après nudge reçue.");
            return { messages: [reponseNudge] };
        }

        return { messages: [reponse] };

    } catch (error: any) {
        console.error("Erreur definitive noeudLLM:", error?.message);
        // PRINCIPE MANUS : garder les erreurs dans le contexte.
        const isQuotaEpuise = error?.message?.includes("Tous les providers");
        const messageErreur = isQuotaEpuise
            ? "ERREUR QUOTA : Tous les providers LLM sont epuises. Attendre demain."
            : `ERREUR TECHNIQUE [${error?.constructor?.name ?? "Error"}]: ${error?.message ?? "inconnue"}\n` +
              `Stack: ${(error?.stack ?? "").split("\n").slice(0, 3).join(" | ")}`;
        return { messages: [new AIMessage(messageErreur)] };
    }
}

async function noeudOutils(etat: typeof EtatAgent.State) {
    return await toolNodeAvecOffload(etat, toolNodeBase);
}

function decider(etat: typeof EtatAgent.State): string {
    const dernierMessage = etat.messages.at(-1);

    const hasToolCalls =
        (dernierMessage?.tool_calls && dernierMessage.tool_calls.length > 0) ||
        (dernierMessage?.additional_kwargs?.tool_calls &&
            (dernierMessage.additional_kwargs.tool_calls as any[]).length > 0) ||
        ((dernierMessage as any)?.kwargs?.tool_calls &&
            (dernierMessage as any).kwargs.tool_calls.length > 0);

    if (hasToolCalls) { console.log("decider -> tools"); return "tools"; }

    const texte = String(dernierMessage?.content ?? "").trim();
    if (!texte) {
        console.warn("⚠️  decider -> END (réponse vide, nudge non résolu)");
    } else {
        console.log("decider -> END");
    }
    return END;
}

const graphe = new StateGraph(EtatAgent)
    .addNode("llm", noeudLLM)
    .addNode("tools", noeudOutils)
    .addEdge(START, "llm")
    .addConditionalEdges("llm", decider)
    .addEdge("tools", "llm")
    .compile();

// API PUBLIQUE

export interface AgentResponse {
    text: string;
    screenshot?: string;
}

export async function traiterMessage(messageUtilisateur: string): Promise<AgentResponse> {
    try {
        const messageEntrant = new HumanMessage(messageUtilisateur);
        await contextManager.addMessage(messageEntrant);

        const resultat = await graphe.invoke(
            { messages: [messageEntrant] },
            { recursionLimit: 100 }
        );

        let screenshotData: string | undefined;
        for (const msg of resultat.messages) {
            if (
                msg instanceof ToolMessage &&
                typeof msg.content === "string" &&
                msg.content.startsWith("data:image")
            ) {
                screenshotData = msg.content;
            }
        }

        const reponseFinale = resultat.messages.at(-1);
        let contenu = String(reponseFinale?.content ?? "Pas de reponse.");
        if (!contenu.trim()) contenu = "[L'agent n'a pas genere de reponse textuelle.]";

        await contextManager.addMessage(new AIMessage(contenu));
        return { text: contenu, screenshot: screenshotData };

    } catch (error) {
        console.error("Erreur dans traiterMessage:", error);
        const fallback = "Desole, une erreur interne est survenue.";
        await contextManager.addMessage(new AIMessage(fallback));
        return { text: fallback };
    }
}

// INTERFACE CLI

async function demarrerInterface() {
    console.log("\n" + "=".repeat(65));
    console.log(" AGENT IA AUTONOME - LangChain + LangGraph + FS-Memory ");
    console.log("=".repeat(65));
    console.log("Providers (fallback automatique) :");
    PROVIDERS_CHAIN.forEach((p, i) =>
        console.log(`  ${i + 1}. ${p.name.padEnd(26)} ${p.rpm} req/min`)
    );
    console.log("FS-Memory : ./agent-memory/ (offload auto des gros resultats)");
    console.log("-".repeat(65));
    console.log("  'exit' -> Quitter | 'reset' -> Memoire | 'tools' -> Liste");
    console.log("=".repeat(65) + "\n");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const LireQuestion = () => {
        rl.question(`Tu [${multiLLM.getCurrentProviderName()}] : `, async (input) => {
            const msg = input.trim();
            if (!msg) { LireQuestion(); return; }

            if (msg.toLowerCase() === "exit") {
                console.log("\n Fermeture...");
                await navigateur.fermer();
                await e2bSandbox.fermer();
                rl.close();
                process.exit(0);
            }
            if (msg.toLowerCase() === "reset") {
                await memoireConversation.clear();
                console.log(" Memoire effacee.\n");
                LireQuestion(); return;
            }
            if (msg.toLowerCase() === "tools") {
                console.log("\n Tools disponibles :");
                TOUS_LES_TOOLS.forEach(t =>
                    console.log(`  - ${t.name}: ${t.description.slice(0, 70)}...`)
                );
                console.log();
                LireQuestion(); return;
            }

            console.log(`\n Agent reflechit... [${multiLLM.getCurrentProviderName()}]\n`);
            try {
                const response = await traiterMessage(msg);
                console.log(`\n Agent : ${response.text}\n`);
                console.log("-".repeat(65) + "\n");
            } catch (error) {
                console.error(`Erreur : ${(error as Error).message}\n`);
            }
            LireQuestion();
        });
    };

    LireQuestion();
}

if (require.main === module) {
    demarrerInterface().catch(err => console.error("Erreur interface console:", err));
}