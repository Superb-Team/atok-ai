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
