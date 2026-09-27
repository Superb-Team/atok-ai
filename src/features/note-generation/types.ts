import type { ProcessingFailureKind } from "@/features/note-generation/lib/processing-review-policy";

export type ProcessingStatus = "transcribing" | "extracting" | "synthesizing" | "saving" | "complete" | "partial" | "failed";

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
