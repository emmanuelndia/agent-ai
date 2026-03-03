#!/bin/bash

# Script de build pour Docker
set -e

echo "🔧 Création du dossier dist..."
mkdir -p dist

echo "📦 Installation des dépendances..."
npm install --include=dev

echo "🏗️ Compilation avec esbuild..."
npx esbuild src/server.ts --bundle --platform=node --target=node20 --outfile=dist/server.js --external:@e2b/code-interpreter --external:@google/generative-ai --external:@langchain/* --external:playwright --external:express --external:cors --external:dotenv --main-fields=main,module

echo "✅ Build terminé !"
ls -la dist/
