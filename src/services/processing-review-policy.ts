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
