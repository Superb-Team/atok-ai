import { invokeCommand } from "@/lib/ipc";
import type { ProcessingManifest } from "@/features/note-generation/types";
import { errorMessage, logger } from "@/lib/logger";

// A read failure must not look like "no manifest" — that drops savedNoteId and duplicates the note.
export async function loadProcessingManifest(audioPath: string): Promise<ProcessingManifest | null> {
  const manifest = await invokeCommand<ProcessingManifest | null>("load_processing_manifest", { audioPath });
  if (!manifest || manifest.schemaVersion !== 1 || manifest.audioPath !== audioPath) return null;
  // Legacy v1 manifests predate compare-and-swap generations.
  manifest.generation ??= 0;
  return manifest;
}

export async function saveProcessingManifest(manifest: ProcessingManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  const saved = await invokeCommand<ProcessingManifest>("save_processing_manifest", {
    audioPath: manifest.audioPath,
    manifest,
  });
  manifest.generation = saved.generation;
  manifest.updatedAt = saved.updatedAt;
}

export function claimProcessingJob(audioPath: string, runId: string): Promise<boolean> {
  return invokeCommand<boolean>("claim_processing_job", { audioPath, runId });
}

// A leaked claim blocks every later run and reports as "already processing" — never swallow it.
export async function releaseProcessingJob(audioPath: string, runId: string): Promise<void> {
  await invokeCommand("release_processing_job", { audioPath, runId }).catch((error) => {
    logger.error("note_generation.claim_release_failed", {
      reason: errorMessage(error),
    });
  });
}
