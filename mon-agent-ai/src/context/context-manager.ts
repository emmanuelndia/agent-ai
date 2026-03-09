import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { getEncoding } from "js-tiktoken";
import * as fs   from "fs";
import * as path from "path";

// TYPES

export interface ContextWindow {
    messages: BaseMessage[];
    totalTokens: number;
    maxTokens: number;
    compressedMessages: BaseMessage[];
}

export interface ContextConfig {
    maxTokens: number;
    compressionThreshold: number;
    summaryInterval: number;
    keepLastNMessages: number;
    summaryDir?: string;   // Dossier FS pour stocker les résumés compressés
}

// ENCODEUR (singleton)

const encoder = getEncoding("cl100k_base");

// ADVANCED CONTEXT MANAGER

export class AdvancedContextManager {
    // Historique APPEND-ONLY — on n'efface jamais un élément
    private contextHistory: BaseMessage[] = [];

    // Résumés textuels (sans timestamp — déterministes)
    private summaries: string[] = [];

    private currentWindow: ContextWindow;
    private config: ContextConfig;
    private llm: any;
    private messageHistory: InMemoryChatMessageHistory;

    constructor(config: Partial<ContextConfig> = {}, llmInstance?: any) {
        this.config = {
            maxTokens: 32000,
            compressionThreshold: 0.8,
            summaryInterval: 10,
            keepLastNMessages: 5,
            summaryDir: "./agent-memory/summaries",
            ...config,
        };

        if (!llmInstance) throw new Error("Aucun LLM fourni à AdvancedContextManager");
        this.llm = llmInstance;

        this.messageHistory = new InMemoryChatMessageHistory();

        this.currentWindow = {
            messages: [],
            totalTokens: 0,
            maxTokens: this.config.maxTokens,
            compressedMessages: [],
        };

        // Créer le dossier de résumés si nécessaire
        if (this.config.summaryDir) {
            fs.mkdirSync(this.config.summaryDir, { recursive: true });
        }
    }


    // ESTIMATION TOKENS

    private estimateTokens(message: BaseMessage | string): number {
        let content = "";

        if (typeof message === "string") {
            content = message;
        } else {
            content = String(message.content);

            if (Array.isArray(message.content)) {
                let total = 0;
                for (const part of message.content) {
                    if (typeof part === "object" && part !== null && "type" in part) {
                        if (part.type === "text" && "text" in part) {
                            total += encoder.encode(String(part.text)).length;
                        } else if (part.type === "image_url") {
                            total += 258;
                        }
                    }
                }
                return total;
            }
        }

        return encoder.encode(content).length;
    }

    // AJOUT DE MESSAGE (append-only)

    async addMessage(message: BaseMessage): Promise<void> {
        const tokens = this.estimateTokens(message);

        // Append-only : on ajoute toujours, on ne modifie jamais
        this.contextHistory.push(message);
        await this.messageHistory.addMessage(message);

        // Vérifier le seuil de compression
        if (
            this.currentWindow.totalTokens + tokens >
            this.config.maxTokens * this.config.compressionThreshold
        ) {
            await this.compressContextViaFS();
        }

        this.currentWindow.messages.push(message);
        this.currentWindow.totalTokens += tokens;

        // Résumé périodique (sans consommer de tokens LLM si pas nécessaire)
        if (this.contextHistory.length % this.config.summaryInterval === 0) {
            await this.generateSummaryViaFS();
        }
    }

    // COMPRESSION VIA FS (remplace compressContext)
    //
    // Principe Manus : "la compression devient restaurable"
    // On n'efface PAS les anciens messages — on les décharge dans un fichier
    // et on garde un POINTEUR court dans le contexte.
    //
    // KV cache : les messages récents (keepLastNMessages) restent identiques
    // d'un appel à l'autre → leur préfixe est toujours caché.
  
    private async compressContextViaFS(): Promise<void> {
        const recent    = this.currentWindow.messages.slice(-this.config.keepLastNMessages);
        const toCompress = this.currentWindow.messages.slice(0, -this.config.keepLastNMessages);

        if (toCompress.length === 0) return;

        // Générer un résumé textuel (SANS timestamp pour rester déterministe)
        const summaryPrompt =
            "Résume ces échanges de manière concise, en conservant :\n" +
            "- Les actions effectuées et leurs résultats\n" +
            "- Les informations importantes (URLs, sélecteurs, identifiants)\n" +
            "- Les erreurs rencontrées et comment elles ont été résolues\n\n" +
            toCompress.map(m => `${m.getType()}: ${String(m.content).slice(0, 500)}`).join("\n") +
            "\n\nRésumé:";

        let summaryText = `[${toCompress.length} messages compressés]`;

        try {
            const response = await this.llm.invoke([new HumanMessage(summaryPrompt)]);
            summaryText = String(response.content);
            this.summaries.push(summaryText);
        } catch (err) {
            console.warn("Compression LLM échouée, résumé minimal utilisé.");
        }

        // Sauvegarder le contenu complet dans un fichier FS (restaurable)
        const fichierSummary = this.sauvegarderSummaryFS(toCompress, summaryText);

        // Remplacer les anciens messages par UN SEUL message pointeur
        // Ce pointeur est court (~30 tokens) et STABLE (déterministe)
        const pointeur = new HumanMessage(
            `[CONTEXTE COMPRESSÉ — ${toCompress.length} messages archivés dans ${fichierSummary}]\n` +
            `Résumé : ${summaryText}`
        );

        // Reconstruire la fenêtre : pointeur + messages récents (append-like)
        this.currentWindow.messages = [pointeur, ...recent];
        this.currentWindow.totalTokens = this.currentWindow.messages.reduce(
            (t, m) => t + this.estimateTokens(m), 0
        );

        console.log(
            `🗜️  Compression FS : ${toCompress.length} msgs → 1 pointeur ` +
            `(${this.currentWindow.totalTokens} tokens restants)`
        );
    }

