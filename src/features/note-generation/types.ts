import type { ProcessingFailureKind } from "@/features/note-generation/lib/processing-review-policy";

export type ProcessingStatus = "importing" | "transcribing" | "extracting" | "synthesizing" | "saving" | "complete" | "partial" | "failed";

export interface ManifestSection {
  id: string;
  index: number;
  sourceHash: string;
  markdown: string;
  markers: string[];
  isDegraded: boolean;
  status: "complete" | "failed";
}

export interface ProcessingManifest {
  schemaVersion: 1;
  generation: number;
  jobId: string;
  ownerUserId?: string;
  source?: "import" | "recording";
  importSourcePath?: string;
  importGlossary?: string[];
  importPrepared?: boolean;
  audioPath: string;
  noteTitle: string;
  language: string;
  recordedAt?: string;
  timezone?: string;
  status: ProcessingStatus;
  transcript?: string;
  transcriptionPipelineVersion?: number;
  transcriptRevisionId?: string;
  transcriptReviewIssues?: string[];
  enhancementStageKey?: string;
  sections: ManifestSection[];
  savedNoteId?: number;
  savedNoteUpdatedAt?: string;
  failureNoteId?: number;
  enhancementMode?: "ai" | "hybrid" | "extractive-fallback";
  fallbackVersion?: number;
  repairingFallback?: boolean;
  aiPipelineVersion?: number;
  upgradingAi?: boolean;
  timingsMs?: Record<string, number>;
  error?: string;
  attempt?: number;
  nextAttemptAt?: string;
  failureKind?: ProcessingFailureKind;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptIntegrityReport {
  revisionId: string;
  transcriptSha256?: string;
  requiresReview: boolean;
  issues: Array<{ code: string; detail: string; advisory?: boolean }>;
}

export interface AudioProcessingResult {
  noteTitle: string;
  enhancedText: string;
  success: boolean;
  canonicalTranscript?: string;
  transcriptRevisionId?: string;
  warnings?: string[];
  outcome?: "note_created" | "draft_preview" | "no_speech" | "already_processing";
  message?: string;
  error?: string;
}

export interface AudioProcessingOptions {
  /** Background recovery must not rerun a job another worker already finished. */
  resumeOnly?: boolean;
  /** Re-run AI enhancement even when the manifest already reached the current version. */
  forceAiUpgrade?: boolean;
  /** Generate and validate content without saving the note or mutating the manifest. */
  previewOnly?: boolean;
  /** Operator recovery: restart the automatic retry budget for this recording. */
  retryFromUser?: boolean;
}
