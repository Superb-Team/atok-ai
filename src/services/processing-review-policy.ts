// Versioned so an explicit user regeneration can distinguish older AI drafts.
export const CURRENT_AI_PIPELINE_VERSION = 14;
// Bump when transcript normalization, track arbitration, or chunk stitching
// changes. Old manifests must re-read the canonical sidecar instead of feeding
// a previously hallucinated transcript back into note generation.
export const CURRENT_TRANSCRIPTION_PIPELINE_VERSION = 3;
interface ReviewDecisionInput {
  processingDegraded: boolean;
  loopSuspected: boolean;
  usedMapReduce: boolean;
  transcriptLength: number;
}

export function shouldReviewGeneratedNote(input: ReviewDecisionInput): boolean {
  if (input.processingDegraded) return false;
  return input.loopSuspected;
}

interface PublicationDecisionInput {
  processingDegraded: boolean;
  hasFailedSection: boolean;
  transcriptRequiresReview: boolean;
  noteWasManuallyEdited: boolean;
}

export function shouldPublishRecordingToRag(input: PublicationDecisionInput): boolean {
  return !input.processingDegraded &&
    !input.hasFailedSection &&
    !input.transcriptRequiresReview &&
    !input.noteWasManuallyEdited;
}

export function shouldOpenAiDraftPreview(
  hasContent: boolean,
  usedStructuredFallback: boolean,
): boolean {
  return hasContent && !usedStructuredFallback;
}

export function shouldRecoverProcessingJob(
  status: string,
  _fallbackVersion?: number,
  repairingFallback = false,
  _enhancementMode?: string,
  _aiPipelineVersion?: number,
  upgradingAi = false,
  _transcriptionPipelineVersion?: number,
  _transcriptPresent = false,
): boolean {
  // Both outcomes are terminal. A failed job needs an explicit user retry;
  // reopening the app must never replay it and show the same error forever.
  if (status === "complete" || status === "failed" || status === "partial") return false;
  if (repairingFallback || upgradingAi) return true;
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

export function shouldRefreshTranscript(storedVersion?: number): boolean {
  return (storedVersion ?? 0) < CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
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
