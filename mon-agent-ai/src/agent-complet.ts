import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";   // ← Cerebras via wrapper OpenAI-compatible
import { ChatCohere } from "@langchain/cohere";
import { ChatOllama } from "@langchain/ollama";
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
    | "SKIP"     // erreur de format pour CETTE requête → skip mais provider réutilisable
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

    // 413 = contexte trop grand pour CE modèle → skip immédiat, 0 retry
    // DOIT être avant RATE_LIMIT (sinon le 429 capte tout)
    if (status === 413 || msg.includes("request too large") || msg.includes("too large for model")) {
        return "QUOTA_EXHAUSTED";
    }

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

    // Mistral SDK : retente les 429 en interne jusqu'à 5x puis throw "Max retries reached"
    // Le maxRetries:0 de ChatMistralAI n'est pas respecté par le SDK natif @mistralai/mistralai
    // → classifier comme RATE_LIMIT pour mettre le provider en cooldown au lieu de crasher
    if (msg.includes("max retries reached") || msg.includes("max retries exceeded")) {
        return "RATE_LIMIT";
    }

    // 404 = modèle introuvable → passer au suivant
    if (status === 404 || msg.includes("model_not_found") || msg.includes("no body")) {
        return "QUOTA_EXHAUSTED";
    }

    // 413 → géré en premier dans le classifier
    // Cohere : "Missing required key type" = incompatibilité de schema → passer au suivant
    if (msg.includes("missing required key") || msg.includes("parameterdefinitions")) {
        return "QUOTA_EXHAUSTED";
    }

    // Mistral / OpenAI : erreurs de FORMAT de message → SKIP (provider réutilisable)
    if (
        msg.includes("tool call id has to be defined") ||
        msg.includes("expected last role") ||
        msg.includes("message_order") ||
        msg.includes("invalid_request_message") ||
        msg.includes("all openai tool calls must have an") ||
        msg.includes("\"id\" field") ||
        // Mistral : nombre de tool_calls ≠ nombre de ToolMessages dans le contexte
        msg.includes("not the same number of function calls") ||
        // Mistral rejette un AIMessage avec content="" ET sans tool_calls
        // Se produit quand un provider renvoie une réponse vide et qu'on la passe en contexte
        msg.includes("assistant message must have either content or tool_calls")
    ) {
        return "SKIP";
    }

    // Gemini thinking : thought_signature manquant → skip cette requête
    if (msg.includes("thought_signature") || msg.includes("missing a thought")) {
        return "SKIP";
    }

    return "FATAL";
}

// RATE LIMITER

class RateLimiter {
    private lastCallTime = 0;
    private readonly minDelay: number;

    constructor(requestsPerMinute: number) {
        // Facteur 1.2 de sécurité pour absorber les jitters réseau
        this.minDelay = Math.ceil((60 / requestsPerMinute) * 1000 * 1.2);
    }

