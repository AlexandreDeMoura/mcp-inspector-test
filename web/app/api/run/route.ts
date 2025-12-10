import { NextRequest, NextResponse } from 'next/server';
import { runTaskGenerator, cleanup, RunTaskOptions } from '@/lib/llmLoop';

// Force dynamic to prevent caching
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { prompt, serverIds } = body;

    if (!prompt || !serverIds || !Array.isArray(serverIds)) {
      return NextResponse.json(
        { error: 'Invalid request. "prompt" (string) and "serverIds" (array) are required.' },
        { status: 400 }
      );
    }

    const encoder = new TextEncoder();
    
    // Create a streaming response
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const options: RunTaskOptions = {
            userMessage: prompt,
            serverIds,
          };

          for await (const event of runTaskGenerator(options)) {
            // Encode the event as a line of JSON
            const data = JSON.stringify(event) + '\n';
            controller.enqueue(encoder.encode(data));
          }
        } catch (error) {
          console.error('Stream error:', error);
          const errorEvent = JSON.stringify({ 
            type: 'error', 
            message: error instanceof Error ? error.message : String(error) 
          }) + '\n';
          controller.enqueue(encoder.encode(errorEvent));
        } finally {
          controller.close();
        }
      },
      cancel() {
        console.log('Stream cancelled by client');
        // We could trigger cleanup here if needed, but runTaskGenerator handles its own cleanup on completion/error
        // However, if the client disconnects mid-stream, we might want to ensure tasks are cancelled.
        // For now, let's keep it simple.
      }
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson', // Newline Delimited JSON
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

