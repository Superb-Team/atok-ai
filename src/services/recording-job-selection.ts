export interface RecordingJobCandidate {
  savedNoteId?: number;
  transcript?: string;
  updatedAt: string;
}

export type NoteImprovementRoute<T extends RecordingJobCandidate> =
  | { kind: "recording"; job: T }
  | { kind: "note" }
  | { kind: "missing_recording_source" };

export function selectRecordingJobForNote<T extends RecordingJobCandidate>(
  jobs: readonly T[],
  noteId: number,
): T | undefined {
  return jobs
    .filter((job) => job.savedNoteId === noteId && Boolean(job.transcript?.trim()))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function resolveNoteImprovementRoute<T extends RecordingJobCandidate>(
  jobs: readonly T[],
  noteId: number,
  isRecordingNote: boolean,
): NoteImprovementRoute<T> {
  const job = selectRecordingJobForNote(jobs, noteId);
  if (job) return { kind: "recording", job };
  return isRecordingNote ? { kind: "missing_recording_source" } : { kind: "note" };
}
