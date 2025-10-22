import { AGENT_CONFIG } from '@/config/agent.config';

// Agent API Service
const { API_BASE_URL, API_KEY, ENDPOINTS } = AGENT_CONFIG;

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentStreamRequest {
  prompt: string;
  user_id: string;
  conversation_history?: AgentMessage[];
}

export interface AgentStreamEvent {
  type: 'content' | 'tool' | 'error';
  content?: string;
  toolName?: string;
}

export const agentService = {
  /**
   * Transcribe and enhance audio file
   * Endpoint: POST /transcribe-enhance
   */
  async transcribeAndEnhance(audioFile: File, context?: string): Promise<string> {
    try {
      console.log('🎤 Starting transcription and enhancement...');
      console.log('📁 File:', audioFile.name, 'Size:', audioFile.size, 'Type:', audioFile.type);
      console.log('🌐 API URL:', `${API_BASE_URL}/transcribe-enhance`);

      const formData = new FormData();
      formData.append('file', audioFile);
      if (context) {
        formData.append('context', context);
        console.log('📝 Context:', context);
      }

      console.log('📤 Sending request to transcription API...');
      const startTime = Date.now();

      const response = await fetch(`${API_BASE_URL}/transcribe-enhance`, {
        method: 'POST',
        headers: {
          'X-API-Key': API_KEY,
        },
        body: formData,
      });

      const duration = Date.now() - startTime;
      console.log(`📥 Response received in ${duration}ms`);
      console.log('📊 Status:', response.status, response.statusText);
      console.log('📋 Headers:', Object.fromEntries(response.headers.entries()));

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Transcription API error response:', errorText);
        throw new Error(`Transcription failed (${response.status}): ${errorText}`);
      }

      const contentType = response.headers.get('content-type');
      console.log('📄 Content-Type:', contentType);

      const data = await response.json();
      console.log('✅ Transcription response data:', data);

      // Try different possible field names
      const result = data.enhanced_text || data.transcript || data.text || data.result || '';
      console.log('✅ Transcription result length:', result.length);
      console.log('📝 First 200 chars:', result.substring(0, 200));

      if (!result) {
        console.error('⚠️ Empty transcription result. Full response:', data);
        throw new Error('Transcription returned empty result');
      }

      return result;
    } catch (error) {
      console.error('❌ Error transcribing audio:', error);
      if (error instanceof Error) {
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
      }
      throw error;
    }
  },

  /**
   * Insert document to OpenSearch
   */
  async insertDocument(userId: string, text: string, metadata?: Record<string, any>): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE_URL}/opensearch/document/insert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
        },
        body: JSON.stringify({
          user_id: userId,
          text: text,
          metadata: metadata || {},
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to insert document: ${errorText}`);
        return false;
      }

      console.log(`Document inserted to OpenSearch for user: ${userId}`);
      return true;
    } catch (error) {
      console.error('Error inserting document:', error);
      return false;
    }
  },

  /**
   * Check if OpenSearch collection exists for user
   */
  async checkCollection(userId: string): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE_URL}/opensearch/collection/check/${userId}`, {
        method: 'GET',
        headers: {
          'X-API-Key': API_KEY,
        },
      });

      if (response.ok) {
        const data = await response.json();
        return data.exists || false;
      }
      return false;
    } catch (error) {
      console.error('Error checking collection:', error);
      return false;
    }
  },

  /**
   * Create OpenSearch collection for user
   */
  async createCollection(userId: string): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE_URL}/opensearch/collection/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
        },
        body: JSON.stringify({ user_id: userId }),
      });

      if (response.ok) {
        console.log(`OpenSearch collection created for user: ${userId}`);
        return true;
      } else {
        const errorText = await response.text();
        console.error(`Failed to create collection: ${errorText}`);
        return false;
      }
    } catch (error) {
      console.error('Error creating collection:', error);
      return false;
    }
  },

  /**
   * Ensure collection exists, create if not
   */
  async ensureCollection(userId: string): Promise<boolean> {
    const exists = await this.checkCollection(userId);
    if (!exists) {
      console.log(`Collection not found for user ${userId}, creating...`);
      return await this.createCollection(userId);
    }
    return true;
  },

  /**
   * Stream agent response using Server-Sent Events (SSE)
   */
  async *streamAgent(request: AgentStreamRequest): AsyncGenerator<AgentStreamEvent, void, unknown> {
    const response = await fetch(`${API_BASE_URL}${ENDPOINTS.STREAM}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Agent API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        // Decode the chunk
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            // Skip [DONE] marker and keepalive
            if (data === '[DONE]' || !data) {
              continue;
            }

            try {
              const parsed = JSON.parse(data);

              // Handle different event types from agent API
              if (parsed.type === 'text' || parsed.type === 'log') {
                // Main content from agent
                const content = parsed.data || parsed.message || '';
                if (content) {
                  yield { type: 'content', content };
                }
              } else if (parsed.type === 'content') {
                // Alternative content format
                const content = parsed.content || '';
                if (content) {
                  yield { type: 'content', content };
                }
              } else if (parsed.type === 'tool') {
                // Tool usage notification
                yield { type: 'tool', toolName: parsed.tool_name };
              } else if (parsed.type === 'result') {
                // Final result (optional, already accumulated)
                // yield { type: 'content', content: parsed.result || '' };
              } else if (parsed.type === 'error') {
                yield { type: 'error', content: parsed.error || 'Unknown error from agent' };
                throw new Error(parsed.error || 'Unknown error from agent');
              }
              // Skip other types: init, init_loop, start, done
            } catch (e) {
              // If not JSON, treat as plain text
              if (data && data !== '[DONE]') {
                yield { type: 'content', content: data };
              }
            }
          } else if (line.startsWith(': keepalive')) {
            // Skip keepalive messages
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  /**
   * Non-streaming agent invoke (fallback)
   */
  async invokeAgent(request: AgentStreamRequest): Promise<string> {
    const response = await fetch(`${API_BASE_URL}${ENDPOINTS.INVOKE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Agent API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.response || data.message || 'No response from agent';
  },
};
