import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { ChatCohere } from "@langchain/cohere";
import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { HumanMessage, AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { outilsDeBase } from "./tools";
import { e2bTools } from "./browser/e2b-tools";
import { credentialTools } from "./browser/credentials";
import { debugTools } from "./browser/debug-tools";
import { fsMemoryTools, offloadSiVolumineux, INSTRUCTIONS_FILE } from "./memory/fs-memory";
import { navigateur } from "./browser/browser-manager";
import { e2bSandbox } from "./browser/e2b-sandbox";
import { AdvancedContextManager, ContextConfig } from "./context/context-manager";
import * as fs from "fs";
import * as readline from "readline";
import * as dotenv from "dotenv";
import console from "console";

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION DES ERREURS
// ─────────────────────────────────────────────────────────────────────────────

type ErrorKind = "QUOTA_EXHAUSTED" | "SKIP" | "RATE_LIMIT" | "RETRYABLE" | "FATAL";

function classifierErreur(error: any): ErrorKind {
    const msg    = (error?.message ?? "").toLowerCase();
    const status = error?.status ?? 0;

    // Quota journalier epuise
    if (
        msg.includes("limit: 0") ||
        msg.includes("per_day") ||
        (msg.includes("quota") && msg.includes("exceeded") && msg.includes("day"))
    ) return "QUOTA_EXHAUSTED";

    // 413 = contexte trop grand pour CETTE requete seulement => SKIP (provider reutilisable)
    if (status === 413 || msg.includes("request too large") || msg.includes("too large for model")) {
        return "SKIP";
    }

    // Rate limit
    if (
        status === 429 ||
        msg.includes("rate_limit") ||
        msg.includes("rate limit") ||
        msg.includes("too many requests") ||
        msg.includes("resource_exhausted") ||
        msg.includes("max retries reached") ||
        msg.includes("max retries exceeded") ||
        (msg.includes("quota") && msg.includes("exceeded") && !msg.includes("day"))
    ) return "RATE_LIMIT";

    // Erreurs temporaires
    if (
        status === 503 ||
        msg.includes("overloaded") ||
        msg.includes("timeout") ||
        msg.includes("unavailable")
    ) return "RETRYABLE";

    // Modele introuvable ou incompatibilite schema Cohere => ban definitif
    if (
        status === 404 ||
        msg.includes("model_not_found") ||
        msg.includes("missing required key") ||
        msg.includes("parameterdefinitions")
    ) return "QUOTA_EXHAUSTED";

    // Auth invalide
    if (
        status === 401 ||
        msg.includes("invalid api key") ||
        msg.includes("unauthorized")
    ) return "QUOTA_EXHAUSTED";

    // 400 sans body = contexte mal formé pour CE modèle (ex: Cerebras llama3.1-8b
    // rejette certains tool_calls avec 400 sans aucun message d'erreur explicite)
    // => SKIP : le provider reste utilisable pour la prochaine requête
    if (status === 400 && (msg === "" || msg === "400 status code (no body)" || msg.length < 30)) {
        return "SKIP";
    }

    // Erreurs de FORMAT de contexte => SKIP (provider reste utilisable pour la prochaine requete)
    if (
        msg.includes("tool call id has to be defined") ||
        msg.includes("expected last role") ||
        msg.includes("message_order") ||
        msg.includes("invalid_request_message") ||
        msg.includes("all openai tool calls must have an") ||
        msg.includes("not the same number of function calls") ||
        msg.includes("assistant message must have either content or tool_calls") ||
        msg.includes("expected object. received null") ||
        msg.includes("toolresults") ||
        msg.includes("invalid role") ||
        msg.includes("last message must be") ||
        msg.includes("tool_use_failed") ||
        msg.includes("failed to call a function") ||
        msg.includes("please adjust your prompt") ||
        msg.includes("thought_signature") ||
        msg.includes("missing a thought")
    ) return "SKIP";

    return "FATAL";
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDERS
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderConfig {
    name: string;
    rpm: number;
    maxRetries: number;
    factory: (tools: any[]) => any;
}

const PROVIDERS_CHAIN: ProviderConfig[] = [
    {
        name: "Cerebras gpt-oss-120b", rpm: 28, maxRetries: 2,
        factory: (tools) => new ChatOpenAI({
            model: "gpt-oss-120b", temperature: 0,
            apiKey: process.env.CEREBRAS_API_KEY,
            configuration: { baseURL: "https://api.cerebras.ai/v1" },
            maxRetries: 0,
        }).bindTools(tools, { strict: false }),
    },
    {
        name: "Cerebras llama3.1-8b", rpm: 28, maxRetries: 2,
        factory: (tools) => new ChatOpenAI({
            model: "llama3.1-8b", temperature: 0,
            apiKey: process.env.CEREBRAS_API_KEY,
            configuration: { baseURL: "https://api.cerebras.ai/v1" },
            maxRetries: 0,
        }).bindTools(tools, { strict: false }),
    },
    {
        name: "Mistral small", rpm: 4, maxRetries: 1,
        factory: (tools) => new ChatOpenAI({
            model: "mistral-small-latest", temperature: 0,
            apiKey: process.env.MISTRAL_API_KEY,
            configuration: { baseURL: "https://api.mistral.ai/v1" },
            maxRetries: 0,
        }).bindTools(tools, { strict: false }),
    },
    {
        name: "Groq llama-3.3-70b", rpm: 20, maxRetries: 1,
        factory: (tools) => new ChatGroq({
            model: "llama-3.3-70b-versatile", temperature: 0,
            apiKey: process.env.GROQ_API_KEY, maxRetries: 0,
        }).bindTools(tools),
    },
    {
        name: "Groq llama-3.1-8b", rpm: 20, maxRetries: 1,
        factory: (tools) => new ChatGroq({
            model: "llama-3.1-8b-instant", temperature: 0,
            apiKey: process.env.GROQ_API_KEY, maxRetries: 0,
        }).bindTools(tools),
    },
    {
        name: "Gemini 2.0 Flash", rpm: 15, maxRetries: 2,
        factory: (tools) => new ChatGoogleGenerativeAI({
            model: "gemini-2.0-flash", temperature: 0,
            apiKey: process.env.GOOGLE_API_KEY, maxRetries: 0,
        }).bindTools(tools),
    },
    {
        name: "Gemini 2.5 Flash", rpm: 9, maxRetries: 2,
        factory: (tools) => new ChatGoogleGenerativeAI({
            model: "gemini-2.5-flash", temperature: 0,
            apiKey: process.env.GOOGLE_API_KEY, maxRetries: 0,
        }).bindTools(tools),
    },
    {
        name: "Cohere command-r", rpm: 20, maxRetries: 1,
        factory: (tools) => new ChatCohere({
            model: "command-r", temperature: 0,
            apiKey: process.env.COHERE_API_KEY, maxRetries: 0,
        }).bindTools(tools, { strict: false }),
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-PROVIDER LLM
// ─────────────────────────────────────────────────────────────────────────────

class MultiProviderLLM {
    private quotaEpuise      = new Map<number, boolean>();
    private rateLimitedUntil = new Map<number, number>();
    private lastCallTime     = new Map<number, number>();
    private instances        = new Map<number, any>();
    private tools: any[];

    constructor(tools: any[]) {
        this.tools = tools;
        PROVIDERS_CHAIN.forEach((_, i) => {
            this.quotaEpuise.set(i, false);
            this.rateLimitedUntil.set(i, 0);
            this.lastCallTime.set(i, 0);
        });
    }

    private getInstance(i: number): any {
        if (!this.instances.has(i)) {
            this.instances.set(i, PROVIDERS_CHAIN[i].factory(this.tools));
        }
        return this.instances.get(i)!;
    }

    // Respecte le RPM sans log verbeux a chaque appel
    private async respecterRpm(i: number): Promise<void> {
        const config   = PROVIDERS_CHAIN[i];
        const minDelay = Math.ceil((60 / config.rpm) * 1000 * 1.1); // 10% marge
        const elapsed  = Date.now() - (this.lastCallTime.get(i) ?? 0);
        if (elapsed < minDelay) await sleep(minDelay - elapsed);
        this.lastCallTime.set(i, Date.now());
    }

    // Temps restant avant que ce provider soit disponible (0 = disponible maintenant)
    private cooldownRestant(i: number): number {
        return Math.max(0, (this.rateLimitedUntil.get(i) ?? 0) - Date.now());
    }

    // Plus court cooldown parmi les providers non-epuises
    private prochainDisponibleDans(): number {
        let min = Infinity;
        PROVIDERS_CHAIN.forEach((_, i) => {
            if (!this.quotaEpuise.get(i)) {
                min = Math.min(min, this.cooldownRestant(i));
            }
        });
        return min === Infinity ? -1 : min;
    }

    getCurrentProviderName(): string {
        for (let i = 0; i < PROVIDERS_CHAIN.length; i++) {
            if (!this.quotaEpuise.get(i) && this.cooldownRestant(i) === 0) {
                return PROVIDERS_CHAIN[i].name;
            }
        }
        const dansMs = this.prochainDisponibleDans();
        if (dansMs > 0) return `(cooldown ${Math.round(dansMs/1000)}s)`;
        return "Aucun";
    }

    getEpuises(): string[] {
        return PROVIDERS_CHAIN.filter((_, i) => this.quotaEpuise.get(i)).map(p => p.name);
    }

    async invoke(messages: BaseMessage[]): Promise<any> {
        // Log diagnostic
        const epuises = this.getEpuises();
        if (epuises.length > 0) console.log(`⚠️  Bannis session : ${epuises.join(", ")}`);

        // Verifier s'il reste au moins un provider non-epuise
        const tousEpuises = PROVIDERS_CHAIN.every((_, i) => this.quotaEpuise.get(i));
        if (tousEpuises) throw new Error("QUOTA_JOURNALIER_EPUISE");

        // Deux passes :
        //   Passe 1 : essayer tous les providers non-en-cooldown (sans dormir)
        //   Passe 2 : attendre le cooldown le plus court, puis reessayer
        // => Fini les 45s de sleep qui bloquent Groq pendant que Mistral refroidit
        for (let passe = 0; passe < 2; passe++) {
            let wasRateLimited = false;
            let wasSkipped     = false;

            for (let i = 0; i < PROVIDERS_CHAIN.length; i++) {
                if (this.quotaEpuise.get(i)) continue;

                // Provider en cooldown => noter et passer au suivant SANS dormir
                if (this.cooldownRestant(i) > 0) {
                    wasRateLimited = true;
                    continue;
                }

                const config = PROVIDERS_CHAIN[i];
                const llm    = this.getInstance(i);

                for (let attempt = 0; attempt < config.maxRetries; attempt++) {
                    try {
                        await this.respecterRpm(i);
                        console.log(`[${config.name}] tentative ${attempt + 1}/${config.maxRetries}`);
                        const result = await llm.invoke(messages);
                        this.rateLimitedUntil.set(i, 0); // succes => effacer cooldown
                        return result;

                    } catch (error: any) {
                        const kind = classifierErreur(error);
                        console.warn(`[${config.name}] ${kind} : ${String(error?.message).slice(0, 120)}`);

                        switch (kind) {
                            case "QUOTA_EXHAUSTED":
                                console.warn(`  => Banni definitivement cette session`);
                                this.quotaEpuise.set(i, true);
                                attempt = config.maxRetries;
                                break;

                            case "SKIP":
                                // Format incompatible pour CETTE requete, provider conserve
                                wasSkipped = true;
                                attempt = config.maxRetries;
                                break;

                            case "RATE_LIMIT": {
                                const match       = error?.message?.match(/retry[^0-9]*(\d+(?:\.\d+)?)\s*s/i);
                                const suggest     = match ? parseFloat(match[1]) * 1000 : 0;
                                const rpmCooldown = Math.ceil((60 / config.rpm) * 1000 * 3);
                                const expBackoff  = Math.pow(2, attempt + 2) * 1000;
                                const waitMs      = Math.max(suggest, rpmCooldown, expBackoff);
                                console.warn(`  => Cooldown ${Math.round(waitMs / 1000)}s`);
                                this.rateLimitedUntil.set(i, Date.now() + waitMs);
                                wasRateLimited = true;
                                attempt = config.maxRetries; // passer au provider suivant
                                break;
                            }

                            case "RETRYABLE": {
                                const waitMs = Math.pow(2, attempt + 1) * 1000;
                                console.warn(`  => Retry dans ${Math.round(waitMs/1000)}s`);
                                await sleep(waitMs);
                                break;
                            }

                            case "FATAL":
                                throw error;
                        }
                    }
                }

                if (!this.quotaEpuise.get(i)) {
                    console.log(`[${config.name}] retries epuises => provider suivant`);
                }
            }

            // Fin de passe sans succes
            const tousEpuisesNow = PROVIDERS_CHAIN.every((_, i) => this.quotaEpuise.get(i));
            if (tousEpuisesNow) throw new Error("QUOTA_JOURNALIER_EPUISE");

            if (wasSkipped && !wasRateLimited) {
                // Tous ont SKIPpe => contexte structurellement incompatible
                throw new Error("CONTEXT_INCOMPATIBLE");
            }

            if (wasRateLimited && passe === 0) {
                // Attendre le plus court cooldown, puis passe 2
                const attente = this.prochainDisponibleDans();
                if (attente > 0) {
                    console.warn(`⏳ Tous en cooldown. Attente ${Math.round(attente/1000)}s...`);
                    await sleep(attente + 300);
                }
                continue; // passe 2
            }
        }

        throw new Error("ALL_RATE_LIMITED");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// OFFLOAD MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

async function toolNodeAvecOffload(
    etat: typeof EtatAgent.State,
    toolNode: ToolNode
): Promise<{ messages: BaseMessage[] }> {
    const resultat = await toolNode.invoke(etat);

    const outilsExclus = [
        "screenshot_e2b", "obtenir_date", "calculer",
        "grep_memoire", "lire_lignes", "resume_session",
        "mettre_a_jour_todo", "lire_todo", "lire_instructions",
    ];

    const messagesOptimises = resultat.messages.map((msg: BaseMessage) => {
        if (!(msg instanceof ToolMessage)) return msg;
        if (typeof msg.content !== "string") return msg;
        if (outilsExclus.some(nom => msg.name?.includes(nom))) return msg;

        const contenuOptimise = offloadSiVolumineux(msg.name ?? "tool", msg.content);

        if (contenuOptimise !== msg.content) {
            const ratio = Math.round(
                ((msg.content.length - contenuOptimise.length) / msg.content.length) * 100
            );
            console.log(`Offload FS : ${msg.name} | ${msg.content.length} -> ${contenuOptimise.length} chars (-${ratio}%)`);
        }

        return new ToolMessage({
            content     : contenuOptimise,
            tool_call_id: msg.tool_call_id,
            name        : msg.name,
        });
    });

    return { messages: messagesOptimises };
}

// ─────────────────────────────────────────────────────────────────────────────
// INITIALISATION
// ─────────────────────────────────────────────────────────────────────────────

const TOUS_LES_TOOLS = [
    ...outilsDeBase,
    ...e2bTools,
    ...credentialTools,
    ...debugTools,
    ...fsMemoryTools,
];

const multiLLM = new MultiProviderLLM(TOUS_LES_TOOLS);

const llmPourContexte = new ChatGoogleGenerativeAI({
    model: "gemini-2.0-flash", temperature: 0,
    apiKey: process.env.GOOGLE_API_KEY, maxRetries: 2,
}) as any;

const contextConfig: ContextConfig = {
    maxTokens: 28000,
    compressionThreshold: 0.75,
    summaryInterval: 8,
    keepLastNMessages: 6,
};
export const contextManager = new AdvancedContextManager(contextConfig, llmPourContexte);

const memoireConversation = new InMemoryChatMessageHistory();

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────

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

const SYSTEME_PROMPT_BASE = `Tu es un expert IA autonome. Tu disposes des outils suivants pour interagir avec le monde exterieur. Reponds toujours en francais.

OUTILS DISPONIBLES :

Navigation (E2B Sandbox) :
  - demarrer_sandbox, aller_vers_e2b, cliquer_e2b, taper_e2b
  - lire_page_e2b, screenshot_e2b, attendre_e2b, cocher_case_e2b, scroller_e2b
  - appuyer_touche_e2b     : appuie sur Enter/Tab/Escape pour valider un formulaire
  - selectionner_option_e2b : choisit une option dans un menu deroulant <select>
  - evaluer_js_e2b          : execute du JavaScript sur la page (lecture/ecriture DOM)
  - lister_champs_formulaire : liste tous les inputs/selects/boutons de la page

Fichiers de base :
  - calculer, lire_fichier, ecrire_fichier, lister_fichiers, obtenir_date

Credentials :
  - sauvegarder_credential, lire_credential, generate_mot_de_passe

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
   - Si le resultat est trop volumineux, il sera sauvegarde et tu recevras un chemin.
   - Utilise immediatement grep_memoire ou evaluer_js_e2b pour extraire les selecteurs.
   - NE PAS continuer sans avoir analyse la structure de la page.
6. SI grep_memoire ne trouve rien, utilise lister_champs_formulaire
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
   b. lister_champs_formulaire pour lister les inputs
   c. evaluer_js_e2b pour lister les inputs manuellement
6. Si l'utilisateur te donne un conseil, utilise apprendre_instruction.
7. SCREENSHOT OBLIGATOIRE apres chaque navigation, clic et saisie.
   NE JAMAIS repondre j ai effectue l action sans screenshot_e2b juste avant.
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
// SANITISATION DES MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

function extraireToolCalls(msg: AIMessage): Array<{ id: string; name: string; args: any }> {
    const lcCalls = (msg.tool_calls ?? []).filter((tc: any) => !!tc.id);
    if (lcCalls.length > 0) {
        return lcCalls.map((tc: any) => ({ id: tc.id as string, name: tc.name, args: tc.args }));
    }
    const akCalls = (msg.additional_kwargs?.tool_calls as any[]) ?? [];
    return akCalls.filter((tc: any) => !!tc.id).map((tc: any) => ({
        id  : tc.id as string,
        name: tc.function?.name ?? tc.name ?? "unknown",
        args: (() => {
            try { return JSON.parse(tc.function?.arguments ?? tc.arguments ?? "{}"); }
            catch { return {}; }
        })(),
    }));
}

function normaliserAIMessage(msg: AIMessage, toolCalls: Array<{ id: string; name: string; args: any }>): AIMessage {
    const akNormalisé = toolCalls.map(tc => ({
        id: tc.id, type: "function" as const,
        function: {
            name: tc.name,
            arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
        },
    }));
    return new AIMessage({
        content: msg.content,
        tool_calls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, args: tc.args, type: "tool_call" as const })),
        additional_kwargs: { ...msg.additional_kwargs, tool_calls: akNormalisé },
    });
}

function sanitiserMessages(messages: BaseMessage[]): BaseMessage[] {
    const resultat: BaseMessage[] = [];
    let i = 0;

    while (i < messages.length) {
        const msg = messages[i];

        if (msg instanceof AIMessage) {
            const toolCalls = extraireToolCalls(msg);
            const content   = String(msg.content ?? "").trim();

            if (!content && toolCalls.length === 0) {
                console.warn(`Sanitise : AIMessage vide supprime`);
                i++; continue;
            }

            if (toolCalls.length === 0) {
                resultat.push(msg); i++; continue;
            }

            // Collecter les ToolMessages suivants
            const toolMsgsSuivants: ToolMessage[] = [];
            let j = i + 1;
            while (j < messages.length && messages[j] instanceof ToolMessage) {
                toolMsgsSuivants.push(messages[j] as ToolMessage);
                j++;
            }

            const idsAttendus = new Set(toolCalls.map(tc => tc.id));
            const idsRecus    = new Set(toolMsgsSuivants.map(tm => tm.tool_call_id).filter(Boolean));
            const paireValide =
                idsAttendus.size === idsRecus.size &&
                idsAttendus.size > 0 &&
                [...idsAttendus].every(id => idsRecus.has(id));

            if (paireValide) {
                resultat.push(normaliserAIMessage(msg, toolCalls));
                for (const tc of toolCalls) {
                    resultat.push(toolMsgsSuivants.find(t => t.tool_call_id === tc.id)!);
                }
                i = j;
            } else {
                console.warn(`Sanitise : Paire incomplete rejetee (${idsAttendus.size} attendus, ${idsRecus.size} recus)`);
                i = j;
            }
            continue;
        }

        if (msg instanceof ToolMessage) {
            const prev = resultat.at(-1);
            const prevEstParent = prev instanceof AIMessage && (
                (prev.tool_calls?.some((tc: any) => tc.id === msg.tool_call_id)) ||
                ((prev.additional_kwargs?.tool_calls as any[])?.some((tc: any) => tc.id === msg.tool_call_id))
            );
            if (!prevEstParent) {
                console.warn(`Sanitise : ToolMessage orphelin supprime (id: ${msg.tool_call_id})`);
                i++; continue;
            }
            resultat.push(msg); i++; continue;
        }

        resultat.push(msg); i++;
    }

    // Supprimer les AIMessages terminaux avec tool_calls sans reponse
    while (resultat.length > 0) {
        const last = resultat.at(-1)!;
        if (last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0) {
            console.warn(`Sanitise : AIMessage terminal avec tool_calls supprime`);
            resultat.pop();
        } else break;
    }

    // Mistral refuse si le dernier message est un AIMessage sans tool_calls
    const dernierMsg = resultat.at(-1);
    if (dernierMsg instanceof AIMessage) {
        const txt = String(dernierMsg.content ?? "").trim();
        if (!txt) {
            resultat.pop();
        } else {
            resultat.push(new HumanMessage("[RELANCE SYSTEME] Reprends la tache la ou tu t'es arrete."));
        }
    }

    return resultat;
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISATION DES IDS (Gemini omet les IDs de tool_calls)
// ─────────────────────────────────────────────────────────────────────────────

function normaliserToolCallIds(msg: any): any {
    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) return msg;

    const fixed = toolCalls.map((tc: any) => {
        if (tc.id) return tc;
        const id = Math.random().toString(36).slice(2, 11);
        console.warn(`tool_call "${tc.name}" sans id => id="${id}" assigne`);
        return { ...tc, id };
    });

    const akNormalisé = fixed.map((tc: any) => ({
        id: tc.id, type: "function" as const,
        function: {
            name: tc.name,
            arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
        },
    }));

    return new AIMessage({
        content: msg.content, tool_calls: fixed,
        additional_kwargs: { ...msg.additional_kwargs, tool_calls: akNormalisé },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAPHE LANGGRAPH
// ─────────────────────────────────────────────────────────────────────────────

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
        const SYSTEME_PROMPT   = construireSystemePrompt();
        const optimizedContext = await contextManager.getOptimizedContext(SYSTEME_PROMPT);

        const stats = contextManager.getContextStats();
        console.log(`Contexte : ${stats.totalMessages} msgs | ${stats.currentTokens} tokens | compression : ${((1 - stats.compressionRatio) * 100).toFixed(0)}%`);

        // Fenetre glissante : 12 derniers messages
        // 6 était trop petit → l'agent oubliait les actions déjà faites et les répétait
        // (ex: demarrer_sandbox appelé 2x, generate_mot_de_passe 2x)
        // Groq llama-3.1-8b fait du 413 au-delà de ~6000 tokens → on sanitise après
        const MAX_RECENT = 12;
        const recent = etat.messages.length > MAX_RECENT
            ? etat.messages.slice(-MAX_RECENT)
            : etat.messages;

        // Ne pas demarrer sur un ToolMessage ou AIMessage-sans-tools (orphelins potentiels)
        let debut = 0;
        while (debut < recent.length - 1) {
            const m = recent[debut];
            const isAISansTools = m instanceof AIMessage && (m.tool_calls?.length ?? 0) === 0;
            if (isAISansTools || m instanceof ToolMessage) { debut++; } else break;
        }

        const messagesFenetre   = [...optimizedContext, ...recent.slice(debut)];
        const messagesSanitises = sanitiserMessages(messagesFenetre);
        const reponse = await multiLLM.invoke(messagesSanitises);
        console.log("Reponse LLM recue.");

        // Reponse vide => nudge
        const texte     = String(reponse.content ?? "").trim();
        const aDesTools = (reponse.tool_calls?.length > 0) || (reponse.additional_kwargs?.tool_calls?.length > 0);

        if (!texte && !aDesTools) {
            console.warn("Reponse vide detectee => nudge...");
            const messagesAvecNudge = [
                ...messagesFenetre,
                new HumanMessage(
                    "[RELANCE] Ta reponse etait vide. Tu DOIS utiliser un outil maintenant. " +
                    "Commence par l'action la plus logique."
                ),
            ];
            const reponseNudge = await multiLLM.invoke(sanitiserMessages(messagesAvecNudge));
            return { messages: [normaliserToolCallIds(reponseNudge)] };
        }

        return { messages: [normaliserToolCallIds(reponse)] };

    } catch (error: any) {
        console.error("Erreur definitive noeudLLM:", error?.message);

        const estRecuperable = ["CONTEXT_INCOMPATIBLE", "ALL_RATE_LIMITED"].includes(error?.message);

        if (estRecuperable) {
            // FALLBACK NUCLEAIRE
            // On N'efface PAS les rate limits (evite les re-429 immediats)
            // On efface le contexte et invoke() gerera lui-meme les cooldowns
            console.warn(`FALLBACK NUCLEAIRE (${error.message}) => reset contexte + reinvocation`);

            const dernierHuman = etat.messages.filter(m => m instanceof HumanMessage).at(-1);
            if (dernierHuman) {
                await contextManager.clearContext();
                console.log("Contexte efface.");

                const systemPrompt    = construireSystemePrompt();
                const messagesFallback = [
                    new HumanMessage(systemPrompt + "\n\n---\n\nTache : " + String(dernierHuman.content))
                ];

                try {
                    const reponse = await multiLLM.invoke(messagesFallback);
                    console.log("Reponse fallback recue.");
                    return { messages: [normaliserToolCallIds(reponse)] };
                } catch (e2: any) {
                    console.error("Fallback echoue:", e2?.message);
                    // invoke() a deja gere les 2 passes et attendu les cooldowns
                    // Si ca echoue encore = vraiment tout est epuise/sature
                }
            }
        }

        // Message final lisible
        if (error?.message === "QUOTA_JOURNALIER_EPUISE" || error?.message?.includes("Tous les providers")) {
            return { messages: [new AIMessage("Quota journalier epuise sur tous les providers. Reessaie demain.")] };
        }
        if (estRecuperable) {
            return { messages: [new AIMessage("Tous les providers sont en cooldown. Attends 1-2 minutes et reessaie.")] };
        }
        return { messages: [new AIMessage(`Erreur technique : ${error?.message ?? "inconnue"}`)] };
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
            (dernierMessage.additional_kwargs.tool_calls as any[]).length > 0);

    if (hasToolCalls) { console.log("decider -> tools"); return "tools"; }
    console.log("decider -> END");
    return END;
}

const graphe = new StateGraph(EtatAgent)
    .addNode("llm", noeudLLM)
    .addNode("tools", noeudOutils)
    .addEdge(START, "llm")
    .addConditionalEdges("llm", decider)
    .addEdge("tools", "llm")
    .compile()
    .withConfig({ recursionLimit: 50 });

// ─────────────────────────────────────────────────────────────────────────────
// API PUBLIQUE
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentResponse {
    text: string;
    screenshot?: string;
}

export async function traiterMessage(messageUtilisateur: string): Promise<AgentResponse> {
    try {
        const motsClesCapture = /capture|screenshot|photo|image|montre|affiche|vois|voir la page/i;
        const messageInjecte = motsClesCapture.test(messageUtilisateur)
            ? `${messageUtilisateur}\n[INSTRUCTION CRITIQUE : Tu DOIS appeler screenshot_e2b maintenant.]`
            : messageUtilisateur;

        await contextManager.addMessage(new HumanMessage(messageUtilisateur));

        const resultat = await graphe.invoke({ messages: [new HumanMessage(messageInjecte)] });

        let screenshotData: string | undefined;
        for (const msg of resultat.messages) {
            if (msg instanceof ToolMessage &&
                typeof msg.content === "string" &&
                msg.content.startsWith("data:image")) {
                screenshotData = msg.content;
            }
        }

        const reponseFinale = resultat.messages.at(-1);
        let contenu = String(reponseFinale?.content ?? "Pas de reponse.");
        if (!contenu.trim()) contenu = "[L'agent n'a pas genere de reponse textuelle.]";

        await contextManager.addMessage(new AIMessage(contenu));
        return { text: contenu, screenshot: screenshotData };

    } catch (error: any) {
        console.error("Erreur dans traiterMessage:", error);
        const isRecursionLimit =
            error?.lc_error_code === "GRAPH_RECURSION_LIMIT" ||
            String(error?.message).includes("Recursion limit") ||
            String(error?.message).includes("GRAPH_RECURSION_LIMIT");
        const fallback = isRecursionLimit
            ? "⚠️ L'agent a atteint la limite d'étapes (tâche trop longue ou boucle). Reformule en étapes plus courtes ou tape 'reset'."
            : "Desole, une erreur interne est survenue.";
        await contextManager.addMessage(new AIMessage(fallback));
        return { text: fallback };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERFACE CLI
// ─────────────────────────────────────────────────────────────────────────────

async function demarrerInterface() {
    console.log("\n" + "=".repeat(65));
    console.log(" AGENT IA AUTONOME - LangChain + LangGraph + FS-Memory ");
    console.log("=".repeat(65));
    PROVIDERS_CHAIN.forEach((p, i) =>
        console.log(`  ${i + 1}. ${p.name.padEnd(26)} ${p.rpm} req/min`)
    );
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
                TOUS_LES_TOOLS.forEach(t =>
                    console.log(`  - ${t.name}: ${t.description.slice(0, 70)}...`)
                );
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