'use client';

import { useState } from 'react';

interface ContextStats {
  totalMessages: number;
  currentTokens: number;
  summariesCount: number;
  compressionRatio: number;
}

interface ChatResponse {
  response: string;
  context?: ContextStats;
  timestamp: string;
}

export default function Home() {
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState('');
  const [context, setContext] = useState<ContextStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const sendMessage = async () => {
    if (!message.trim()) return;

    setLoading(true);
    setError('');
    setResponse('');
    setContext(null);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
      });

      const data: ChatResponse = await res.json();

      if (!res.ok) {
        throw new Error(data.response || 'Something went wrong');
      }

      setResponse(data.response);
      setContext(data.context || null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const clearContext = async () => {
    try {
      const res = await fetch('/api/context/clear', {
        method: 'POST',
      });

      if (!res.ok) {
        throw new Error('Failed to clear context');
      }

      setContext(null);
      setResponse('');
      setError('');
      setMessage('');
      alert('Contexte effacé avec succès!');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const getContextStats = async () => {
    try {
      const res = await fetch('/api/context/stats');
      
      if (!res.ok) {
        throw new Error('Failed to get context stats');
      }

      const data = await res.json();
      setContext(data.context);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">
                Agent IA LangChain
              </h1>
              {/* <p className="text-gray-600">
                Interface avec ingénierie de contexte avancée
              </p> */}
            </div>
            {/* <div className="flex gap-2">
              <button
                onClick={getContextStats}
                className="px-3 py-1 bg-blue-100 text-blue-700 rounded-md hover:bg-blue-200 text-sm"
              >
                📊 Stats
              </button>
              <button
                onClick={clearContext}
                className="px-3 py-1 bg-red-100 text-red-700 rounded-md hover:bg-red-200 text-sm"
              >
                🧹 Clear
              </button>
            </div> */}
          </div>

          {/* Context Stats */}
          {context && (
            <div className="mb-6 p-4 bg-blue-50 rounded-lg">
              <h3 className="font-semibold text-blue-800 mb-2">📊 Statistiques du Contexte:</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-blue-600">Messages:</span>
                  <div className="font-bold text-blue-900">{context.totalMessages}</div>
                </div>
                <div>
                  <span className="text-blue-600">Tokens:</span>
                  <div className="font-bold text-blue-900">{context.currentTokens.toLocaleString()}</div>
                </div>
                <div>
                  <span className="text-blue-600">Résumés:</span>
                  <div className="font-bold text-blue-900">{context.summariesCount}</div>
                </div>
                <div>
                  <span className="text-blue-600">Compression:</span>
                  <div className="font-bold text-blue-900">{context.compressionRatio}%</div>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-6">
            {/* Input Section */}
            <div className="border rounded-lg p-4">
              <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-2">
                Message pour l'agent
              </label>
              <div className="flex gap-2">
                <input
                  id="message"
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder="Ex: Cherche des informations sur Next.js..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 placeholder-gray-500"
                  disabled={loading}
                />
                <button
                  onClick={sendMessage}
                  disabled={loading || !message.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? 'Envoi...' : 'Envoyer'}
                </button>
              </div>
            </div>

            {/* Error Section */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
                <strong>Erreur:</strong> {error}
              </div>
            )}

            {/* Response Section */}
            {response && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h3 className="font-semibold text-green-800 mb-2">Réponse de l'agent:</h3>
                <div className="text-gray-700 whitespace-pre-wrap">{response}</div>
              </div>
            )}

            {/* Loading State */}
            {loading && (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                <span className="ml-2 text-gray-600">L'agent réfléchit...</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
