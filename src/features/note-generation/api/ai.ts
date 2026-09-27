import { invoke } from "@tauri-apps/api/core";
import {
  FALLBACK_MODEL_LIMITS,
  type ModelLimits,
} from "@/features/note-generation/lib/long-form-budget";
import type { TranscriptIntegrityReport } from "@/features/note-generation/types";

export interface ChatCompletionResult {
  request_id: string;
  content: string;
  finish_reason: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost: number;
  continuation_count: number;
  is_truncated: boolean;
}

export function getModelLimits(): Promise<ModelLimits> {
  return invoke<ModelLimits>("get_ai_model_limits").catch(() => FALLBACK_MODEL_LIMITS);
}

export function detailedChat(
  messages: Array<{ role: string; content: string }>,
  temperature: number,
  maxTokens: number,
  responseFormat?: Record<string, unknown>,
): Promise<ChatCompletionResult> {
  return invoke<ChatCompletionResult>("ai_chat_detailed", {
    messages,
    temperature,
    maxTokens,
    ...(responseFormat ? { responseFormat } : {}),
  });
}

export function transcribeAudio(audioPath: string, language: string, forceRefresh: boolean): Promise<string> {
  return invoke<string>("transcribe_audio", { audioPath, language, forceRefresh });
}

export function evaluateTranscriptIntegrity(
  audioPath: string,
  transcript: string,
): Promise<TranscriptIntegrityReport> {
  return invoke<TranscriptIntegrityReport>("evaluate_transcript_integrity", { audioPath, transcript });
}

export function describeImage(imagePath: string, language: string): Promise<string> {
  return invoke<string>("describe_image", { imagePath, language });
}

export function insertRagDocument(
  userId: string,
  text: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  return invoke<boolean>("agent_insert_document", { userId, text, metadata });
}
