'use client';

import { useState, useRef, useEffect } from 'react';

interface ContextStats {
  totalMessages: number;
  currentTokens: number;
  summariesCount: number;
  compressionRatio: number;
}

interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  screenshot?: string | null;
  timestamp: string;
  context?: ContextStats;
}

export default function Home() {
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll vers le bas à chaque nouveau message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const sendMessage = async () => {
    if (!message.trim() || loading) return;

    const userMsg: ChatMessage = {
      role: 'user',
      text: message.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMsg]);
    setMessage('');
    setLoading(true);
    setError('');

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg.text }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Serveur ${res.status} — ${errorText}`);
      }

      const data = await res.json();

      const agentMsg: ChatMessage = {
        role: 'agent',
        text: data.response,
        screenshot: data.screenshot ?? null,
        timestamp: data.timestamp,
        context: data.context,
      };

      setMessages(prev => [...prev, agentMsg]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const clearContext = async () => {
    if (!confirm('Effacer tout le contexte et l\'historique ?')) return;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/context/clear`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Échec du clear');
      setMessages([]);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const lastContext = [...messages].reverse().find(m => m.context)?.context;

  const formatTime = (iso: string) => {
    try { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-100">

      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-lg">🤖</div>
          <div>
            <h1 className="font-bold text-gray-900 text-base leading-tight">Agent IA LangChain</h1>
            <p className="text-xs text-gray-500">Mistral · E2B Sandbox · Navigation autonome</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastContext && (
            <span className="hidden sm:flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded-full">
              📊 {lastContext.currentTokens.toLocaleString()} tokens · {lastContext.compressionRatio}% compressé
            </span>
          )}
          <button
            onClick={clearContext}
            className="text-xs px-3 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
          >
            🧹 Clear
          </button>
        </div>
      </header>

      {/* ── Zone de messages ── */}
      <main className="flex-1 overflow-y-auto px-4 py-4 space-y-4">

        {/* Message de bienvenue si vide */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 gap-3">
            <div className="text-5xl">🤖</div>
            <p className="font-medium text-gray-600">Bonjour ! Je suis votre agent IA autonome.</p>
            <p className="text-sm max-w-sm">Je peux naviguer sur le web, remplir des formulaires, prendre des captures d'écran et bien plus encore.</p>
            <div className="flex flex-wrap gap-2 justify-center mt-2">
              {[
                "Ouvre un navigateur en mode headless",
                "Va sur google.com",
                "Fais une capture d'écran",
              ].map(s => (
                <button
                  key={s}
                  onClick={() => setMessage(s)}
                  className="text-xs bg-white border border-gray-200 rounded-full px-3 py-1.5 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Bulles de messages */}
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>

            {/* Avatar */}
            <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-sm
              ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>
              {msg.role === 'user' ? '👤' : '🤖'}
            </div>

            {/* Contenu */}
            <div className={`max-w-[75%] space-y-2 ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col`}>
              <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap
                ${msg.role === 'user'
                  ? 'bg-blue-600 text-white rounded-tr-sm'
                  : 'bg-white text-gray-800 border border-gray-200 rounded-tl-sm shadow-sm'
                }`}>
                {msg.text}
              </div>

              {/* Screenshot */}
              {msg.screenshot && (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                  <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-400"></span>
                    <span className="w-2.5 h-2.5 rounded-full bg-yellow-400"></span>
                    <span className="w-2.5 h-2.5 rounded-full bg-green-400"></span>
                    <span className="text-xs text-gray-400 ml-1">Capture d'écran</span>
                  </div>
                  <img
                    src={msg.screenshot}
                    alt="Capture d'écran du navigateur"
                    className="max-w-full block"
                  />
                </div>
              )}

              {/* Timestamp + stats de contexte */}
              <span className="text-xs text-gray-400">{formatTime(msg.timestamp)}</span>
            </div>
          </div>
        ))}

        {/* Indicateur de chargement */}
        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-sm">🤖</div>
            <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
              <div className="flex gap-1.5 items-center">
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
              </div>
            </div>
          </div>
        )}

        {/* Erreur */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
            ⚠️ <strong>Erreur :</strong> {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      {/* ── Zone de saisie ── */}
      <div className="bg-white border-t border-gray-200 px-4 py-3 flex-shrink-0">
        <div className="flex gap-2 max-w-4xl mx-auto">
          <input
            ref={inputRef}
            type="text"
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
            placeholder="Envoyer un message à l'agent…"
            className="flex-1 px-4 py-2.5 bg-gray-100 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
            disabled={loading}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !message.trim()}
            className="px-4 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm font-medium flex items-center gap-1.5"
          >
            {loading ? (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
            ) : (
              <>Envoyer <span>↩</span></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}