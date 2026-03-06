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



// CONFIGURATION
const contextConfig: ContextConfig = {
  maxTokens: 28000,
  compressionThreshold: 0.75,
  summaryInterval: 8,
  keepLastNMessages: 6
};

// Tous les tools disponibles pour l'agent (Playwright local + E2B sandbox)
const TOUS_LES_TOOLS = [...outilsDeBase, /* ...browserTools,  */...e2bTools, ...credentialTools, ...debugTools];

// Le cerveau de l'agent (Google Generative AI)
const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.0-flash", // Ou ChatGroq llama-3.1-70b GROQ_API_KEY ou ChatGoogleGenerativeAI gemini-2.5-flash gemini-3-flash-preview GOOGLE_API_KEY
    cache: new InMemoryCache(),
    temperature: 0, // 0 = plus précis, 1 = plus créatif
    apiKey: process.env.GOOGLE_API_KEY,
    maxRetries: 5,
}).bindTools(TOUS_LES_TOOLS);


// Gestionnaire de contexte avancé
export const contextManager = new AdvancedContextManager(contextConfig, llm);


// Ancienne mémoire conservée pour compatibilité

const memoireConversation = new InMemoryChatMessageHistory();



// SYSTEM_PROMPT
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
- Formulaires : privilégie les sélecteurs par texte pour les boutons (ex: { "selector": "button:has-text('Se connecter')" } ).`
         

// GRAPHE LANGGRAPH
const EtatAgent = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (ancien, nouveau) => [...ancien, ...nouveau],
        default: () => [],
    }),
});


// Ajoute un délai minimum entre chaque appel LLM pour ne jamais dépasser la limite
class RateLimiter {
    private lastCallTime = 0;
    private minDelay: number;

    constructor(requestsPerMinute: number) {
        this.minDelay = (60 / requestsPerMinute) * 1000;
    }

    async wait() {
        const now = Date.now();
        const elapsed = now - this.lastCallTime;
        if (elapsed < this.minDelay) {
            const wait = this.minDelay - elapsed;
            console.log(`🕒 Rate limiter: attente ${Math.round(wait)}ms...`);
            await sleep(wait);
        }
        this.lastCallTime = Date.now();
    }
}


// Crée une instance du rate limiter avec 25 requêtes par minute (sécurité supplémentaire)
const rateLimiter = new RateLimiter(25);


// NOEUD LLM : REFLECHIT ET DECIDE QUOI FAIRE
async function noeudLLM(etat: typeof EtatAgent.State) {
    console.log("📥 Entrée dans noeudLLM. Nombre de messages:", etat.messages.length);
    const dernier = etat.messages.at(-1);
    if (dernier instanceof ToolMessage) {
        console.log("🔧 Dernier message est un ToolMessage, contenu:", dernier.content);
    }
    try {
        
        const optimizedContext = await contextManager.getOptimizedContext(SYSTEME_PROMPT);
        const allMessages = [...optimizedContext, ...etat.messages];
        const stats = contextManager.getContextStats();
        console.log(`📊 Contexte: ${stats.totalMessages} messages, ${stats.currentTokens} tokens, compression: ${(1 - stats.compressionRatio) * 100}%`);
        
        await rateLimiter.wait(); 
        const reponse = await llm.invoke(allMessages);
        console.log("📤 Réponse LLM brute:", JSON.stringify(reponse, null, 2));
        return { messages: [reponse] };
    } catch (error) {
        console.error("❌ Erreur dans noeudLLM:", error);
        const errorMessage = new AIMessage(`Désolé, une erreur technique est survenue avec le modèle : ${(error as Error).message}`);
        return { messages: [errorMessage] };
    }
}



// NOEUD D'OUTILS
const toolNode = new ToolNode(TOUS_LES_TOOLS);
console.log(toolNode);

// DECISION : APPELER UN TOOL OU TERMINER ?
function decider(etat: typeof EtatAgent.State): string {
    const dernierMessage = etat.messages.at(-1);
    console.log("decider - dernier message complet:", JSON.stringify(dernierMessage, (key, value) => 
    typeof value === 'function' ? undefined : value, 2));
    
    // Vérification robuste de la présence de tool_calls
    const hasToolCalls = 
        (dernierMessage?.tool_calls && dernierMessage.tool_calls.length > 0) ||
        (dernierMessage?.additional_kwargs?.tool_calls && dernierMessage.additional_kwargs.tool_calls.length > 0) ||
        ((dernierMessage as any)?.kwargs?.tool_calls && (dernierMessage as any).kwargs.tool_calls.length > 0);

    if (hasToolCalls) {
        console.log("decider - tool_calls détectés, direction tools");
        return "tools";
    }
    console.log("decider - pas de tool_calls, direction END");
    return END;
}




// CONSTRUIRE LE GRAPHE
const graphe = new StateGraph(EtatAgent)
    .addNode("llm", noeudLLM)
    .addNode("tools", toolNode)
    .addEdge(START, "llm")
    .addConditionalEdges("llm", decider)
    .addEdge("tools", "llm")
    .compile();





// INTERFACE TERMINAL
export interface AgentResponse {
    text: string;
    screenshot?: string; // data:image/png;base64,... si un screenshot a été pris
}

export async function traiterMessage(messageUtilisateur: string): Promise<AgentResponse> {
    try {
        const messageEntrant = new HumanMessage(messageUtilisateur);
        await contextManager.addMessage(messageEntrant);
        const resultat = await graphe.invoke({ messages: [messageEntrant] }, { recursionLimit: 100 });

        // ✅ FIX : Scanner TOUS les messages pour trouver le screenshot le plus récent.
        // Le dernier message est toujours un AIMessage (LangGraph repasse par le LLM
        // après chaque tool), donc on ne peut pas se fier uniquement au dernier message.
        let screenshotData: string | undefined;
        for (const msg of resultat.messages) {
            if (
                msg instanceof ToolMessage &&
                typeof msg.content === 'string' &&
                msg.content.startsWith('data:image')
            ) {
                screenshotData = msg.content; // on garde le dernier screenshot trouvé
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



async function demarrerInterface() {

    console.log("\n" + "=".repeat(60));

    console.log(" AGENT IA AUTONOME - LangChain + Google Gemini + Playwright ");

    console.log("=".repeat(60));

    console.log("Modèle : gemini-1.5-flash (Google Generative AI)");

    console.log(" Tools    : Fichiers, Calcul, Navigateur, Credentials");

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



            if(!msg) {

                LireQuestion();

                return;

            }



            // Commandes spéciales

            if (msg.toLowerCase() === "exit") {

                console.log("\n Fermeture...");

                await navigateur.fermer();

                await e2bSandbox.fermer();

                rl.close();

                process.exit(0);

            }



            if (msg.toLowerCase() === "reset") {

                await memoireConversation.clear();

                console.log(" Memoire effacée.\n");

                LireQuestion();

                return;

            }



            if (msg.toLowerCase() === "tools") {

                console.log("\n Tools disponibles :");

                TOUS_LES_TOOLS.forEach((t) => console.log(`- ${t.name}: ${t.description.slice(0, 60)}...`));

                console.log();

                LireQuestion();

                return;

            }



            // Traiter avec l'agent

            console.log("\n Agent réfléchit...\n");



            try {

                const response = await traiterMessage(msg);

                console.log(`\n Agent : ${response}\n`);

                console.log("-".repeat(60) + "\n");

            } catch (error) {

                console.error(`Erreur : ${(error as Error).message}\n`);

            }

            LireQuestion();

        });

    };

    LireQuestion();

}



// --- SECTION DE DÉMARRAGE ---

// On définit une fonction pour lancer la console
async function executerModeConsole() {
  try {
    await demarrerInterface();
  } catch (error) {
    console.error("Erreur interface console:", error);
  }
}


// Lancer l'agent

// On ne lance l'interface console QUE si on exécute ce fichier directement
// (ex: npx ts-node src/agent-complet.ts)
// Si c'est server.ts qui l'importe, cette partie sera ignorée.
if (require.main === module) {
    executerModeConsole();
}