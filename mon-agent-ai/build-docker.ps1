# Script de build PowerShell pour Docker
Write-Host "🔧 Création du dossier dist..." -ForegroundColor Green
New-Item -ItemType Directory -Force -Path "dist" | Out-Null

Write-Host "📦 Installation des dépendances..." -ForegroundColor Green  
npm install --include=dev

Write-Host "🏗️ Compilation avec esbuild..." -ForegroundColor Green
npx esbuild src/server.ts --bundle --platform=node --target=node20 --outfile=dist/server.js --external:@e2b/code-interpreter --external:@google/generative-ai --external:@langchain/* --external:playwright --external:express --external:cors --external:dotenv --main-fields=main,module

Write-Host "✅ Build terminé !" -ForegroundColor Green
Get-ChildItem -Path "dist" | Format-Table