    async wait(): Promise<void> {
        console.log(`🕒 Rate limiter check (minDelay=${this.minDelay}ms)`);
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


interface ProviderConfig {
    name: string;
    rpm: number;
    maxRetries: number;
    factory: (tools: any[]) => any;
}

/**
 * Chaîne de fallback — ordre optimisé par quota/jour puis qualité.
 *
 * STRATÉGIE : illimités en tête, quotas limités en dernier recours.
 *
 * ┌──────────────────────────────┬──────┬──────────────┬─────────────────────┐
 * │ Provider / Modèle            │ RPM  │ Req/jour     │ Notes               │
 * ├──────────────────────────────┼──────┼──────────────┼─────────────────────┤
 * │ Cerebras gpt-oss-120b        │  30  │   14 400     │ Principal — 120B    │
 * │ Cerebras llama3.1-8b         │  30  │   14 400 *   │ Quota séparé        │
 * │ Mistral small                │   4  │  ILLIMITÉ    │ Via OpenAI endpoint │
 * │ Groq llama-3.3-70b           │  20  │   14 400     │ Fallback capable    │
 * │ Groq llama-3.1-8b            │  20  │   14 400 *   │ Quota séparé        │
 * │ Gemini 2.0 Flash             │  15  │    1 500     │ Précieux, last res. │
 * │ Gemini 2.5 Flash             │   9  │      500 *   │ Quota séparé        │
 * │ Cohere command-r             │  20  │    1 000     │ Skip auto (schema)  │
 * └──────────────────────────────┴──────┴──────────────┴─────────────────────┘
 */
const PROVIDERS_CHAIN: ProviderConfig[] = [

    // ── 1. Ollama (auto-hébergé sur Railway) ──────────────────────────
    {
        name: "Ollama Llama3.2 (Railway)",
        rpm: 100, // valeur haute, pas de limite réelle
        maxRetries: 2,
        factory: (tools) => new ChatOllama({
        baseUrl: process.env.OLLAMA_PUBLIC_URL,   // l'URL que vous avez notée
        model: "llama3.2:3b",                     // le modèle que vous avez téléchargé
        temperature: 0,
        }).bindTools(tools),
    },

    // ── 1. Cerebras gpt-oss-120b — ILLIMITÉ, 30 RPM, 120B params
    {
        name: "Cerebras gpt-oss-120b",
        rpm: 28,  // légèrement sous les 30 officiels pour absorber les jitters
        maxRetries: 3,
        factory: (tools) => new ChatOpenAI({
            model: "gpt-oss-120b",
            temperature: 0,
            apiKey: process.env.CEREBRAS_API_KEY,
            configuration: { baseURL: "https://api.cerebras.ai/v1" },
            maxRetries: 0,
        }).bindTools(tools, { strict: false }),
    },

    // ── 2. Cerebras llama3.1-8b — quota SÉPARÉ du 120b, très rapide
    {
        name: "Cerebras llama3.1-8b",
        rpm: 28,
        maxRetries: 3,
        factory: (tools) => new ChatOpenAI({
            model: "llama3.1-8b",
            temperature: 0,
            apiKey: process.env.CEREBRAS_API_KEY,
            configuration: { baseURL: "https://api.cerebras.ai/v1" },
            maxRetries: 0,
        }).bindTools(tools, { strict: false }),
    },

    // ── 3. Mistral small — ILLIMITÉ (1 Md tokens/mois), 4 RPM
    //       VIA endpoint OpenAI-compatible (pas le SDK @mistralai/mistralai)
    //       Le SDK natif ignorait maxRetries:0 et faisait 5 retries HTTP cachés.
    //       ChatOpenAI + baseURL custom = contrôle total, maxRetries:0 respecté.
    {
        name: "Mistral small",
        rpm: 4,
        maxRetries: 1,
        factory: (tools) => new ChatOpenAI({
            model: "mistral-small-latest",
            temperature: 0,
            apiKey: process.env.MISTRAL_API_KEY,
            configuration: { baseURL: "https://api.mistral.ai/v1" },
            maxRetries: 0,  // respecté car ChatOpenAI, pas @mistralai/mistralai
        }).bindTools(tools, { strict: false }),
    },

    // ── 3. Groq llama-3.3-70b — 14 400 req/jour, très capable, 30 RPM réels
    {
        name: "Groq llama-3.3-70b",
        rpm: 20,   // conservateur : 30 RPM officiel mais on partage avec llama-3.1-8b
        maxRetries: 2,
        factory: (tools) => new ChatGroq({
            model: "llama-3.3-70b-versatile",
            temperature: 0,
            apiKey: process.env.GROQ_API_KEY,
            maxRetries: 0,
        }).bindTools(tools),
    },

    // ── 4. Groq llama-3.1-8b — quota SÉPARÉ du 3.3-70b
    {
        name: "Groq llama-3.1-8b",
        rpm: 20,
        maxRetries: 2,
        factory: (tools) => new ChatGroq({
            model: "llama-3.1-8b-instant",
            temperature: 0,
            apiKey: process.env.GROQ_API_KEY,
            maxRetries: 0,
        }).bindTools(tools),
    },

    // ── 5. Gemini 2.0 Flash — 1 500 req/jour, meilleur pour l'agentic
    //       Quota PRÉCIEUX → réservé en dernier recours
    {
        name: "Gemini 2.0 Flash",
        rpm: 15,   // 15 RPM officiels niveau free
        maxRetries: 3,
        factory: (tools) => new ChatGoogleGenerativeAI({
            model: "gemini-2.0-flash",
            temperature: 0,
            apiKey: process.env.GOOGLE_API_KEY,
            maxRetries: 0,
        }).bindTools(tools),
    },

    // ── 6. Gemini 2.5 Flash — 500 req/jour, quota SÉPARÉ du 2.0
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

    // ── 7. Cohere command-r — sera skipé auto (incompatibilité schema tools)
    //       Gardé comme dernier filet
    {
        name: "Cohere command-r",
        rpm: 20,
        maxRetries: 2,
        factory: (tools) => new ChatCohere({
            model: "command-r",
            temperature: 0,
            apiKey: process.env.COHERE_API_KEY,
            maxRetries: 0,
        }).bindTools(tools, { strict: false }),
    },

    // gemini-3-flash-preview DÉSACTIVÉ : exige thought_signatures incompatibles
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
                            console.warn(`Quota epuise sur [${config.name}] → skip définitif pour cette session`);
                            console.warn(`  Détail erreur : status=${error?.status ?? '?'} | ${String(error?.message).slice(0, 200)}`);
                            this.quotaEpuise.set(i, true);
                            attempt = config.maxRetries;
                            break;

                        case "SKIP":
                            // Erreur de format pour CETTE requête
                            console.warn(`[${config.name}] format incompatible pour cette requête → skip (provider conservé)`);
                            attempt = config.maxRetries;
                            break;

                        case "RATE_LIMIT": {
                            // Extraire le délai suggéré par l'API (ex: "retry after 30s")
                            const match    = error?.message?.match(/retry[^0-9]*(\d+(?:\.\d+)?)\s*s/i);
                            const suggest  = match ? parseFloat(match[1]) * 1000 : 0;
                            // Cooldown minimum basé sur le rpm du provider :
                            // Si rpm=4 → 1 call / 15s. Après un 429, attendre au moins 1 fenêtre complète.
                            const rpmCooldown = Math.ceil((60 / config.rpm) * 1000 * 3); // 3× la fenêtre RPM
                            // Exponentiel classique mais avec un floor raisonnable
                            const expBackoff  = Math.pow(2, attempt + 2) * 1000; // 4s, 8s, 16s...
                            const waitMs      = Math.max(suggest, rpmCooldown, expBackoff);
                            console.warn(`Rate limit - attente ${Math.round(waitMs / 1000)}s... (rpm=${config.rpm}, suggest=${Math.round(suggest/1000)}s)`);
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

        let nbEpuises = 0;
        this.quotaEpuise.forEach(v => { if (v) nbEpuises++; });
        if (nbEpuises >= PROVIDERS_CHAIN.length) {
            throw new Error(
                "Tous les providers LLM ont atteint leur quota journalier. " +
                "Reessaie demain ou active la facturation sur une cle API."
            );
        }
        // Certains ont SKIPpé → contexte cassé mais providers disponibles
        throw new Error("CONTEXT_INCOMPATIBLE");
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
  - appuyer_touche_e2b     : appuie sur Enter/Tab/Escape pour valider un formulaire
  - selectionner_option_e2b : choisit une option dans un menu deroulant <select>
  - evaluer_js_e2b          : execute du JavaScript sur la page (lecture/ecriture DOM)

Fichiers de base :
  - calculer, lire_fichier, ecrire_fichier, lister_fichiers, obtenir_date

Credentials :
  - sauvegarder_credential, lire_credential, generate_mot_de_passe

Debug :
  - diagnostic_navigateur, tester_selecteur

FS-Memory (PRIORITAIRE pour les grands resultats) :
  - grep_memoire, lire_lignes, rechercher_glob, ecrire_decouverte
  - ecrire_plan, mettre_a_jour_todo, lire_todo
  - apprendre_instruction, lire_instructions, resume_session

REGLE FONDAMENTALE - GESTION DU CONTEXTE :
Quand un outil retourne un resultat volumineux (page HTML, longue liste), il est
AUTOMATIQUEMENT sauvegarde dans ./agent-memory/tool-results/ et tu recois un message
court avec le chemin. Utilise grep_memoire ou lire_lignes pour extraire
UNIQUEMENT les informations dont tu as besoin.

WORKFLOW CREATION DE COMPTE (a suivre dans CET ORDRE) :
1. generate_mot_de_passe
2. demarrer_sandbox si pas encore fait
3. aller_vers_e2b vers la page d'inscription
4. screenshot_e2b pour voir la page
5. OBLIGATOIRE : appelle lire_page_e2b AVEC format="html" pour obtenir le code HTML complet.
   - Si le résultat est trop volumineux, il sera sauvegardé et tu recevras un chemin.
   - Utilise immédiatement grep_memoire ou evaluer_js_e2b pour extraire les sélecteurs.
   - NE PAS continuer sans avoir analysé la structure de la page.
6. SI grep_memoire ne trouve rien, utilise evaluer_js_e2b avec le script suivant :
   Array.from(document.querySelectorAll('input, select, textarea, button'))
       .map(el => ({ tag: el.tagName, name: el.name, id: el.id, type: el.type }))
7. Cocher les cases : cocher_case_e2b
8. Menus deroulants : selectionner_option_e2b
9. Valider : cliquer_e2b sur le bouton OU appuyer_touche_e2b "Enter"
10. attendre_e2b (ms: 2000) apres soumission
11. screenshot_e2b pour verifier succes ou message d'erreur
12. sauvegarder_credential avec email + mot de passe + site

REGLES D'OR :
1. TOUTE tache complexe commence par mettre_a_jour_todo (plan initial).
2. Apres CHAQUE etape terminee, coche-la dans mettre_a_jour_todo.
3. Quand tu trouves un selecteur CSS valide, sauvegarde-le avec ecrire_decouverte.
4. Apres une creation de compte, sauvegarde TOUJOURS les identifiants avec sauvegarder_credential.
5. Si un selecteur echoue, essaie dans l'ordre :
   a. lire_page_e2b (html) pour voir la structure reelle
   b. evaluer_js_e2b pour lister les inputs : Array.from(document.querySelectorAll('input')).map(e=>e.name+':'+e.id)
   c. tester_selecteur pour verifier qu'un element existe
6. Si l'utilisateur te donne un conseil, utilise apprendre_instruction.
7. SCREENSHOT OBLIGATOIRE apres chaque navigation, clic et saisie.
   NE JAMAIS repondre "j'ai effectue l'action" sans screenshot_e2b juste avant.
8. Utilise attendre_e2b (ms: 1500) apres chaque soumission de formulaire.

SELECTEURS COURANTS :
- Email    : input[type="email"], input[name="email"], #email
- Password : input[type="password"], input[name="password"], #password
- Prenom   : input[name="first_name"], input[name="name"], #name
- Submit   : button[type="submit"], input[type="submit"]
- Google   : input[name="q"], textarea[name="q"]`;

function construireSystemePrompt(): string {
    return SYSTEME_PROMPT_BASE + chargerInstructionsMemoire();
}


// ─────────────────────────────────────────────────────────────────────────────
// SANITISATION DES MESSAGES POUR PROVIDERS STRICTS (Mistral)
//
// Mistral exige :
//   1. Pour chaque tool_call dans un AIMessage, UN ToolMessage correspondant
//   2. Pas d'AIMessage entre les ToolMessages d'un même AIMessage
//   3. Dernier message = HumanMessage ou ToolMessage (jamais AIMessage)
//
// Architecture : traitement PAR PAIRES ATOMIQUES (AIMessage + ses ToolMessages)
//   → élimine la cascade d'orphelins des anciennes passes séquentielles P0→P4
// ─────────────────────────────────────────────────────────────────────────────

/** Extrait tous les tool_calls d'un AIMessage (LangChain + additional_kwargs) */
function extraireToolCalls(msg: AIMessage): Array<{ id: string; name: string; args: any }> {
    // Source 1 : msg.tool_calls (format LangChain canonique)
    const lcCalls = (msg.tool_calls ?? []).filter((tc: any) => !!tc.id);

    if (lcCalls.length > 0) {
        return lcCalls.map((tc: any) => ({
            id  : tc.id as string,
            name: tc.name,
            args: tc.args,
        }));
    }

    // Source 2 : additional_kwargs.tool_calls (format brut provider)
    const akCalls = (msg.additional_kwargs?.tool_calls as any[]) ?? [];
    return akCalls
        .filter((tc: any) => !!tc.id)
        .map((tc: any) => ({
            id  : tc.id as string,
            name: tc.function?.name ?? tc.name ?? "unknown",
            args: (() => {
                try { return JSON.parse(tc.function?.arguments ?? tc.arguments ?? "{}"); }
                catch { return {}; }
            })(),
        }));
}

/** Reconstruit un AIMessage normalisé (additional_kwargs en format OpenAI standard) */
function normaliserAIMessage(msg: AIMessage, toolCalls: Array<{ id: string; name: string; args: any }>): AIMessage {
    const akNormalisé = toolCalls.map(tc => ({
        id      : tc.id,
        type    : "function" as const,
        function: {
            name     : tc.name,
            arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
        },
    }));
    const lcCalls = toolCalls.map(tc => ({
        id  : tc.id,
        name: tc.name,
        args: tc.args,
        type: "tool_call" as const,
    }));
    return new AIMessage({
        content          : msg.content,
        tool_calls       : lcCalls,
        additional_kwargs: { ...msg.additional_kwargs, tool_calls: akNormalisé },
    });
}

function sanitiserMessages(messages: BaseMessage[]): BaseMessage[] {

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1 : Traitement atomique — parcours linéaire, message par message.
    //
    // Règle fondamentale : un AIMessage avec tool_calls doit être suivi de
    // EXACTEMENT N ToolMessages, un par tool_call_id (pas moins, pas plus).
    //
    // Chaque (AIMessage + ToolMessages[]) est traité comme une UNITÉ ATOMIQUE :
    //   - Si la paire est incomplète ou incohérente → TOUTE l'unité est rejetée
    //   - Si la paire est complète → normalisée et conservée
    //
    // Les ToolMessages sans parent AIMessage-avec-tools (orphelins) sont supprimés.
    // ═══════════════════════════════════════════════════════════════════════

    const resultat: BaseMessage[] = [];
    let i = 0;

    while (i < messages.length) {
        const msg = messages[i];

        // ── Cas 1 : AIMessage ───────────────────────────────────────────────
        if (msg instanceof AIMessage) {
            const toolCalls = extraireToolCalls(msg);
            const content   = String(msg.content ?? "").trim();

            // 1a. AIMessage vide (ni texte ni tools) → supprimer
            if (!content && toolCalls.length === 0) {
                console.warn(`⚠️  Sanitise : AIMessage vide supprimé`);
                i++;
                continue;
            }

            // 1b. AIMessage sans tool_calls → garder tel quel
            if (toolCalls.length === 0) {
                resultat.push(msg);
                i++;
                continue;
            }

            // 1c. AIMessage avec tool_calls → collecter les ToolMessages suivants
            const toolMsgsSuivants: ToolMessage[] = [];
            let j = i + 1;
            while (j < messages.length && messages[j] instanceof ToolMessage) {
                toolMsgsSuivants.push(messages[j] as ToolMessage);
                j++;
            }

            // Vérifier que chaque tool_call_id est couvert par exactement un ToolMessage
            const idsAttendus  = new Set(toolCalls.map(tc => tc.id));
            const idsReçus     = new Set(toolMsgsSuivants.map(tm => tm.tool_call_id).filter(Boolean));
            const paireValide  =
                idsAttendus.size === idsReçus.size &&
                idsAttendus.size > 0 &&
                [...idsAttendus].every(id => idsReçus.has(id));

            if (paireValide) {
                // Normaliser l'AIMessage et garder les ToolMessages correspondants
                resultat.push(normaliserAIMessage(msg, toolCalls));
                // Garder uniquement les ToolMessages dans l'ordre des tool_calls
                for (const tc of toolCalls) {
                    const tm = toolMsgsSuivants.find(t => t.tool_call_id === tc.id)!;
                    resultat.push(tm);
                }
                i = j;
            } else {
                // Paire incomplète ou incohérente → rejeter toute l'unité atomique
                console.warn(
                    `⚠️  Sanitise : Paire rejetée — ${idsAttendus.size} tool_call(s) ` +
                    `attendu(s), ${idsReçus.size} ToolMessage(s) reçu(s). ` +
                    `Ids attendus: [${[...idsAttendus].join(", ")}]`
                );
                i = j; // sauter aussi les ToolMessages suivants
            }
            continue;
        }

        // ── Cas 2 : ToolMessage non précédé d'un AIMessage-avec-tools (orphelin) ──
        if (msg instanceof ToolMessage) {
            // Vérifier si le dernier message dans resultat est bien son parent
            const prev = resultat.at(-1);
            const prevEstParent = prev instanceof AIMessage && (
                (prev.tool_calls?.some((tc: any) => tc.id === msg.tool_call_id)) ||
                ((prev.additional_kwargs?.tool_calls as any[])?.some(
                    (tc: any) => tc.id === msg.tool_call_id
                ))
            );
            if (!prevEstParent) {
                // Ce ToolMessage a été produit hors de notre parcours → orphelin résiduel
                // (peut arriver si des messages du contextManager se mélangent à etat.messages)
                console.warn(`⚠️  Sanitise P1 : ToolMessage orphelin ignoré (id: ${msg.tool_call_id ?? "undefined"})`);
                i++;
                continue;
            }
            // Normalement les ToolMessages sont ajoutés dans le Cas 1c, pas ici
            // Si on arrive ici c'est un cas rare → garder par prudence
            resultat.push(msg);
            i++;
            continue;
        }

        // ── Cas 3 : HumanMessage ou autre → garder tel quel ─────────────────
        resultat.push(msg);
        i++;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2 : Contraintes de format pour Mistral (dernier message)
    // ═══════════════════════════════════════════════════════════════════════

    // Supprimer les AIMessages terminaux avec tool_calls (aucune réponse d'outil)
    while (resultat.length > 0) {
        const last = resultat.at(-1)!;
        if (last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0) {
            console.warn(`⚠️  Sanitise : AIMessage terminal avec tool_calls supprimé`);
            resultat.pop();
        } else {
            break;
        }
    }

    // Mistral refuse si le dernier message est un AIMessage (sans tool_calls)
    const dernierMsg = resultat.at(-1);
    if (dernierMsg instanceof AIMessage) {
        const txt = String(dernierMsg.content ?? "").trim();
        if (!txt) {
            resultat.pop();
            console.warn(`⚠️  Sanitise : AIMessage vide terminal supprimé`);
        } else {
            resultat.push(new HumanMessage("[RELANCE SYSTÈME] Reprends la tâche là où tu t'es arrêté."));
            console.warn(`⚠️  Sanitise : HumanMessage de relance ajouté (contexte terminait sur AIMessage)`);
        }
    }

    return resultat;
}

// GRAPHE LANGGRAPH


const EtatAgent = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (ancien, nouveau) => [...ancien, ...nouveau],
        default: () => [],
    }),
});

const toolNodeBase = new ToolNode(TOUS_LES_TOOLS);

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISATION DES IDS — intercepte la réponse LLM AVANT qu'elle entre
// dans etat.messages. Gemini génère des tool_calls sans id → les ToolMessages
// créés par LangGraph héritent de tool_call_id=undefined → orphelins permanents.
// Ce fix assigne un id AVANT que le mal soit fait.
// ─────────────────────────────────────────────────────────────────────────────
function normaliserToolCallIds(msg: any): any {
    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) return msg;
    if (toolCalls.every((tc: any) => !!tc.id)) {
        // Ids OK — reconstruire quand même additional_kwargs en format OpenAI
        // (Groq/Mistral lisent additional_kwargs, pas msg.tool_calls)
        const akNormalisé = toolCalls.map((tc: any) => ({
            id: tc.id, type: "function" as const,
            function: { name: tc.name, arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}) },
        }));
        return new AIMessage({
            content: msg.content, tool_calls: toolCalls,
            additional_kwargs: { ...msg.additional_kwargs, tool_calls: akNormalisé },
        });
    }
    // Ids manquants → en assigner
    const fixed = toolCalls.map((tc: any) => {
        if (tc.id) return tc;
        const id = Math.random().toString(36).slice(2, 11);
        console.warn(`🔧 tool_call "${tc.name}" sans id → id="${id}" assigné`);
        return { ...tc, id };
    });
    const akNormalisé = fixed.map((tc: any) => ({
        id: tc.id, type: "function" as const,
        function: { name: tc.name, arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}) },
    }));
    return new AIMessage({
        content: msg.content, tool_calls: fixed,
        additional_kwargs: { ...msg.additional_kwargs, tool_calls: akNormalisé },
    });
}

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

        // ── Fenêtre glissante ──────────────────────────────────────────────────
        // etat.messages accumule TOUT depuis le début (reducer append-only).
        // Le contextManager gère déjà l'historique global.
        // On ne passe que les 12 derniers messages pour éviter l'accumulation
        // de paires AIMessage/ToolMessage de providers différents → orphelins.
        const MAX_RECENT = 12;
        const recent = etat.messages.length > MAX_RECENT
            ? etat.messages.slice(-MAX_RECENT)
            : etat.messages;
        // Ne jamais démarrer sur :
        //   - un AIMessage sans tool_calls (son HumanMessage parent est hors fenêtre)
        //   - un ToolMessage (son AIMessage parent est hors fenêtre → orphelin immédiat)
        // Avancer jusqu'au premier HumanMessage ou AIMessage-avec-tools.
        let debut = 0;
        while (debut < recent.length - 1) {
            const m = recent[debut];
            const isAISansTools = m instanceof AIMessage && (m.tool_calls?.length ?? 0) === 0;
            const isToolMsg     = m instanceof ToolMessage;
            if (isAISansTools || isToolMsg) { debut++; } else { break; }
        }
        const allMessagesFenetre = [...optimizedContext, ...recent.slice(debut)];
        // ────────────────────────────────────────────────────────────────────

        const messagesSanitises = sanitiserMessages(allMessagesFenetre);
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
            // NE PAS inclure `reponse` (AIMessage vide) dans le contexte :
            // Mistral rejette tout AIMessage sans content ni tool_calls (code 400).
            // On injecte directement un HumanMessage de relance.
            const messagesAvecNudge = [
                ...allMessagesFenetre,
                new HumanMessage(
                    "[RELANCE] Ta réponse précédente était vide. " +
                    "Tu dois OBLIGATOIREMENT utiliser les outils disponibles. " +
                    "Commence maintenant par l'action la plus logique."
                ),
            ];
            const reponseNudge = await multiLLM.invoke(sanitiserMessages(messagesAvecNudge));
            console.log("Réponse après nudge reçue.");
            return { messages: [normaliserToolCallIds(reponseNudge)] };
        }

        return { messages: [normaliserToolCallIds(reponse)] };

    } catch (error: any) {
        console.error("Erreur definitive noeudLLM:", error?.message);

        // Contexte trop cassé (tous les providers ont SKIPpé) → fallback nucléaire
        // On réessaie avec uniquement le dernier message humain, contexte vide
        if (error?.message === "CONTEXT_INCOMPATIBLE") {
            console.warn("⚠️  FALLBACK NUCLÉAIRE : clearContext + relance message brut");
            const dernierHuman = etat.messages.filter(m => m instanceof HumanMessage).at(-1);
            if (dernierHuman) {
                try {
                    await contextManager.clearContext(); // Vider l'historique cassé
                    const reponseNucleaire = await multiLLM.invoke([
                        new HumanMessage(
                            "Tu es un agent IA autonome. Réponds en français. " +
                            "Message : " + String(dernierHuman.content)
                        )
                    ]);
                    console.log("Réponse fallback nucléaire reçue.");
                    return { messages: [normaliserToolCallIds(reponseNucleaire)] };
                } catch (e2: any) {
                    console.error("Fallback nucléaire échoué:", e2?.message);
                }
            }
        }

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
        // ── Détection de demande de screenshot explicite ──────────────────────
        // Si l'utilisateur demande une capture, on injecte un rappel fort dans
        // le message pour contourner les LLMs (ex: Mistral small) qui ignorent
        // les consignes implicites du system prompt.
        const motsClesCapture = /capture|screenshot|photo|image|montre|affiche|vois|voir la page/i;
        const demandeCapture = motsClesCapture.test(messageUtilisateur);
        const messageInjecte = demandeCapture
            ? `${messageUtilisateur}\n[INSTRUCTION CRITIQUE : Tu DOIS appeler screenshot_e2b maintenant. C'est obligatoire.]`
            : messageUtilisateur;

        const messageEntrant = new HumanMessage(messageInjecte);
        await contextManager.addMessage(new HumanMessage(messageUtilisateur)); // contexte sans injection

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