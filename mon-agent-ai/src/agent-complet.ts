import { ChatGroq } from "@langchain/groq";

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import { StateGraph, Annotation, END, START } from "@langchain/langgraph";

import { ToolNode } from "@langchain/langgraph/prebuilt";

import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

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
  keepLastNMessages: 4
};

// Tous les tools disponibles pour l'agent (Playwright local + E2B sandbox)
const TOUS_LES_TOOLS = [...outilsDeBase, /* ...browserTools,  *//* ...e2bTools, ...credentialTools, ...debugTools */];

// Le cerveau de l'agent (Google Generative AI)
const llm = new ChatGroq({
    model: "llama-3.3-70b-versatile", // Ou ChatGroq llama-3.1-70b GROQ_API_KEY ou ChatGoogleGenerativeAI gemini-2.5-flash gemini-3-flash-preview GOOGLE_API_KEY
    cache: new InMemoryCache(),
    temperature: 0, // 0 = plus précis, 1 = plus créatif
    apiKey: process.env.GROQ_API_KEY,
    maxRetries: 5,
}).bindTools(TOUS_LES_TOOLS);


// Gestionnaire de contexte avancé
export const contextManager = new AdvancedContextManager(contextConfig, llm);


// Ancienne mémoire conservée pour compatibilité

const memoireConversation = new InMemoryChatMessageHistory();



// SYSTEM_PROMPT
const SYSTEME_PROMPT = `Tu es un expert IA autonome. Aide l'utilisateur via terminal.

CAPACITÉS :
- Calculs, Fichiers (lire/écrire/lister), Navigation Web (Chrome/E2B), Identifiants (générer/sauver).

RÈGLES D'OR :
1. ÉCONOMIE : Utilise TOUJOURS 'remplir_formulaire' pour saisir plusieurs infos sur une page (ex: inscription).
2. NAVIGATION : Start browser -> URL -> Wait 2s -> Read page -> Act -> Verify (screenshot/read).
3. SÉCURITÉ : Sauvegarde systématiquement les identifiants après une création de compte.
4. PRÉCISION : Prends un screenshot AVANT/APRÈS chaque action clé. Vérifie le succès après chaque formulaire.
5. PATIENCE : Attends que les éléments soient visibles. En cas d'erreur, analyse via screenshot.

SÉLECTEURS :
- Google : 'input[name=q]', 'textarea[name=q]'.
- Formulaires : 'input[type=text|email|password]'. Priorise le texte visible pour les boutons.`

         

// GRAPHE LANGGRAPH
const EtatAgent = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (ancien, nouveau) => [...ancien, ...nouveau],
        default: () => [],
    }),
});



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
        
        const reponse = await llm.invoke(allMessages);
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
    console.log("decider - dernier message type:", dernierMessage?.constructor.name);
    if (dernierMessage instanceof AIMessage && dernierMessage.tool_calls?.length) {
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
export async function traiterMessage(messageUtilisateur: string): Promise<string> {
    try {
        const messageEntrant = new HumanMessage(messageUtilisateur);
        await contextManager.addMessage(messageEntrant);
        const resultat = await graphe.invoke({ messages: [messageEntrant] }, { recursionLimit: 100 });
        const reponseFinale = resultat.messages.at(-1);
        let contenu = String(reponseFinale?.content ?? "Pas de réponse.");
        if (!contenu.trim()) {
            contenu = "[L'agent n'a pas généré de réponse textuelle. Il a peut-être utilisé des outils.]";
        }
        await contextManager.addMessage(new AIMessage(contenu));
        return contenu;
    } catch (error) {
        console.error("❌ Erreur dans traiterMessage:", error);
        const fallback = "Désolé, une erreur interne est survenue.";
        await contextManager.addMessage(new AIMessage(fallback));
        return fallback;
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
/* async function executerModeConsole() {
  try {
    await demarrerInterface();
  } catch (error) {
    console.error("Erreur interface console:", error);
  }
} */


// Lancer l'agent

// On ne lance l'interface console QUE si on exécute ce fichier directement
// (ex: npx ts-node src/agent-complet.ts)
// Si c'est server.ts qui l'importe, cette partie sera ignorée.
/* if (require.main === module) {
    executerModeConsole();
} */