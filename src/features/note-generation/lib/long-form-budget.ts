import { operationalSourceTokenBudget } from "./long-form-processing.ts";

// Parallel enough to cut wall time, low enough not to trip DeepInfra rate
// limits (same spirit as WHISPER_MAX_CONCURRENT on the backend).
export const SECTION_MAX_CONCURRENT = 2;
const FALLBACK_CONTEXT_TOKENS = 32_768;
const FALLBACK_OUTPUT_TOKENS = 8_192;
export const MAX_SECTION_SOURCE_TOKENS = 24_000;
export const SECTION_OUTPUT_TOKENS = 1_536;
export const GLOBAL_OUTPUT_TOKENS = 3_072;

export interface ModelLimits {
  model: string;
  context_tokens: number;
  max_output_tokens: number;
  source: string;
}

export interface LongFormBudget {
  model: string;
  maxSourceTokens: number;
  maxReduceTokens: number;
  sectionOutputTokens: number;
  globalOutputTokens: number;
}

export const FALLBACK_MODEL_LIMITS: ModelLimits = {
  model: "unknown",
  context_tokens: FALLBACK_CONTEXT_TOKENS,
  max_output_tokens: FALLBACK_OUTPUT_TOKENS,
  source: "frontend-fallback",
};

// Used when repairing with the deterministic fallback: no provider call is made.
export const DETERMINISTIC_FALLBACK_BUDGET: LongFormBudget = {
    model: "deterministic-fallback",
    maxSourceTokens: MAX_SECTION_SOURCE_TOKENS,
    maxReduceTokens: 20_000,
    sectionOutputTokens: SECTION_OUTPUT_TOKENS,
    globalOutputTokens: GLOBAL_OUTPUT_TOKENS,
};

export function longFormBudgetFor(limits: ModelLimits): LongFormBudget {
  const context = Math.max(4_096, limits.context_tokens);
  const sectionOutputTokens = Math.max(
    512,
    Math.min(SECTION_OUTPUT_TOKENS, limits.max_output_tokens, Math.floor(context / 4)),
  );
  const globalOutputTokens = Math.max(
    512,
    Math.min(GLOBAL_OUTPUT_TOKENS, limits.max_output_tokens, Math.floor(context / 4)),
  );
  const safety = Math.max(512, Math.floor(context * 0.1));
  const promptReserve = Math.max(1_024, Math.min(8_000, Math.floor(context * 0.2)));
  // The backend may continue a length-limited answer twice. Reserve all three
  // possible output windows so a continuation cannot push the request beyond
  // the advertised context size.
  const sectionAvailable = Math.max(
    512,
    context - (sectionOutputTokens * 3) - safety - promptReserve,
  );
  const reduceAvailable = Math.max(
    512,
    context - (globalOutputTokens * 3) - safety - promptReserve,
  );

  return {
    model: limits.model,
    maxSourceTokens: operationalSourceTokenBudget(
      Math.min(MAX_SECTION_SOURCE_TOKENS, sectionAvailable),
    ),
    maxReduceTokens: Math.min(20_000, reduceAvailable),
    sectionOutputTokens,
    globalOutputTokens,
  };
}
