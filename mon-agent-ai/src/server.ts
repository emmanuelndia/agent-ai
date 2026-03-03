import express, { Request, Response } from 'express';
import cors from 'cors';
import { traiterMessage } from './agent-complet';
import { contextManager } from './agent-complet';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. On active le middleware de base immédiatement
app.use(cors());
app.use(express.json());

// 2. ROUTE HEALTHCHECK PRIORITAIRE (Tout en haut)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 3. ON DÉMARRE L'ÉCOUTE MAINTENANT
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur Express démarré sur le port ${PORT}`);
});

// 4. ON IMPORTE LE RESTE APRÈS (Lazy Loading)
// On déplace les imports lourds ici ou on s'assure qu'ils ne bloquent pas
import { traiterMessage, contextManager } from './agent-complet';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};


// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', message: 'Agent AI Backend is running' });
});

// Context stats endpoint
app.get('/api/context/stats', (req: Request, res: Response) => {
  try {
    const stats = contextManager.getContextStats();
    res.json({
      status: 'OK',
      context: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get context stats' });
  }
});

// Clear context endpoint
app.post('/api/context/clear', async (req: Request, res: Response) => {
  try {
    await contextManager.clearContext();
    res.json({ 
      status: 'OK', 
      message: 'Context cleared successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear context' });
  }
});

// Chat endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    console.log(`[${new Date().toISOString()}] Received message: ${message}`);
    
    // Traiter le message avec l'agent LangChain
    const response = await traiterMessage(message);
    
    // Récupérer les statistiques de contexte
    const contextStats = contextManager.getContextStats();
    
    console.log(`[${new Date().toISOString()}] Agent response: ${response.substring(0, 100)}...`);
    console.log(`📊 Context stats: ${contextStats.totalMessages} msgs, ${contextStats.currentTokens} tokens`);
    
    res.json({
      response,
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
    res.status(500).json({ 
      error: 'Internal server error',
      message: (error as Error).message 
    });
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

export default app;
