import { invoke } from "@tauri-apps/api/core";
import type { ProcessingManifest } from "@/features/note-generation/types";

// A read failure must not look like "no manifest" — that drops savedNoteId and duplicates the note.
export async function loadProcessingManifest(audioPath: string): Promise<ProcessingManifest | null> {
  const manifest = await invoke<ProcessingManifest | null>("load_processing_manifest", { audioPath });
  if (!manifest || manifest.schemaVersion !== 1 || manifest.audioPath !== audioPath) return null;
  // Legacy v1 manifests predate compare-and-swap generations.
  manifest.generation ??= 0;
  return manifest;
}

export async function saveProcessingManifest(manifest: ProcessingManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  const saved = await invoke<ProcessingManifest>("save_processing_manifest", {
    audioPath: manifest.audioPath,
    manifest,
  });
  manifest.generation = saved.generation;
  manifest.updatedAt = saved.updatedAt;
}

export function claimProcessingJob(audioPath: string, runId: string): Promise<boolean> {
  return invoke<boolean>("claim_processing_job", { audioPath, runId });
}

// A leaked claim blocks every later run and reports as "already processing" — never swallow it.
export async function releaseProcessingJob(audioPath: string, runId: string): Promise<void> {
  await invoke("release_processing_job", { audioPath, runId }).catch((error) => {
    console.error(JSON.stringify({
      event: "recording_claim_release_failed",
      reason: String(error),
    }));
  });
}
