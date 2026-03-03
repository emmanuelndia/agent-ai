import { traiterMessage, contextManager } from '../agent-complet';

async function testContextEngineering() {
  console.log('\n🧪 TEST D\'INGÉNIERIE DE CONTEXTE');
  console.log('='.repeat(60));

  const messages = [
    "Bonjour, je m'appelle Jean et je suis développeur",
    "Je travaille sur un projet avec LangChain",
    "Peux-tu m'aider à créer un agent IA?",
    "J'ai besoin de naviguer sur des sites web",
    "Je veux aussi gérer des fichiers",
    "Calcule pour moi 25 * 4",
    "Quel temps fait-il aujourd'hui?",
    "Rappelle-moi mon nom et ma profession",
    "Crée un fichier projet.txt avec 'Hello World'",
    "Navigue vers google.com",
    "Prends un screenshot",
    "Quel était le premier message que je t'ai envoyé?",
    "Résume notre conversation",
    "Combien de messages avons-nous échangés?",
    "Peux-tu me donner une liste de tous les outils que tu as?"
  ];

  console.log(`\n📝 Envoi de ${messages.length} messages pour tester le contexte...\n`);

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    console.log(`\n--- Message ${i + 1}/${messages.length} ---`);
    console.log(`💬 User: ${message}`);
    
    try {
      const startTime = Date.now();
      const response = await traiterMessage(message);
      const endTime = Date.now();
      
      console.log(`🤖 Agent: ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`);
      console.log(`⏱️  Temps: ${endTime - startTime}ms`);
      
      // Afficher les stats de contexte
      const stats = contextManager.getContextStats();
      console.log(`📊 Contexte: ${stats.totalMessages} msgs, ${stats.currentTokens} tokens, ${stats.summariesCount} résumés, compression: ${(1 - stats.compressionRatio) * 100}%`);
      
    } catch (error) {
      console.error(`❌ Erreur: ${(error as Error).message}`);
    }
    
    // Petite pause entre les messages
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 STATISTIQUES FINALES');
  console.log('='.repeat(60));
  
  const finalStats = contextManager.getContextStats();
  console.log(`Messages totaux: ${finalStats.totalMessages}`);
  console.log(`Tokens actuels: ${finalStats.currentTokens.toLocaleString()}`);
  console.log(`Nombre de résumés: ${finalStats.summariesCount}`);
  console.log(`Ratio de compression: ${((1 - finalStats.compressionRatio) * 100).toFixed(1)}%`);
  
  // Exporter le contexte complet pour analyse
  const fullContext = contextManager.exportFullContext();
  console.log(`\n📄 Export complet:`);
  console.log(`- Messages dans l'historique: ${fullContext.messages.length}`);
  console.log(`- Résumés générés: ${fullContext.summaries.length}`);
  
  // Afficher les derniers résumés
  if (fullContext.summaries.length > 0) {
    console.log(`\n📝 Derniers résumés:`);
    fullContext.summaries.slice(-2).forEach((summary, index) => {
      console.log(`Résumé ${index + 1}: ${summary.substring(0, 200)}...`);
    });
  }

  console.log('\n✅ Test d\'ingénierie de contexte terminé!');
}

// Test de performance avec beaucoup de messages
async function testPerformanceWithManyMessages() {
  console.log('\n🚀 TEST DE PERFORMANCE - 50 MESSAGES');
  console.log('='.repeat(60));

  const startTime = Date.now();
  
  for (let i = 0; i < 50; i++) {
    const message = `Message test numéro ${i + 1}: Ceci est un message de test pour vérifier la performance du système de gestion de contexte avec un grand nombre de messages.`;
    
    try {
      await traiterMessage(message);
      
      if ((i + 1) % 10 === 0) {
        const stats = contextManager.getContextStats();
        console.log(`📊 Après ${i + 1} messages: ${stats.currentTokens} tokens, compression: ${((1 - stats.compressionRatio) * 100).toFixed(1)}%`);
      }
    } catch (error) {
      console.error(`❌ Erreur au message ${i + 1}: ${(error as Error).message}`);
    }
  }
  
  const endTime = Date.now();
  const finalStats = contextManager.getContextStats();
  
  console.log('\n📈 Performance finale:');
  console.log(`⏱️  Temps total: ${(endTime - startTime) / 1000} secondes`);
  console.log(`📊 Messages traités: ${finalStats.totalMessages}`);
  console.log(`🗜️  Compression: ${((1 - finalStats.compressionRatio) * 100).toFixed(1)}%`);
  console.log(`📝 Résumés créés: ${finalStats.summariesCount}`);
}

// Test des différentes stratégies
async function testContextStrategies() {
  console.log('\n🎯 TEST DES STRATÉGIES DE CONTEXTE');
  console.log('='.repeat(60));
  
  // Test de nettoyage du contexte
  console.log('\n🧹 Test de nettoyage du contexte...');
  await contextManager.clearContext();
  
  const statsAfterClear = contextManager.getContextStats();
  console.log(`Après nettoyage: ${statsAfterClear.totalMessages} messages, ${statsAfterClear.currentTokens} tokens`);
  
  // Test avec quelques messages
  const testMessages = [
    "Premier message important",
    "Deuxième message avec des informations critiques",
    "Troisième message moins important",
    "Quatrième message avec des données utiles",
    "Cinquième message de test"
  ];
  
  for (const msg of testMessages) {
    await traiterMessage(msg);
  }
  
  const statsAfterMessages = contextManager.getContextStats();
  console.log(`Après 5 messages: ${statsAfterMessages.totalMessages} msgs, ${statsAfterMessages.currentTokens} tokens`);
  
  console.log('\n✅ Test des stratégies terminé!');
}

// Exécuter tous les tests
async function runAllTests() {
  try {
    await testContextEngineering();
    await testPerformanceWithManyMessages();
    await testContextStrategies();
    
    console.log('\n🎉 TOUS LES TESTS TERMINÉS AVEC SUCCÈS!');
    
  } catch (error) {
    console.error('\n❌ ERREUR LORS DES TESTS:', error);
  } finally {
    process.exit(0);
  }
}

// Lancer les tests
if (require.main === module) {
  runAllTests();
}

export { testContextEngineering, testPerformanceWithManyMessages, testContextStrategies };
