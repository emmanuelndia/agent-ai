# Agent IA Autonome

Agent IA autonome avec navigation web, gestion de fichiers et création de comptes automatiques.

## 🚀 Nouveauté : Sandbox E2B

**Exécution sécurisée dans le cloud !** L'agent peut maintenant utiliser une sandbox E2B pour :
- ✅ Navigation web sécurisée dans le cloud
- ✅ Pas d'installation locale de Chrome requise
- ✅ Isolation complète et sécurité
- ✅ Screenshots et automatisation depuis n'importe où

## 🚀 Installation

### Prérequis
- Node.js 18+
- npm ou yarn

### Installation
```bash
# Cloner le projet
git clone <votre-repo-url>
cd mon-agent-ai

# Installer les dépendances
npm install

# Configurer les clés API
cp .env.example .env
# Éditer .env avec vos clés API
```

### Configuration des clés API
Ajoutez vos clés dans le fichier `.env` :

```env
# Pour Google Gemini (recommandé)
GOOGLE_API_KEY=votre_clé_google_api_ici

# OU pour Groq (alternative)
GROQ_API_KEY=votre_clé_groq_ici

# Pour E2B Sandbox (navigation cloud sécurisée)
E2B_API_KEY=votre_clé_e2b_ici
```

**Obtenir les clés API :**
- **Google Gemini** : [AI Studio](https://aistudio.google.com/app/apikey)
- **Groq** : [groq.com](https://groq.com)
- **E2B** : [e2b.dev](https://e2b.dev) (crédits gratuits disponibles)

## 🎯 Utilisation

### Lancer l'agent
```bash
npm run agent
```

### Commandes disponibles
- `exit` : Quitter l'agent
- `reset` : Effacer la mémoire de conversation
- `tools` : Lister tous les outils disponibles

### Modes de navigation

#### 1. **Navigateur local (Playwright)**
```bash
Tu 💬 : Démarrer le navigateur local et va sur google.com
```
Tools : `demarrer_navigateur`, `aller_vers`, `cliquer`, `taper`, etc.

#### 2. **Sandbox E2B (Cloud)**
```bash
Tu 💬 : Démarrer la sandbox E2B et crée un compte sur automationexercise.com
```
Tools : `demarrer_sandbox`, `aller_vers_e2b`, `cliquer_e2b`, `taper_e2b`, etc.

### Exemples d'utilisation
```
Tu 💬 : Crée-moi un compte sur automationexercise.com avec la sandbox E2B
Tu 💬 : Recherche des informations sur le machine learning
Tu 💬 : Prends un screenshot de google.com
Tu 💬 : Génère un mot de passe sécurisé et sauvegarde-le
```

## 🛠️ Fonctionnalités

### Navigation Web
- **Navigateur local** : Playwright avec Chrome
- **Sandbox E2B** : Navigation cloud sécurisée
- **Automatisation** : Formulaires, clics, saisie
- **Screenshots** : Captures automatiques

### Gestion de données
- **Fichiers** : Lire, écrire, lister
- **Calculs** : Opérations mathématiques
- **Identifiants** : Sauvegarde sécurisée des comptes

### Sécurité
- **Sandbox isolée** : E2B pour navigation sécurisée
- **Pas de données locales** : Tout s'exécute dans le cloud
- **Screenshots locaux** : Uniquement les images sont sauvegardées

## 📁 Structure du projet

```
src/
├── agent-complet.ts          # Agent principal
├── tools.ts                  # Tools de base (calcul, fichiers)
├── browser/
│   ├── browser-manager.ts    # Gestion navigateur local
│   ├── browser-tools.ts      # Tools navigation locale
│   ├── e2b-sandbox.ts        # Gestion sandbox E2B
│   ├── e2b-tools.ts          # Tools navigation E2B
│   └── credentials.ts        # Gestion identifiants
└── tests/                    # Tests unitaires
```

## 🧪 Tests

```bash
# Tester les modèles LLM
npm run test:llm

# Tester les tools
npm run test:tools

# Tester le navigateur local
npm run test:browser
```

## 🔧 Configuration

### Changer de mode de navigation
Dans `src/agent-complet.ts`, modifiez les tools disponibles :

```typescript
// Uniquement navigateur local
const TOUS_LES_TOOLS = [...outilsDeBase, ...browserTools, ...credentialTools];

// Uniquement sandbox E2B
const TOUS_LES_TOOLS = [...outilsDeBase, ...e2bTools, ...credentialTools];

// Les deux (par défaut)
const TOUS_LES_TOOLS = [...outilsDeBase, ...browserTools, ...e2bTools, ...credentialTools];
```

### Modèles disponibles
- **Google** : `gemini-1.5-flash`, `gemini-1.5-pro`
- **Groq** : `llama-3.1-8b-instant`, `llama-3.1-70b-versatile`

## 🐛 Dépannage

### Problèmes courants
1. **Erreur 404 sur modèle Google** : Changez de modèle dans `src/agent-complet.ts`
2. **Limite de quota dépassée** : Utilisez Groq ou attendez le reset du quota
3. **Navigateur ne démarre pas** : Utilisez la sandbox E2B (pas d'installation locale)
4. **E2B ne fonctionne pas** : Vérifiez votre clé E2B_API_KEY

### Avantages E2B vs Playwright local
| Caractéristique | Playwright Local | E2B Sandbox |
|---|---|---|
| Installation | Chrome requis | Aucune installation |
| Sécurité | Exécution locale | Isolation cloud |
| Performance | Rapide (local) | Léger délai réseau |
| Déploiement | Complexe | Simple (cloud) |

## 📝 Notes

- L'agent utilise LangChain + LangGraph pour l'orchestration
- Playwright pour navigation locale, E2B pour navigation cloud
- Les screenshots sont sauvegardés dans `./screenshots/`
- Les identifiants sont stockés dans `./credentials.json`
- E2B offre 10 heures gratuites par mois

## 🤝 Contribuer

1. Fork le projet
2. Créer une branche `feature/nouvelle-fonction`
3. Commit et push
4. Pull request

## 📄 Licence

ISC
