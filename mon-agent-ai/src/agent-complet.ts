import { ChatGroq } from "@langchain/groq";

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import { StateGraph, Annotation, END, START } from "@langchain/langgraph";

import { ToolNode } from "@langchain/langgraph/prebuilt";

import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";

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



// Configuration du contexte avancé

const contextConfig: ContextConfig = {

  maxTokens: 28000, // Laisse de la marge pour Gemini 2.5 Flash (32k max)

  compressionThreshold: 0.75, // Compresser à 75% de la limite

  summaryInterval: 8, // Résumer toutes les 8 interactions

  keepLastNMessages: 4 // Toujours garder les 4 derniers messages

};



// Gestionnaire de contexte avancé

const contextManager = new AdvancedContextManager(contextConfig);



// Tous les tools disponibles pour l'agent (Playwright local + E2B sandbox)

const TOUS_LES_TOOLS = [...outilsDeBase, ...browserTools, ...e2bTools, ...credentialTools, ...debugTools];



// Le cerveau de l'agent (Google Generative AI)

const llm = new ChatGoogleGenerativeAI({

    model: "gemini-2.5-flash", // Modèle correct

    temperature: 0, // 0 = plus précis, 1 = plus créatif

    apiKey: process.env.GOOGLE_API_KEY,

    maxRetries: 3,

}).bindTools(TOUS_LES_TOOLS);



// Ancienne mémoire conservée pour compatibilité

const memoireConversation = new InMemoryChatMessageHistory();



// Prompt système de l'agent

const SYSTEME_PROMPT = `Tu es un agent IA autonome et expert. Tu aides l'utilisateur via un terminal.

                        TES CAPACITES: 

                            1. Calcul mathématique (tool: calculer)

                            2. Gestion de fichiers : lire, écrire, lister (tools: lire_fichier, ecrire_fichier, lister_fichiers)

                            3. Navigation web avec un vrai navigateur Chrome (tools: browser_*)

                                - Naviguer vers les URLs

                                - Cliquer sur des éléments, remplir des formulaires

                                - Créer des comptes sur des sites

                                - Prendre des screenshots

                            4. Gestion d'identifiants (tools: credential_*)

                                - Générer des mots de passe forts

                                - Sauvegarder les identifiants après inscription

                                - Retrouver des identifiants sauvegardés

                            5. Obtenir la date/heure    

                                

                        REGLES IMPORTANTES : 

                            - Décompose les tâches complexes en étapes simples

                            - Prends un screenshot AVANT ET APRES chaque action importante

                            - Après tout formulaire rempli, lis la page pour vérifier le succès

                            - TOUJOURS sauvegarder les identifiants après création de compte

                            - Si tu ne trouves pas un bouton par texte, lis le HTML pour trouver le sélecteur

                            - Informe l'utilisateur de chaque étape accomplie

                            - En cas d'erreur, prends un screenshot et analyse la page

                            - Sois PATIENT et attends que les éléments soient visibles

                        

                        SÉLECTEURS IMPORTANTS :

                            - Google recherche : 'input[name=q]' ou 'textarea[name=q]'

                            - Google bouton recherche : 'input[name=btnK]' ou clic sur "Rechercher"

                            - Formulaires généraux : 'input[type=text]', 'input[type=email]', 'input[type=password]'

                            - Boutons : utilise le texte visible quand possible

                        

                        POUR LA NAVIGATION :

                            1. Démarrer le navigateur (si pas déjà fait)

                            2. Aller vers l'URL

                            3. Attendre 2-3 secondes que la page charge

                            4. Lire la page pour comprendre la structure

                            5. Agir (cliquer, taper, etc.)

                            6. Attendre le chargement

                            7. Vérifier le résultat (screenshot ou lire_page)`;







// GRAPHE LANGGRAPH          

const EtatAgent = Annotation.Root({

    messages: Annotation<BaseMessage[]>({

        reducer: (ancien, nouveau) => [...ancien, ...nouveau],

        default: () => [],

    }),

});



// NOEUD LLM : REFLECHIT ET DECIDE QUOI FAIRE

async function noeudLLM(etat: typeof EtatAgent.State) {

    // Utiliser le gestionnaire de contexte avancé

    const optimizedContext = await contextManager.getOptimizedContext(SYSTEME_PROMPT);

    

    // Ajouter les messages actuels de l'état

    const allMessages = [

        ...optimizedContext,

        ...etat.messages,

    ];



    // Afficher les stats de contexte pour debugging

    const stats = contextManager.getContextStats();

    console.log(`📊 Contexte: ${stats.totalMessages} messages, ${stats.currentTokens} tokens, compression: ${(1 - stats.compressionRatio) * 100}%`);



    const reponse = await llm.invoke(allMessages);

    return {messages: [reponse]};

}



// DECISION : APPELER UN TOOL OU TERMINER ?

function decider(etat: typeof EtatAgent.State): string {

    const dernier = etat.messages.at(-1) as AIMessage;

    if (!dernier.tool_calls?.length) return END;

    return "tools";

}





// CONSTRUIRE LE GRAPHE

const graphe = new StateGraph(EtatAgent)

    .addNode("llm", noeudLLM)

    .addNode("tools", new ToolNode(TOUS_LES_TOOLS))

    .addEdge(START, "llm")

    .addConditionalEdges("llm", decider)

    .addEdge("tools", "llm")

    .compile();





// INTERFACE TERMINAL

export async function traiterMessage(messageUtilisateur: string): Promise<string> {

    const messageEntrant = new HumanMessage(messageUtilisateur);



    // Ajouter le message au gestionnaire de contexte

    await contextManager.addMessage(messageEntrant);



    // Invoquer le graphe

    const resultat = await graphe.invoke({

        messages: [messageEntrant],

    });



    const reponseFinale = resultat.messages.at(-1);

    const contenu = String(reponseFinale?.content ?? "Pas de réponse.");



    // Ajouter la réponse au gestionnaire de contexte

    await contextManager.addMessage(new AIMessage(contenu));



    // Maintenir la compatibilité avec l'ancien système

    await memoireConversation.addUserMessage(messageUtilisateur);

    await memoireConversation.addAIMessage(contenu);



    // Afficher les statistiques de contexte

    const stats = contextManager.getContextStats();

    console.log(`💾 Mémoire: ${stats.totalMessages} msgs, ${stats.currentTokens} tokens, ${stats.summariesCount} résumés`);



    return contenu;

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



// Lancer l'agent

demarrerInterface().catch(console.error);