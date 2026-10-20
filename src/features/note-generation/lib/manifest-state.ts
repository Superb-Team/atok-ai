import {
  inferRecordingNoteContext,
  type RecordingNoteContext,
} from "../../recording/lib/recording-note-metadata.ts";
import type { ProcessingManifest } from "../types.ts";
import {
  CURRENT_AI_PIPELINE_VERSION,
  CURRENT_TRANSCRIPTION_PIPELINE_VERSION,
  classifyProcessingFailure,
  nextProcessingAttemptAt,
  shouldRepairWithStructuredFallback,
  shouldUpgradeExtractiveFallback,
} from "./processing-review-policy.ts";

export function resolveRecordingContext(
  context: RecordingNoteContext | undefined,
  manifest: ProcessingManifest | null,
  audioPath: string,
): RecordingNoteContext {
  return context
    ?? (manifest?.recordedAt && manifest.timezone
      ? { recordedAt: manifest.recordedAt, timezone: manifest.timezone }
      : undefined)
    ?? inferRecordingNoteContext(audioPath)
    ?? {
      recordedAt: manifest?.createdAt ?? new Date().toISOString(),
      timezone: "UTC",
    };
}

export function createProcessingManifest(
  audioPath: string,
  noteTitle: string,
  language: string,
  context: RecordingNoteContext,
): ProcessingManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    generation: 0,
    jobId: `job-${globalThis.crypto.randomUUID()}`,
    audioPath,
    noteTitle,
    language,
    recordedAt: context.recordedAt,
    timezone: context.timezone,
    status: "transcribing",
    sections: [],
    createdAt: now,
    updatedAt: now,
  };
}

export interface RerunPlan {
  repairWithStructuredFallback: boolean;
  repairReason?: string;
  /** The manifest was reset and must be persisted before work starts. */
  changed: boolean;
}

export function planRerun(
  manifest: ProcessingManifest,
  noteTitle: string,
  language: string,
  context: RecordingNoteContext,
  forceAiUpgrade: boolean,
): RerunPlan {
  manifest.noteTitle = noteTitle;
  manifest.language = language;
  manifest.recordedAt = context.recordedAt;
  manifest.timezone = context.timezone;
  if (forceAiUpgrade) {
    manifest.repairingFallback = undefined;
    manifest.upgradingAi = true;
    manifest.error = undefined;
    // A forced upgrade must not reuse extractive or older model output.
    manifest.sections = [];
    return { repairWithStructuredFallback: false, changed: true };
  }
  if (shouldRepairWithStructuredFallback(
    manifest.status,
    manifest.savedNoteId,
    manifest.fallbackVersion,
    manifest.repairingFallback,
  )) {
    const repairReason = manifest.error;
    manifest.repairingFallback = true;
    return { repairWithStructuredFallback: true, repairReason, changed: true };
  }
  if (shouldUpgradeExtractiveFallback(
    manifest.status,
    manifest.enhancementMode,
    manifest.aiPipelineVersion,
  )) {
    manifest.upgradingAi = true;
    // Cached section output belongs to an older prompt/model policy.
    manifest.sections = [];
    return { repairWithStructuredFallback: false, changed: true };
  }
  return { repairWithStructuredFallback: false, changed: false };
}

// Counted before the work: a run killed mid-transcript must still spend its budget.
export function beginProcessingAttempt(manifest: ProcessingManifest, retryFromUser: boolean): void {
  manifest.attempt = retryFromUser ? 1 : (manifest.attempt ?? 0) + 1;
  manifest.failureKind = undefined;
  manifest.nextAttemptAt = undefined;
}

// Transcript changes invalidate every derived section. The sidecar is the
// durable source; cached note sections must never mix with a new run.
export function clearTranscriptState(manifest: ProcessingManifest): void {
  manifest.transcript = undefined;
  manifest.transcriptRevisionId = undefined;
  manifest.transcriptReviewIssues = undefined;
  manifest.enhancementStageKey = undefined;
  manifest.sections = [];
}

export function pauseProcessingForAccount(manifest: ProcessingManifest, attemptStarted = true): void {
  if (attemptStarted) manifest.attempt = Math.max(0, (manifest.attempt ?? 1) - 1);
  manifest.status = manifest.source === "import" && manifest.importPrepared === false ? "importing" : "transcribing";
  manifest.error = undefined;
  manifest.failureKind = undefined;
  manifest.nextAttemptAt = undefined;
}

export function recordProcessingFailure(manifest: ProcessingManifest, error: unknown): void {
  const attempt = manifest.attempt ?? 1;
  manifest.status = "failed";
  manifest.error = String(error);
  manifest.failureKind = classifyProcessingFailure(manifest.error, attempt);
  manifest.nextAttemptAt = manifest.failureKind === "retryable"
    ? nextProcessingAttemptAt(attempt)
    : undefined;
}

export interface ProcessingOutcome {
  usedStructuredFallback: boolean;
  processingDegraded: boolean;
  needsReview: boolean;
  processingError?: string;
  timings: Record<string, number>;
}

export function markProcessingFinished(manifest: ProcessingManifest, outcome: ProcessingOutcome): void {
  manifest.enhancementMode = outcome.usedStructuredFallback
    ? "extractive-fallback"
    : outcome.processingDegraded ? "hybrid" : "ai";
  if (outcome.usedStructuredFallback) manifest.fallbackVersion = 1;
  manifest.repairingFallback = undefined;
  manifest.aiPipelineVersion = CURRENT_AI_PIPELINE_VERSION;
  manifest.upgradingAi = undefined;
  manifest.timingsMs = outcome.timings;
  manifest.status = outcome.needsReview ? "partial" : "complete";
  manifest.error = manifest.status === "partial"
    ? outcome.processingError ?? "One or more transcript sections used a lossless fallback"
    : undefined;
  manifest.failureKind = undefined;
  manifest.nextAttemptAt = undefined;
}

export interface AcceptedDraft {
  noteTitle: string;
  noteUpdatedAt: string;
  canonicalTranscript: string;
  transcriptRevisionId?: string;
}

export function markDraftAccepted(manifest: ProcessingManifest, draft: AcceptedDraft): void {
  manifest.noteTitle = draft.noteTitle;
  manifest.savedNoteUpdatedAt = draft.noteUpdatedAt;
  manifest.transcript = draft.canonicalTranscript;
  manifest.transcriptionPipelineVersion = CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
  manifest.transcriptRevisionId = draft.transcriptRevisionId;
  manifest.enhancementStageKey = `note:${CURRENT_AI_PIPELINE_VERSION}:${manifest.language}:${draft.transcriptRevisionId ?? "unknown"}`;
  manifest.sections = [];
  manifest.enhancementMode = "ai";
  manifest.fallbackVersion = undefined;
  manifest.repairingFallback = undefined;
  manifest.aiPipelineVersion = CURRENT_AI_PIPELINE_VERSION;
  manifest.upgradingAi = undefined;
  manifest.transcriptReviewIssues = undefined;
  manifest.status = "complete";
  manifest.error = undefined;
}
