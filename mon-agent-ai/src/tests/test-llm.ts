import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import * as dotenv from "dotenv";

dotenv.config();

/* async function testerGroq(){
    console.log("Test du modèle Groq...");

    const llm = new ChatGroq({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        apiKey: process.env.GROQ_API_KEY
    });

    // Test 1 : Appel Simple
    console.log("=== Test 1 : Appel simple ===\n");
    const rep1 = await llm.invoke("Dis bonjour en 5 langues différentes.");
    console.log(rep1.content);

    // Test 2 : Avec Système
    console.log("\n=== Test 2 : Avec système ===");
    const rep2 = await llm.invoke([
        new SystemMessage("Tu es en développeur TypeScript expert. Réponds de façon très concise"),
        new HumanMessage("C'est quoi un générique en TypeScript ? Donne un exemple."),
    ]);
    console.log(rep2.content);

    // Test 3 : Streaming 
    console.log("\n=== Test 3 : Streaming");
    process.stdout.write("Réponse stream : ");
    const stream = await llm.stream("Compte de 1 à 5 en lettres.");
    for await (const chunk of stream) {
        process.stdout.write(chunk.content as string);
    }
    console.log("\n");

    // Test 4 : Tokens utilisés
    console.log("=== Test 4 : Métadonnées ===");
    const rep4 = await llm.invoke("Bonjour :");
    console.log("Tokens :", rep4.usage_metadata);   
    console.log("Modèle :", rep4.response_metadata);
    
    console.log("\n Groq fonctionne parfaitement !");

} */

async function testerGemini(){
    console.log("Test du modèle Gemini...");

    const llm = new ChatGoogleGenerativeAI({
        model: "gemini-1.5-flash", // Modèle standard
        temperature: 0,
        apiKey: process.env.GOOGLE_API_KEY,
        apiVersion: "v1",
    });

    // Test 1 : Appel Simple
    console.log("=== Test 1 : Appel simple ===\n");
    const rep1 = await llm.invoke("Dis bonjour en 5 langues différentes.");
    console.log(rep1.content);

    // Test 2 : Avec Système
    console.log("\n=== Test 2 : Avec système ===");
    const rep2 = await llm.invoke([
        new SystemMessage("Tu es en développeur TypeScript expert. Réponds de façon très concise"),
        new HumanMessage("C'est quoi un générique en TypeScript ? Donne un exemple."),
    ]);
    console.log(rep2.content);

    // Test 3 : Streaming 
    console.log("\n=== Test 3 : Streaming");
    process.stdout.write("Réponse stream : ");
    const stream = await llm.stream("Compte de 1 à 5 en lettres.");
    for await (const chunk of stream) {
        process.stdout.write(chunk.content as string);
    }
    console.log("\n");

    // Test 4 : Tokens utilisés
    console.log("=== Test 4 : Métadonnées ===");
    const rep4 = await llm.invoke("Bonjour :");
    console.log("Tokens :", rep4.usage_metadata);   
    console.log("Modèle :", rep4.response_metadata);
    
    console.log("\n Gemini fonctionne parfaitement !");

}



/* testerGroq().catch(console.error); */
testerGemini().catch(console.error);