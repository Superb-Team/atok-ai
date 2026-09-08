// Versioned so an explicit user regeneration can distinguish older AI drafts.
// Bumped past both lines of divergence: this pipeline now runs the structured
// global note from PR #6 together with the async retry budget.
export const CURRENT_AI_PIPELINE_VERSION = 15;
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

export const MAX_PROCESSING_ATTEMPTS = 4;

export type ProcessingFailureKind = "retryable" | "terminal";

const IN_FLIGHT_STATUSES = ["transcribing", "extracting", "synthesizing", "saving"];

// Mirrors is_retryable_transcription_error in src-tauri/src/agent.rs, widened to
// the transport and provider failures the whole pipeline can surface.
const TRANSIENT_FAILURE_PATTERNS = [
  "transcription request failed",
  "chat request failed after retries",
  "all configured chat models failed",
  "error sending request",
  "failed to fetch",
  "model busy",
  "429",
  "408 request timeout",
  "500 internal server error",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway timeout",
  "timed out",
  "timeout",
  "network",
  "connection",
];

export function isTransientProcessingFailure(error: string): boolean {
  const lower = error.toLowerCase();
  return TRANSIENT_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function classifyProcessingFailure(
  error: string,
  attempt: number,
): ProcessingFailureKind {
  if (attempt >= MAX_PROCESSING_ATTEMPTS) return "terminal";
  return isTransientProcessingFailure(error) ? "retryable" : "terminal";
}

export function nextProcessingAttemptAt(attempt: number, now = new Date()): string {
  const minutes = Math.min(2 ** Math.max(0, attempt - 1), 16);
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

export interface ProcessingRecoveryState {
  status: string;
  attempt?: number;
  nextAttemptAt?: string;
  failureKind?: ProcessingFailureKind;
  repairingFallback?: boolean;
  upgradingAi?: boolean;
}

export function shouldRecoverProcessingJob(
  job: ProcessingRecoveryState,
  now = new Date(),
): boolean {
  // An interrupted run leaves an in-flight status behind, so a restart must be
  // able to resume it — but only within a budget, or a job that dies at the same
  // point every time is replayed on every launch forever.
  if ((job.attempt ?? 0) >= MAX_PROCESSING_ATTEMPTS) return false;
  if (job.status === "complete" || job.status === "partial") return false;
  if (job.status === "failed") {
    if (job.failureKind !== "retryable") return false;
    return !job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now.getTime();
  }
  if (job.repairingFallback || job.upgradingAi) return true;
  return IN_FLIGHT_STATUSES.includes(job.status);
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

export function shouldRefreshTranscript(
  storedVersion?: number,
  storedTranscript?: string,
): boolean {
  // Nothing stored yet means the recording has never been transcribed, not that
  // an old transcript needs replacing; re-uploading it would bill the audio twice.
  if (!storedTranscript?.trim()) return false;
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
