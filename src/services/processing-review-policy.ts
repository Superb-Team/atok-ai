// Roughly ten minutes of speech. Short clean drafts skip a second LLM round-trip.
const REVIEW_TRANSCRIPT_THRESHOLD = 6_000;
export const CURRENT_AI_PIPELINE_VERSION = 9;

interface ReviewDecisionInput {
  processingDegraded: boolean;
  loopSuspected: boolean;
  usedMapReduce: boolean;
  transcriptLength: number;
}

export function shouldReviewGeneratedNote(input: ReviewDecisionInput): boolean {
  if (input.processingDegraded) return false;
  return input.loopSuspected ||
    (!input.usedMapReduce && input.transcriptLength > REVIEW_TRANSCRIPT_THRESHOLD);
}

export function shouldRecoverProcessingJob(
  status: string,
  fallbackVersion?: number,
  repairingFallback = false,
  enhancementMode?: string,
  aiPipelineVersion?: number,
  upgradingAi = false,
): boolean {
  // Both outcomes are terminal. A failed job needs an explicit user retry;
  // reopening the app must never replay it and show the same error forever.
  if (status === "complete" || status === "failed") return false;
  if (repairingFallback || upgradingAi) return true;
  if (
    status === "partial" &&
    enhancementMode === "extractive-fallback" &&
    (aiPipelineVersion ?? 0) < CURRENT_AI_PIPELINE_VERSION
  ) return true;
  if (status === "partial") return (fallbackVersion ?? 0) < 1;
  return ["transcribing", "extracting", "synthesizing", "saving"].includes(status);
}

export function shouldUpgradeExtractiveFallback(
  status: string,
  enhancementMode?: string,
  aiPipelineVersion?: number,
): boolean {
  return status === "partial" &&
    enhancementMode === "extractive-fallback" &&
    (aiPipelineVersion ?? 0) < CURRENT_AI_PIPELINE_VERSION;
}

export function shouldRepairWithStructuredFallback(
  status: string,
  savedNoteId?: number,
  fallbackVersion?: number,
  repairingFallback = false,
): boolean {
  return (status === "partial" || repairingFallback) &&
    savedNoteId !== undefined && (fallbackVersion ?? 0) < 1;
}
