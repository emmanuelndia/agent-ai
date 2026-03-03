import { ChatGroq } from "@langchain/groq";
import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import { BaseMessage } from "@langchain/core/messages";
import { outilsDeBase } from "../tools";
import * as dotenv from "dotenv";

dotenv.config();

async function testerTools() {
    console.log("Test des outils de base...\n");

    const llm = new ChatGroq({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
    }).bindTools(outilsDeBase);

    //Créer le dictionnaire des Tools
    const toolMap: Record<string, any> = Object.fromEntries(outilsDeBase.map((t) => [t.name, t]));

    async function poserQuestion(question: string){
        console.log(`\n Question : ${question}`);
        const messages: BaseMessage[] = [
            new HumanMessage(question),
        ];

        // Boucle agent simple
        while(true) {
            const rep = await llm.invoke(messages);
            messages.push(rep);

            if(!rep.tool_calls?.length) {
                console.log(`Réponse: ${rep.content}`);
                break;
            }

            for (const tc of rep.tool_calls) {
                console.log(`Appel tool : ${tc.name}(${JSON.stringify(tc.args)})`);
                const tool = toolMap[tc.name];
                if (tool) {
                    const resultat = await tool.invoke(tc.args as any);
                    console.log(`Résultat : ${resultat}`);
                    messages.push(new ToolMessage({tool_call_id: tc.id!, content: String(resultat)}));
                }
            }
        }
    }

    await poserQuestion("Combien font 2 puissance 20 ?");
    await poserQuestion("Écris 'Bonjour monde !' dans le fichier ./data/test.txt");
    await poserQuestion("Lis le fichier ./data/test.txt");
    await poserQuestion("Quelle heure est-il ?"); 
    
    console.log("\n Tous les tools fonctionnent !");
}

testerTools().catch(console.error);

