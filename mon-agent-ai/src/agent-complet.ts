import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
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
import { navigateur } from "./browser/browser-manager";
import { e2bSandbox } from "./browser/e2b-sandbox";
import { AdvancedContextManager, ContextConfig } from "./context/context-manager";
import { ContextStrategyFactory, ContextStrategy } from "./context/context-strategies";
import * as readline from "readline";
import * as dotenv from "dotenv";
import console from "console";

dotenv.config();

// UTILITAIRES RATE LIMIT

/** Pause asynchrone */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Rate Limiter — garantit un délai minimum entre chaque appel LLM.
 * Empêche de dépasser la limite de requêtes par minute des APIs gratuites.
 *
 *   Gemini 2.0 Flash (gratuit) : 60 RPM  → utiliser RateLimiter(55)
 *   Groq llama-3.1-8b-instant  : 30 RPM  → utiliser RateLimiter(25)
 *   Groq llama-3.3-70b         : 30 RPM  → utiliser RateLimiter(25)
 */
class RateLimiter {
    private lastCallTime = 0;
    private readonly minDelay: number;

    constructor(requestsPerMinute: number) {
        // On prend une marge de sécurité de 10 % sur la limite déclarée
        this.minDelay = (60 / requestsPerMinute) * 1000;
    }

    async wait(): Promise<void> {
        const now = Date.now();
        const elapsed = now - this.lastCallTime;
        if (elapsed < this.minDelay) {
            const waitMs = this.minDelay - elapsed;
            console.log(`🕒 Rate limiter : pause de ${Math.round(waitMs)}ms avant le prochain appel LLM…`);
            await sleep(waitMs);
        }
        this.lastCallTime = Date.now();
    }
}

/**
 * Retry avec backoff exponentiel — gère les erreurs 429 (rate limit) et
 * les erreurs réseau temporaires retournées par Groq / Gemini.
 *
 * Délais : 2s → 4s → 8s → 16s → 32s (max 5 tentatives)
 */
async function invokeWithRetry(
    llm: ReturnType<typeof creerLLM>,
    messages: BaseMessage[],
    maxRetries = 5
): Promise<any> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await (llm as any).invoke(messages);
        } catch (error: any) {
            const isRateLimit =
                error?.status === 429 ||
                error?.code === "rate_limit_exceeded" ||
                error?.message?.toLowerCase().includes("rate_limit") ||
                error?.message?.toLowerCase().includes("rate limit") ||
                error?.message?.toLowerCase().includes("quota") ||
                error?.message?.toLowerCase().includes("too many requests") ||
                error?.message?.toLowerCase().includes("resource_exhausted");

            const isRetryable =
                isRateLimit ||
                error?.status === 503 ||
                error?.message?.toLowerCase().includes("overloaded") ||
                error?.message?.toLowerCase().includes("timeout");

            if (isRetryable && attempt < maxRetries - 1) {
                // Backoff exponentiel : 2s, 4s, 8s, 16s, 32s
                const waitSec = Math.pow(2, attempt + 1);
                console.warn(
                    `⚠️  ${isRateLimit ? "Rate limit" : "Erreur temporaire"} détecté(e). ` +
                    `Tentative ${attempt + 1}/${maxRetries} — attente ${waitSec}s…`
                );
                await sleep(waitSec * 1000);
                continue;
            }

            // Erreur non-récupérable ou tentatives épuisées
            throw error;
        }
    }
}

// CONFIGURATION DU MODÈLE LLM (via variables d'environnement)

function creerLLM() {
    const provider     = process.env.LLM_PROVIDER    ?? "gemini";
    const maxRetries   = parseInt(process.env.LLM_MAX_RETRIES ?? "5");

    if (provider === "groq") {
        const model = process.env.LLM_MODEL ?? "llama-3.1-8b-instant";
        console.log(`🤖 LLM : Groq — ${model}`);
        return new ChatGroq({
            model,
            cache: new InMemoryCache(),
            temperature: 0,
            apiKey: process.env.GROQ_API_KEY,
            maxRetries: 0,   // On gère les retries manuellement avec invokeWithRetry
        });
    }

    // Défaut : Gemini (60 RPM sur le tier gratuit)
    const model = process.env.LLM_MODEL ?? "gemini-2.0-flash";
    console.log(`🤖 LLM : Gemini — ${model}`);
    return new ChatGoogleGenerativeAI({
        model,
        cache: new InMemoryCache(),
        temperature: 0,
        apiKey: process.env.GOOGLE_API_KEY,
        maxRetries: 0,   // On gère les retries manuellement avec invokeWithRetry
    });
}

// Déduire le RPM cible selon le provider (peut être surchargé via LLM_RPM)
function getRPM(): number {
    if (process.env.LLM_RPM) return parseInt(process.env.LLM_RPM);
    const provider = process.env.LLM_PROVIDER ?? "gemini";
    return provider === "groq" ? 25 : 55; // marge de sécurité sur les limites
}

// INITIALISATION GLOBALE

