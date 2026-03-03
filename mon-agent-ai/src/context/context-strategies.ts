import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { AdvancedContextManager } from "./context-manager";

export type ContextStrategy = 'sliding-window' | 'summarization' | 'hybrid' | 'token-aware';

export interface StrategyConfig {
  strategy: ContextStrategy;
  windowSize?: number;
  summaryFrequency?: number;
  maxContextTokens?: number;
  priorityKeywords?: string[];
}

/**
 * Stratégie Fenêtre Glissante - Garde les N derniers messages
 */
export class SlidingWindowStrategy {
  constructor(private windowSize: number = 10) {}

  apply(messages: BaseMessage[]): BaseMessage[] {
    return messages.slice(-this.windowSize);
  }
}

/**
 * Stratégie de Résumé - Résume périodiquement la conversation
 */
export class SummarizationStrategy {
  constructor(
    private summaryFrequency: number = 15,
    private llm: any
  ) {}

  async apply(messages: BaseMessage[]): Promise<BaseMessage[]> {
    if (messages.length <= this.summaryFrequency) {
      return messages;
    }

    const recentMessages = messages.slice(-5);
    const toSummarize = messages.slice(0, -5);

    const summary = await this.generateSummary(toSummarize);
    
    return [
      new HumanMessage(`[Résumé]: ${summary}`),
      ...recentMessages
    ];
  }

  private async generateSummary(messages: BaseMessage[]): Promise<string> {
    const conversation = messages.map(m => `${m.getType()}: ${m.content}`).join('\n');
    const prompt = `Résume cette conversation de manière concise:\n${conversation}\n\nRésumé:`;
    
    const response = await this.llm.invoke([new HumanMessage(prompt)]);
    return String(response.content);
  }
}

/**
 * Stratégie Hybride - Combine fenêtre glissante et résumé
 */
export class HybridStrategy {
  constructor(
    private windowSize: number = 8,
    private summaryThreshold: number = 20,
    private llm: any
  ) {}

  async apply(messages: BaseMessage[]): Promise<BaseMessage[]> {
    if (messages.length <= this.windowSize) {
      return messages;
    }

    const recent = messages.slice(-this.windowSize);
    
    if (messages.length > this.summaryThreshold) {
      const toSummarize = messages.slice(0, -this.windowSize);
      const summary = await this.generateSummary(toSummarize);
      
      return [
        new HumanMessage(`[Résumé historique]: ${summary}`),
        ...recent
      ];
    }

    return recent;
  }

  private async generateSummary(messages: BaseMessage[]): Promise<string> {
    const conversation = messages.map(m => `${m.getType()}: ${m.content}`).join('\n');
    const prompt = `Résume les points clés de cette conversation:\n${conversation}\n\nRésumé:`;
    
    const response = await this.llm.invoke([new HumanMessage(prompt)]);
    return String(response.content);
  }
}

/**
 * Stratégie Sensible aux Tokens - Optimise en fonction des tokens
 */
export class TokenAwareStrategy {
  constructor(
    private maxTokens: number = 30000,
    private priorityKeywords: string[] = ['erreur', 'problème', 'important', 'urgent'],
    private llm: any
  ) {}

  async apply(messages: BaseMessage[]): Promise<BaseMessage[]> {
    let totalTokens = this.estimateTotalTokens(messages);
    
    if (totalTokens <= this.maxTokens) {
      return messages;
    }

    // Trier les messages par importance
    const scoredMessages = messages.map(msg => ({
      message: msg,
      score: this.calculateImportanceScore(msg),
      tokens: this.estimateTokens(msg)
    }));

    // Sélectionner les messages les plus importants
    const selected = this.selectImportantMessages(scoredMessages);
    
    // Si encore trop de tokens, compresser
    if (selected.reduce((sum, item) => sum + item.tokens, 0) > this.maxTokens) {
      return await this.compressSelected(selected);
    }

    return selected.map(item => item.message);
  }

  private estimateTokens(message: BaseMessage): number {
    return Math.ceil(String(message.content).length / 4);
  }

  private estimateTotalTokens(messages: BaseMessage[]): number {
    return messages.reduce((total, msg) => total + this.estimateTokens(msg), 0);
  }

  private calculateImportanceScore(message: BaseMessage): number {
    const content = String(message.content).toLowerCase();
    let score = 1;

    // Points pour mots-clés prioritaires
    this.priorityKeywords.forEach(keyword => {
      if (content.includes(keyword.toLowerCase())) {
        score += 2;
      }
    });

    // Points pour les messages d'erreur
    if (content.includes('erreur') || content.includes('error')) {
      score += 3;
    }

    // Points pour les messages récents (plus récent = plus important)
    const isRecent = message instanceof AIMessage;
    if (isRecent) score += 1;

    // Points pour les messages longs (probablement plus d'informations)
    if (content.length > 200) score += 1;

    return score;
  }

  private selectImportantMessages(scoredMessages: Array<{message: BaseMessage, score: number, tokens: number}>): Array<{message: BaseMessage, score: number, tokens: number}> {
    // Trier par score décroissant
    scoredMessages.sort((a, b) => b.score - a.score);
    
    // Garder les messages les plus importants tout en restant sous la limite
    const selected: Array<{message: BaseMessage, score: number, tokens: number}> = [];
    let currentTokens = 0;

    for (const item of scoredMessages) {
      if (currentTokens + item.tokens <= this.maxTokens) {
        selected.push(item);
        currentTokens += item.tokens;
      }
    }

    return selected;
  }

  private async compressSelected(selected: Array<{message: BaseMessage, score: number, tokens: number}>): Promise<BaseMessage[]> {
    // Diviser en deux groupes: haut score et bas score
    const highScore = selected.filter(item => item.score >= 3);
    const lowScore = selected.filter(item => item.score < 3);

    if (lowScore.length === 0) {
      return selected.map(item => item.message);
    }

    // Résumer les messages moins importants
    const toCompress = lowScore.map(item => item.message);
    const summary = await this.generateSummary(toCompress);

    return [
      new HumanMessage(`[Résumé des messages secondaires]: ${summary}`),
      ...highScore.map(item => item.message)
    ];
  }

  private async generateSummary(messages: BaseMessage[]): Promise<string> {
    const conversation = messages.map(m => `${m.getType()}: ${m.content}`).join('\n');
    const prompt = `Résume ces messages de manière très concise:\n${conversation}\n\nRésumé:`;
    
    const response = await this.llm.invoke([new HumanMessage(prompt)]);
    return String(response.content);
  }
}

/**
 * Factory pour créer la stratégie appropriée
 */
export class ContextStrategyFactory {
  static create(config: StrategyConfig, llm: any): any {
    switch (config.strategy) {
      case 'sliding-window':
        return new SlidingWindowStrategy(config.windowSize);
      
      case 'summarization':
        return new SummarizationStrategy(config.summaryFrequency, llm);
      
      case 'hybrid':
        return new HybridStrategy(config.windowSize, config.summaryFrequency, llm);
      
      case 'token-aware':
        return new TokenAwareStrategy(config.maxContextTokens, config.priorityKeywords, llm);
      
      default:
        return new SlidingWindowStrategy(10);
    }
  }
}
