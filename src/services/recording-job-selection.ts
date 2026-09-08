export interface RecordingJobCandidate {
  savedNoteId?: number;
  failureNoteId?: number;
  transcript?: string;
  updatedAt: string;
}

export type NoteImprovementRoute<T extends RecordingJobCandidate> =
  | { kind: "recording"; job: T }
  | { kind: "retry_processing"; job: T }
  | { kind: "note" }
  | { kind: "missing_recording_source" };

function newestFirst<T extends RecordingJobCandidate>(jobs: readonly T[]): T[] {
  return [...jobs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function selectRecordingJobForNote<T extends RecordingJobCandidate>(
  jobs: readonly T[],
  noteId: number,
): T | undefined {
  return newestFirst(
    jobs.filter((job) => job.savedNoteId === noteId && Boolean(job.transcript?.trim())),
  )[0];
}

// A run that never produced a transcript still owns its audio, and the note the
// user is looking at may be the placeholder written when processing failed.
function selectRetryableJobForNote<T extends RecordingJobCandidate>(
  jobs: readonly T[],
  noteId: number,
): T | undefined {
  return newestFirst(
    jobs.filter((job) => job.savedNoteId === noteId || job.failureNoteId === noteId),
  )[0];
}

export function resolveNoteImprovementRoute<T extends RecordingJobCandidate>(
  jobs: readonly T[],
  noteId: number,
  isRecordingNote: boolean,
): NoteImprovementRoute<T> {
  const job = selectRecordingJobForNote(jobs, noteId);
  if (job) return { kind: "recording", job };
  const retryable = selectRetryableJobForNote(jobs, noteId);
  if (retryable) return { kind: "retry_processing", job: retryable };
  return isRecordingNote ? { kind: "missing_recording_source" } : { kind: "note" };
}