const TOUS_LES_TOOLS = [
    ...outilsDeBase,
    /* ...browserTools, */
    ...e2bTools,
    ...credentialTools,
    ...debugTools,
];

const llmBase   = creerLLM();
const llm       = (llmBase as any).bindTools(TOUS_LES_TOOLS);
const rateLimiter = new RateLimiter(getRPM());

const MAX_RETRIES = parseInt(process.env.LLM_MAX_RETRIES ?? "5");

// Gestionnaire de contexte
const contextConfig: ContextConfig = {
    maxTokens: 28000,
    compressionThreshold: 0.75,
    summaryInterval: 8,
    keepLastNMessages: 6,
};
export const contextManager = new AdvancedContextManager(contextConfig, llmBase as any);

// Mémoire conservée pour compatibilité avec la CLI
const memoireConversation = new InMemoryChatMessageHistory();

// SYSTEM PROMPT

const SYSTEME_PROMPT = `Tu es un expert IA autonome. Tu disposes des outils suivants pour interagir avec le monde extérieur. Réponds toujours en français.

OUTILS DISPONIBLES :
- demarrer_sandbox : Démarre une sandbox E2B avec un navigateur. À utiliser lorsque l'utilisateur demande d'ouvrir un navigateur, d'aller sur Internet, de lancer Chrome, etc.
- aller_vers_e2b : Navigue vers une URL (ex: "https://google.com") dans la sandbox.
- cliquer_e2b : Clique sur un élément (par sélecteur CSS ou texte visible).
- taper_e2b : Tape du texte dans un champ de formulaire.
- lire_page_e2b : Lit le contenu textuel de la page actuelle.
- screenshot_e2b : Prend une capture d'écran de la page.
- attendre_e2b : Attend un élément, un texte ou un délai (en ms).
- cocher_case_e2b : Coche ou décoche une case.
- scroller_e2b : Fait défiler la page.
- calculer : Évalue une expression mathématique.
- lire_fichier : Lit le contenu d'un fichier.
- ecrire_fichier : Écrit du contenu dans un fichier.
- lister_fichiers : Liste les fichiers d'un dossier.
- obtenir_date : Donne la date et l'heure actuelles.
- sauvegarder_credential : Sauvegarde des identifiants après une inscription.
- lire_credential : Récupère des identifiants sauvegardés.
- generate_mot_de_passe : Génère un mot de passe fort.
- diagnostic_navigateur : Diagnostique l'état du navigateur.
- tester_selecteur : Teste un sélecteur CSS.

RÈGLES D'OR :
1. Lorsque l'utilisateur demande une action qui correspond à un outil, tu DOIS appeler cet outil immédiatement, sans réponse textuelle préalable.
2. Exemple : si l'utilisateur dit "ouvre un navigateur", appelle demarrer_sandbox.
3. Si l'utilisateur te salue (bonjour, salut), réponds de manière amicale sans utiliser d'outils.
4. Après avoir exécuté un outil, tu recevras son résultat. Tu dois alors fournir une réponse textuelle à l'utilisateur en synthétisant ce résultat.
5. Pour la navigation web, la procédure typique est :
   - Si le navigateur n'est pas encore ouvert, appelle demarrer_sandbox.
   - Ensuite, utilise aller_vers_e2b pour charger une URL.
   - Puis utilise les outils d'interaction (cliquer, taper, etc.) et de vérification (lire_page_e2b, screenshot_e2b).
6. Sécurité : après une création de compte, sauvegarde toujours les identifiants avec sauvegarder_credential.
7. Précision : prends un screenshot avant/après chaque action clé pour vérifier.
8. Patience : utilise attendre_e2b pour laisser le temps aux éléments d'apparaître.

SÉLECTEURS COURANTS :
- Google : 'input[name="q"]', 'textarea[name="q"]'.
- Formulaires : privilégie les sélecteurs par texte pour les boutons (ex: { "selector": "button:has-text('Se connecter')" } ).`;

// GRAPHE LANGGRAPH

const EtatAgent = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (ancien, nouveau) => [...ancien, ...nouveau],
        default: () => [],
    }),
});

// NOEUD LLM — réfléchit et décide quoi faire
async function noeudLLM(etat: typeof EtatAgent.State) {
    console.log("📥 Entrée dans noeudLLM. Nombre de messages:", etat.messages.length);

    const dernier = etat.messages.at(-1);
    if (dernier instanceof ToolMessage) {
        console.log("🔧 Dernier message ToolMessage:", String(dernier.content).slice(0, 200));
    }

    try {
        const optimizedContext = await contextManager.getOptimizedContext(SYSTEME_PROMPT);
        const allMessages = [...optimizedContext, ...etat.messages];

        const stats = contextManager.getContextStats();
        console.log(
            `📊 Contexte: ${stats.totalMessages} msgs, ` +
            `${stats.currentTokens} tokens, ` +
            `compression: ${((1 - stats.compressionRatio) * 100).toFixed(0)}%`
        );

        // 1. Respecter la limite de débit (rate limiter)
        await rateLimiter.wait();

        // 2. Appel LLM avec retry + backoff exponentiel
        const reponse = await invokeWithRetry(llm, allMessages, MAX_RETRIES);

        console.log("📤 Réponse LLM:", JSON.stringify(reponse, null, 2));
        return { messages: [reponse] };

    } catch (error: any) {
        console.error("❌ Erreur définitive dans noeudLLM:", error?.message ?? error);
        const msg = error?.status === 429
            ? "Limite de requêtes API atteinte. Attends quelques secondes et réessaie."
            : `Une erreur technique est survenue : ${error?.message ?? "inconnue"}`;
        return { messages: [new AIMessage(msg)] };
    }
}