    private sauvegarderSummaryFS(messages: BaseMessage[], summary: string): string {
        if (!this.config.summaryDir) return "mémoire";

        // Nom de fichier DÉTERMINISTE (basé sur le nombre de messages, pas un timestamp)
        // → même contenu = même nom → évite les doublons
        const hash = messages.length + "-" + this.summaries.length;
        const nomFichier = `summary-${hash}.md`;
        const chemin = path.join(this.config.summaryDir, nomFichier);

        const contenu =
            `# Résumé compressé (${messages.length} messages)\n\n` +
            `## Synthèse\n${summary}\n\n` +
            `## Messages originaux\n\n` +
            messages
                .map(m => `### ${m.getType()}\n${String(m.content).slice(0, 2000)}`)
                .join("\n\n");

        fs.writeFileSync(chemin, contenu, "utf-8");
        return chemin;
    }

    // RÉSUMÉ PÉRIODIQUE VIA FS (remplace generateSummary)
    //
    // Correction : suppression du timestamp dans le contenu du résumé.
    // Un timestamp change à chaque appel → préfixe jamais identique → 0% cache hit.

    private async generateSummaryViaFS(): Promise<void> {
        if (this.contextHistory.length < 5) return;

        const derniers = this.contextHistory
            .slice(-20)
            .map(m => `${m.getType()}: ${String(m.content).slice(0, 400)}`)
            .join("\n");

        const prompt =
            "Génère un résumé structuré :\n" +
            "1. Tâches accomplies\n" +
            "2. Informations importantes\n" +
            "3. État actuel\n" +
            "4. Prochaines étapes\n\n" +
            `Conversation:\n${derniers}\n\nRésumé:`;

        try {
            const response = await this.llm.invoke([new HumanMessage(prompt)]);
            const summary  = String(response.content);

            // PAS de timestamp — résumé pur et déterministe
            this.summaries.push(summary);

            console.log(`📝 Résumé périodique généré (total: ${this.summaries.length})`);
        } catch (err) {
            console.warn("Résumé périodique échoué (silencieux).");
        }
    }

    // CONSTRUCTION DU CONTEXTE OPTIMISÉ
    //
    // Règle KV cache :
    //   - Le system prompt (préfixe) doit être IDENTIQUE à chaque appel
    //   - Les messages passés s'ACCUMULENT (append-only)
    //   - Le contenu dynamique (résumés, état) va À LA FIN, pas au début
    //
    // Structure retournée :
    //   [SystemMessage stable] → toujours caché après le 1er appel
    //   [Résumés si dispo]     → stables entre les appels (pas de timestamp)
    //   [Messages courants]    → s'allongent, préfixe croissant caché
 
    async getOptimizedContext(systemPrompt: string): Promise<BaseMessage[]> {
        const context: BaseMessage[] = [];

        // 1. System prompt — STABLE, jamais modifié → pleinement caché par KV
        //    Envoyé comme SystemMessage pour que Mistral/OpenAI le traitent correctement
        //    (les providers qui ne supportent pas SystemMessage le convertissent en HumanMessage)
        context.push(new SystemMessage(systemPrompt));

        // 2. Résumés si disponibles — ajoutés APRÈS le system prompt stable
        //    Ils ne changent pas entre les tours → préfixe étendu caché
        if (this.summaries.length > 0) {
            const derniersSummaries = this.summaries.slice(-2).join("\n\n---\n\n");
            context.push(
                new HumanMessage(`[Résumés de session]\n${derniersSummaries}`)
            );
        }

        // 3. Messages de la fenêtre courante (append-only)
        context.push(...this.currentWindow.messages);

        return context;
    }

    // UTILITAIRES PUBLICS

    async clearContext(): Promise<void> {
        this.contextHistory = [];
        this.summaries = [];
        this.currentWindow = {
            messages: [],
            totalTokens: 0,
            maxTokens: this.config.maxTokens,
            compressedMessages: [],
        };
        await this.messageHistory.clear();
        console.log("🧹 Contexte entièrement nettoyé");
    }

    getContextStats(): {
        totalMessages: number;
        currentTokens: number;
        summariesCount: number;
        compressionRatio: number;
    } {
        const originalTokens = this.contextHistory.reduce(
            (t, m) => t + this.estimateTokens(m), 0
        );

        return {
            totalMessages   : this.contextHistory.length,
            currentTokens   : this.currentWindow.totalTokens,
            summariesCount  : this.summaries.length,
            compressionRatio: originalTokens > 0
                ? this.currentWindow.totalTokens / originalTokens
                : 1,
        };
    }

    exportFullContext() {
        return {
            messages : this.contextHistory,
            summaries: this.summaries,
            stats    : this.getContextStats(),
        };
    }
}