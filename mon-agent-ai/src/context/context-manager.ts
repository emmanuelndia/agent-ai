import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { getEncoding } from "js-tiktoken";

export interface ContextWindow {
  messages: BaseMessage[];
  totalTokens: number;
  maxTokens: number;
  summary?: string;
  compressedMessages: BaseMessage[];
}

export interface ContextConfig {
  maxTokens: number;
  compressionThreshold: number;
  summaryInterval: number;
  keepLastNMessages: number;
}

// Initialisation de l'encodeur (en dehors de la classe pour ne le faire qu'une fois)
const encoder = getEncoding("cl100k_base");

export class AdvancedContextManager {
  private contextHistory: BaseMessage[] = [];
  private summaries: string[] = [];
  private currentWindow: ContextWindow;
  private config: ContextConfig;
  private llm: ChatGroq | ChatGroq;
  private messageHistory: InMemoryChatMessageHistory;

  constructor(config: Partial<ContextConfig> = {}, llmInstance?: ChatGroq | ChatGroq) {
    this.config = {
      maxTokens: 32000, // Limite pour les modèles
      compressionThreshold: 0.8, // Compresser à 80% de la limite
      summaryInterval: 10, // Résumer toutes les 10 interactions
      keepLastNMessages: 5, // Toujours garder les 5 derniers messages
      ...config
    };

    // Utiliser l'instance LLM fournie ou en créer une selon la clé API disponible
    if (llmInstance) {
      this.llm = llmInstance;
    } else if (process.env.GROQ_API_KEY) {
      this.llm = new ChatGroq({
        model: "llama-3.1-70b-versatile", // Modèle actuel pour les résumés
        temperature: 0.1,
        apiKey: process.env.GROQ_API_KEY,
        maxRetries: 2,
      });
    } else {
      throw new Error("Aucune clé API GROQ trouvée. Veuillez configurer GROQ_API_KEY");
    }

    this.messageHistory = new InMemoryChatMessageHistory();
    
    this.currentWindow = {
      messages: [],
      totalTokens: 0,
      maxTokens: this.config.maxTokens,
      compressedMessages: []
    };
  }

  /**
   * Estime le nombre de tokens pour un message
   */
  private estimateTokens(message: BaseMessage | string): number {
    let content = "";
    
    if (typeof message === "string") {
      content = message;
    } else {
      // Gérer le contenu textuel du message
      content = String(message.content);
      
      // OPTIMISATION : Si le message contient des images (multimodal), 
      // il faut ajouter un forfait de tokens fixe (Gemini compte environ 258 tokens par image)
      if (Array.isArray(message.content)) {
        let total = 0;
        for (const part of message.content) {
          if (typeof part === 'object' && part !== null && 'type' in part) {
            if (part.type === "text" && 'text' in part) {
              total += encoder.encode(String(part.text)).length;
            } else if (part.type === "image_url") {
              total += 258; // Forfait standard pour Gemini
            }
          }
        }
        return total;
      }
    }

    // Encodage et comptage précis
    const tokens = encoder.encode(content);
    return tokens.length;
  }

  private calculateTotalTokens(messages: BaseMessage[]): number {
    return messages.reduce((total, msg) => total + this.estimateTokens(msg), 0);
  }


  /**
   * Ajoute un message au contexte avec gestion intelligente
   */
  async addMessage(message: BaseMessage): Promise<void> {
    const tokens = this.estimateTokens(message);
    
    // Ajouter à l'historique complet
    this.contextHistory.push(message);
    await this.messageHistory.addMessage(message);

    // Vérifier si nous dépassons la limite
    if (this.currentWindow.totalTokens + tokens > this.config.maxTokens * this.config.compressionThreshold) {
      await this.compressContext();
    }

    // Ajouter le message
    this.currentWindow.messages.push(message);
    this.currentWindow.totalTokens += tokens;

    // Résumé périodique
    if (this.contextHistory.length % this.config.summaryInterval === 0) {
      await this.generateSummary();
    }
  }