// NOEUD D'OUTILS
const toolNode = new ToolNode(TOUS_LES_TOOLS);

// DÉCISION : appeler un tool ou terminer ?
function decider(etat: typeof EtatAgent.State): string {
    const dernierMessage = etat.messages.at(-1);

    const hasToolCalls =
        (dernierMessage?.tool_calls && dernierMessage.tool_calls.length > 0) ||
        (dernierMessage?.additional_kwargs?.tool_calls &&
            (dernierMessage.additional_kwargs.tool_calls as any[]).length > 0) ||
        ((dernierMessage as any)?.kwargs?.tool_calls &&
            (dernierMessage as any).kwargs.tool_calls.length > 0);

    if (hasToolCalls) {
        console.log("🔀 decider → tools");
        return "tools";
    }
    console.log("🔀 decider → END");
    return END;
}

// Construction du graphe
const graphe = new StateGraph(EtatAgent)
    .addNode("llm", noeudLLM)
    .addNode("tools", toolNode)
    .addEdge(START, "llm")
    .addConditionalEdges("llm", decider)
    .addEdge("tools", "llm")
    .compile();

// API PUBLIQUE

export interface AgentResponse {
    text: string;
    screenshot?: string; // data:image/png;base64,…
}

export async function traiterMessage(messageUtilisateur: string): Promise<AgentResponse> {
    try {
        const messageEntrant = new HumanMessage(messageUtilisateur);
        await contextManager.addMessage(messageEntrant);

        const resultat = await graphe.invoke(
            { messages: [messageEntrant] },
            { recursionLimit: 100 }
        );

        // Scanner TOUS les messages pour trouver le screenshot le plus récent
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
        let contenu = String(reponseFinale?.content ?? "Pas de réponse.");
        if (!contenu.trim()) {
            contenu = "[L'agent n'a pas généré de réponse textuelle.]";
        }

        await contextManager.addMessage(new AIMessage(contenu));
        return { text: contenu, screenshot: screenshotData };

    } catch (error) {
        console.error("❌ Erreur dans traiterMessage:", error);
        const fallback = "Désolé, une erreur interne est survenue.";
        await contextManager.addMessage(new AIMessage(fallback));
        return { text: fallback };
    }
}

// INTERFACE CLI (uniquement si lancé directement : ts-node agent-complet.ts)

async function demarrerInterface() {
    const provider = process.env.LLM_PROVIDER ?? "gemini";
    const model    = process.env.LLM_MODEL    ?? "gemini-2.0-flash";
    const rpm      = getRPM();

    console.log("\n" + "=".repeat(60));
    console.log(" AGENT IA AUTONOME — LangChain + LangGraph ");
    console.log("=".repeat(60));
    console.log(`🤖 Modèle    : ${provider.toUpperCase()} — ${model}`);
    console.log(`⏱️  Rate limit : ${rpm} requêtes/min (marge de sécurité incluse)`);
    console.log(`🔁 Max retry  : ${MAX_RETRIES} tentatives avec backoff exponentiel`);
    console.log(" Tools     : Fichiers, Calcul, Navigateur E2B, Credentials");
    console.log(" Mémoire   : Active (se souvient de la conversation)");
    console.log("-".repeat(60));
    console.log("Commandes spéciales :");
    console.log("  'exit'    → Quitter");
    console.log("  'reset'   → Effacer la mémoire");
    console.log("  'tools'   → Lister les tools disponibles");
    console.log("=".repeat(60) + "\n");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const LireQuestion = () => {
        rl.question("Tu 💬 : ", async (input) => {
            const msg = input.trim();
            if (!msg) { LireQuestion(); return; }

            if (msg.toLowerCase() === "exit") {
                console.log("\n Fermeture…");
                await navigateur.fermer();
                await e2bSandbox.fermer();
                rl.close();
                process.exit(0);
            }

            if (msg.toLowerCase() === "reset") {
                await memoireConversation.clear();
                console.log(" Mémoire effacée.\n");
                LireQuestion();
                return;
            }

            if (msg.toLowerCase() === "tools") {
                console.log("\n Tools disponibles :");
                TOUS_LES_TOOLS.forEach(t =>
                    console.log(`  - ${t.name}: ${t.description.slice(0, 70)}…`)
                );
                console.log();
                LireQuestion();
                return;
            }

            console.log("\n Agent réfléchit…\n");
            try {
                const response = await traiterMessage(msg);
                console.log(`\n Agent : ${response.text}\n`);
                console.log("-".repeat(60) + "\n");
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