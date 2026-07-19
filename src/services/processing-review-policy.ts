// Roughly ten minutes of speech. Short clean drafts skip a second LLM round-trip.
const REVIEW_TRANSCRIPT_THRESHOLD = 6_000;

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
): boolean {
  if (status === "complete") return false;
  if (repairingFallback) return true;
  if (status === "partial") return (fallbackVersion ?? 0) < 1;
  return true;
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