  /**
   * Compresse le contexte en résumant les anciens messages
   */
  private async compressContext(): Promise<void> {
    const messagesToCompress = this.currentWindow.messages.slice(0, -this.config.keepLastNMessages);
    const recentMessages = this.currentWindow.messages.slice(-this.config.keepLastNMessages);

    if (messagesToCompress.length === 0) return;

    const summaryPrompt = `Résume ces messages de conversation en conservant les informations importantes:
${messagesToCompress.map(m => `${m.getType()}: ${m.content}`).join('\n')}

Résumé concis:`;

    try {
      const summaryResponse = await this.llm.invoke([
        new HumanMessage(summaryPrompt)
      ]);

      const summary = String(summaryResponse.content);
      this.summaries.push(summary);

      // Recréer la fenêtre de contexte
      this.currentWindow.messages = [
        new HumanMessage(`[Résumé précédent]: ${summary}`),
        ...recentMessages
      ];

      // Recalculer les tokens
      this.currentWindow.totalTokens = this.currentWindow.messages.reduce(
        (total, msg) => total + this.estimateTokens(msg), 0
      );

      console.log(`🔄 Contexte compressé: ${messagesToCompress.length} messages → 1 résumé (${this.currentWindow.totalTokens} tokens)`);
    } catch (error) {
      console.error("Erreur lors de la compression du contexte:", error);
      // En cas d'erreur, garder seulement les messages récents
      this.currentWindow.messages = recentMessages;
      this.currentWindow.totalTokens = recentMessages.reduce(
        (total, msg) => total + this.estimateTokens(msg), 0
      );
    }
  }

  /**
   * Génère un résumé complet de la conversation
   */
  private async generateSummary(): Promise<void> {
    if (this.contextHistory.length < 5) return;

    const fullConversation = this.contextHistory
      .slice(-20) // Derniers 20 messages
      .map(m => `${m.getType()}: ${m.content}`)
      .join('\n');

    const summaryPrompt = `Génère un résumé structuré de cette conversation en identifiant:
1. Les tâches accomplies
2. Les informations importantes
3. L'état actuel du travail
4. Les prochaines étapes potentielles

Conversation:
${fullConversation}

Résumé structuré:`;

    try {
      const response = await this.llm.invoke([new HumanMessage(summaryPrompt)]);
      const summary = String(response.content);
      
      // Sauvegarder le résumé avec timestamp
      const timestampedSummary = `[${new Date().toISOString()}] ${summary}`;
      this.summaries.push(timestampedSummary);
      
      console.log(`📝 Nouveau résumé généré (${this.summaries.length} résumés totaux)`);
    } catch (error) {
      console.error("Erreur lors de la génération du résumé:", error);
    }
  }

  /**
   * Récupère le contexte optimisé pour le LLM
   */
  async getOptimizedContext(systemPrompt: string): Promise<BaseMessage[]> {
    const context: BaseMessage[] = [new HumanMessage(systemPrompt)];

    // Ajouter les résumés si disponibles
    if (this.summaries.length > 0) {
      const recentSummaries = this.summaries.slice(-2); // Derniers 2 résumés
      context.push(new HumanMessage(`[Historique résumé]:\n${recentSummaries.join('\n')}`));
    }

    // Ajouter les messages de la fenêtre actuelle
    context.push(...this.currentWindow.messages);

    return context;
  }

  /**
   * Nettoie le contexte (reset)
   */
  async clearContext(): Promise<void> {
    this.contextHistory = [];
    this.summaries = [];
    this.currentWindow = {
      messages: [],
      totalTokens: 0,
      maxTokens: this.config.maxTokens,
      compressedMessages: []
    };
    
    await this.messageHistory.clear();
    console.log("🧹 Contexte entièrement nettoyé");
  }

  /**
   * Retourne des statistiques sur le contexte
   */
  getContextStats(): {
    totalMessages: number;
    currentTokens: number;
    summariesCount: number;
    compressionRatio: number;
  } {
    const originalTokens = this.contextHistory.reduce(
      (total, msg) => total + this.estimateTokens(msg), 0
    );
    
    return {
      totalMessages: this.contextHistory.length,
      currentTokens: this.currentWindow.totalTokens,
      summariesCount: this.summaries.length,
      compressionRatio: originalTokens > 0 ? this.currentWindow.totalTokens / originalTokens : 1
    };
  }

  /**
   * Exporte le contexte complet pour debugging
   */
  exportFullContext(): {
    messages: BaseMessage[];
    summaries: string[];
    stats: ReturnType<AdvancedContextManager['getContextStats']>;
  } {
    return {
      messages: this.contextHistory,
      summaries: this.summaries,
      stats: this.getContextStats()
    };
  }
}
