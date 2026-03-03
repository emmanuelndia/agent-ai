import dotenv from 'dotenv';
import { ChatGroq } from '@langchain/groq';

dotenv.config();

console.log('🔑 Clés API détectées:');
console.log(`GROQ_API_KEY: ${process.env.GROQ_API_KEY ? '✅ Présente' : '❌ Absente'}`);
console.log(`GOOGLE_API_KEY: ${process.env.GOOGLE_API_KEY ? '✅ Présente' : '❌ Absente'}`);

async function testGroq() {
  try {
    console.log('\n🧪 Test de connexion à Groq...');
    
    const llm = new ChatGroq({
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      apiKey: process.env.GROQ_API_KEY,
      maxRetries: 2,
    });

    const response = await llm.invoke([
      { role: 'user', content: 'Bonjour, réponds simplement "Groq fonctionne!"' }
    ]);

    console.log('✅ Groq fonctionne!');
    console.log('Réponse:', response.content);
    
  } catch (error) {
    console.error('❌ Erreur Groq:', error.message);
  }
}

testGroq();
