import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Déclaration des variables qui contiendront l'agent
let traiterMessage: (message: string) => Promise<string>;
let contextManager: any;
let agentReady = false;
let agentLoadingPromise: Promise<void>;

// Fonction de chargement de l'agent
async function loadAgent() {
  try {
    // Utilisation de import() dynamique (compatible ES module)
    const agent = await import('./agent-complet.js');
    traiterMessage = agent.traiterMessage;
    contextManager = agent.contextManager;
    agentReady = true;  
    console.log("✅ Logique IA chargée avec succès");
  } catch (err) {
    console.error("❌ Erreur chargement IA:", err);
    agentReady = false;
  }
}

// Démarrer le chargement immédiatement (sans bloquer le démarrage du serveur)
agentLoadingPromise = loadAgent();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Route healthcheck immédiate (ne dépend pas de l'agent)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', loading: !agentReady });
});

// Route principale
app.get('/', (req, res) => {
  res.send('<h1>🚀 Agent AI Backend est en ligne !</h1>');
});

/* // 3. ON DÉMARRE L'ÉCOUTE MAINTENANT
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur prêt sur le port ${PORT}`);
  
  // On charge l'IA SEULEMENT APRÈS que le serveur soit en ligne
  try {
    const agent = require('./agent-complet');
    traiterMessage = agent.traiterMessage;
    contextManager = agent.contextManager;
    console.log("✅ Logique IA chargée avec succès");
  } catch (err) {
    console.error("❌ Erreur chargement IA:", err);
  }
}); */

// Middleware pour s'assurer que l'agent est prêt avant les routes qui en ont besoin
async function ensureAgentReady(req: Request, res: Response, next: Function) {
  if (!agentReady) {
    // On attend que le chargement soit fini (jusqu'à 10s)
    try {
      await Promise.race([
        agentLoadingPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout chargement agent')), 10000))
      ]);
    } catch (err) {
      return res.status(503).json({ error: 'Agent non disponible, veuillez réessayer plus tard' });
    }
  }
  next();
}


// 4. ON IMPORTE LE RESTE APRÈS (Lazy Loading)
// On déplace les imports lourds ici ou on s'assure qu'ils ne bloquent pas
/* const { traiterMessage, contextManager } = require('./agent-complet'); */

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};




// Appliquer le middleware aux routes qui utilisent l'agent
app.use('/api', ensureAgentReady);


// Routes API
app.get('/api/context/stats', (req: Request, res: Response) => {
  try {
    const stats = contextManager.getContextStats();
    res.json({ status: 'OK', context: stats, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get context stats' });
  }
});

app.post('/api/context/clear', async (req: Request, res: Response) => {
  try {
    await contextManager.clearContext();
    res.json({ status: 'OK', message: 'Context cleared successfully', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear context' });
  }
});

// Chat endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    console.log(`[${new Date().toISOString()}] Received message: ${message}`);
    
    // ✅ FIX : traiterMessage retourne maintenant { text, screenshot? }
    const agentResponse = await traiterMessage(message);
    
    console.log(`[${new Date().toISOString()}] Agent response text: "${agentResponse.text}"`);
    console.log(`[${new Date().toISOString()}] Screenshot present: ${!!agentResponse.screenshot}`);
    
    const contextStats = contextManager.getContextStats();
    
    res.json({
      response: agentResponse.text,
      screenshot: agentResponse.screenshot ?? null, // ✅ Transmis séparément au frontend
      context: {
        totalMessages: contextStats.totalMessages,
        currentTokens: contextStats.currentTokens,
        summariesCount: contextStats.summariesCount,
        compressionRatio: Math.round((1 - contextStats.compressionRatio) * 100)
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({ error: 'Internal server error', message: (error as Error).message });
  }
});

/* // Démarrer le serveur
app.listen(PORT, () => {
  console.log(`\n🚀 Agent AI Backend Server is running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`💬 Chat endpoint: http://localhost:${PORT}/api/chat`);
  console.log(`📊 Context stats: http://localhost:${PORT}/api/context/stats`);
  console.log(`🧹 Clear context: POST http://localhost:${PORT}/api/context/clear`);
  console.log(`🔧 CORS enabled for frontend communication\n`);
}); */

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// Démarrage du serveur
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur prêt sur le port ${PORT}`);
});

export default app;
