import { invoke } from '@tauri-apps/api/core';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AgentStreamRequest {
  prompt: string;
  user_id: string;
  conversation_history?: AgentMessage[];
  system_prompt?: string;
}

export interface AgentStreamEvent {
  type: 'content' | 'tool' | 'error';
  content?: string;
}

export const agentService = {
  /**
   * Ensure OpenSearch collection exists
   */
  async ensureCollection(userId: string): Promise<boolean> {
    try {
      return await invoke<boolean>('agent_ensure_collection', { userId });
    } catch (error) {
      console.error('Error ensuring collection:', error);
      return false;
    }
  },

  /**
   * Stream chat response via Rust backend
   */
  async *streamAgent(request: AgentStreamRequest): AsyncGenerator<AgentStreamEvent, void, unknown> {
    try {
      const messages: AgentMessage[] = [];

      if (request.system_prompt) {
        messages.push({ role: 'system', content: request.system_prompt });
      }

      if (request.conversation_history) {
        messages.push(...request.conversation_history);
      }

      messages.push({ role: 'user', content: request.prompt });

      const response = await invoke<string>('ai_chat_stream', { messages });

      if (response) {
        yield { type: 'content', content: response };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      yield { type: 'error', content: errorMsg };
    }
  },
};
