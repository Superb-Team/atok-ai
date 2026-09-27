import type { RecordingNoteContext } from "@/features/recording/lib/recording-note-metadata";
import type { ProcessingManifest } from "@/features/note-generation/types";

/** State shared by every stage of one processing run. */
export interface ProcessingRun {
  audioPath: string;
  noteTitle: string;
  /** ISO-639-1 code; "" means auto-detect. */
  lang: string;
  langName: string;
  context: RecordingNoteContext;
  manifest: ProcessingManifest;
  /** Generate without saving the note or mutating the manifest. */
  previewOnly: boolean;
  startedAt: number;
  timings: Record<string, number>;
  persist: () => Promise<void>;
  persistBestEffort: () => Promise<void>;
}

export function markStage(run: ProcessingRun, stage: string, since: number): void {
  run.timings[stage] = Math.round(performance.now() - since);
}
