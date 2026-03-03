#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Lecture du fichier .env actuel
const envPath = path.join(__dirname, '..', '.env');
const envExamplePath = path.join(__dirname, '..', '.env.example');

function switchLLM(provider) {
  console.log(`🔄 Basculement vers ${provider}...`);
  
  if (!fs.existsSync(envPath)) {
    console.log('❌ Fichier .env non trouvé. Copiez .env.example vers .env');
    return;
  }
  
  let envContent = fs.readFileSync(envPath, 'utf8');
  
  // Commenter toutes les clés API
  envContent = envContent.replace(/^(GOOGLE_API_KEY|GROQ_API_KEY)=/gm, '#$&=');
  
  // Décommenter seulement la clé choisie
  switch (provider.toLowerCase()) {
    case 'google':
    case 'gemini':
      envContent = envContent.replace(/^#GOOGLE_API_KEY=/m, 'GOOGLE_API_KEY=');
      console.log('✅ Google Gemini activé');
      break;
      
    case 'groq':
    case 'llama':
      envContent = envContent.replace(/^#GROQ_API_KEY=/m, 'GROQ_API_KEY=');
      console.log('✅ Groq activé');
      break;
      
    default:
      console.log('❌ Provider non reconnu. Utilisez: google ou groq');
      return;
  }
  
  fs.writeFileSync(envPath, envContent);
  console.log('🔧 Fichier .env mis à jour');
  console.log('📝 Redémarrez le serveur pour appliquer les changements');
}

function showCurrentConfig() {
  if (!fs.existsSync(envPath)) {
    console.log('❌ Fichier .env non trouvé');
    return;
  }
  
  const envContent = fs.readFileSync(envPath, 'utf8');
  const googleActive = envContent.includes('\nGOOGLE_API_KEY=') && !envContent.includes('\n#GOOGLE_API_KEY=');
  const groqActive = envContent.includes('\nGROQ_API_KEY=') && !envContent.includes('\n#GROQ_API_KEY=');
  
  console.log('📊 Configuration actuelle:');
  console.log(`  Google Gemini: ${googleActive ? '✅ Actif' : '❌ Inactif'}`);
  console.log(`  Groq: ${groqActive ? '✅ Actif' : '❌ Inactif'}`);
  
  if (!googleActive && !groqActive) {
    console.log('⚠️  Aucun provider activé!');
  }
}

// Command line interface
const command = process.argv[2];
const provider = process.argv[3];

switch (command) {
  case 'switch':
    if (!provider) {
      console.log('Usage: node switch-llm.js switch <google|groq>');
      process.exit(1);
    }
    switchLLM(provider);
    break;
    
  case 'status':
  case 'show':
    showCurrentConfig();
    break;
    
  default:
    console.log('Usage:');
    console.log('  node switch-llm.js switch <google|groq>  - Changer de provider');
    console.log('  node switch-llm.js status              - Voir la configuration actuelle');
    console.log('');
    console.log('Exemples:');
    console.log('  node switch-llm.js switch groq');
    console.log('  node switch-llm.js switch google');
    console.log('  node switch-llm.js status');
    break;
}
