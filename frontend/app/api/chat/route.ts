import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message } = body;

    if (!message) {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    console.log(`[Frontend API] Forwarding message to backend: ${message}`);

    // Envoyer la requête au backend
    const response = await fetch(`${BACKEND_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Backend responded with status: ${response.status}`);
    }

    const data = await response.json();

    console.log(`[Frontend API] Backend response received`);

    return NextResponse.json({
      response: data.response,
      screenshot: data.screenshot ?? null, // ✅ Transmettre le screenshot au frontend
      timestamp: data.timestamp,
    });

  } catch (error) {
    console.error('[Frontend API] Error:', error);
    
    return NextResponse.json(
      { 
        error: 'Failed to process message',
        message: (error as Error).message 
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ 
    message: 'Chat API is running',
    backend: BACKEND_URL,
    timestamp: new Date().toISOString()
  });
}
