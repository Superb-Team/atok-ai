import { beginProcessingAttempt, pauseProcessingForAccount, recordProcessingFailure } from '../../note-generation/lib/manifest-state.ts';
import { MAX_PROCESSING_ATTEMPTS, shouldRecoverProcessingJob } from '../../note-generation/lib/processing-review-policy.ts';
import type { ProcessingManifest } from '../../note-generation/types.ts';

interface ImportPreparationStore {
  load: (path: string) => Promise<ProcessingManifest | null>;
  save: (manifest: ProcessingManifest) => Promise<void>;
  saveGlossary: (path: string, terms: string[]) => Promise<void>;
  resume: (sourcePath: string, outputPath: string) => Promise<void>;
  currentUserId: () => string | undefined;
}

// The caller must hold the native processing claim for the whole preparation.
export async function prepareImportJob(audioPath: string, userId: string, store: ImportPreparationStore): Promise<boolean> {
  const manifest = await store.load(audioPath);
  if (!manifest || manifest.source !== 'import' || manifest.ownerUserId !== userId || store.currentUserId() !== userId) return false;
  if (!shouldRecoverProcessingJob(manifest)) return false;
  if (manifest.importPrepared !== false) return true;
  const priorAttempt = manifest.attempt ?? 0;
  beginProcessingAttempt(manifest, false);
  await store.save(manifest);
  try {
    if (!manifest.importSourcePath) throw new Error('The original imported file path is missing. Import the file again.');
    await store.saveGlossary(audioPath, manifest.importGlossary ?? []);
    if (store.currentUserId() !== userId) {
      pauseProcessingForAccount(manifest);
      await store.save(manifest);
      return false;
    }
    await store.resume(manifest.importSourcePath, audioPath);
    if (store.currentUserId() !== userId) {
      pauseProcessingForAccount(manifest);
      await store.save(manifest);
      return false;
    }
    manifest.importPrepared = true;
    manifest.importSourcePath = undefined;
    manifest.importGlossary = undefined;
    manifest.status = 'transcribing';
    manifest.attempt = priorAttempt;
    await store.save(manifest);
    return true;
  } catch (error) {
    if (store.currentUserId() !== userId) {
      pauseProcessingForAccount(manifest);
      manifest.attempt = priorAttempt;
      await store.save(manifest);
      return false;
    }
    recordProcessingFailure(manifest, error);
    await store.save(manifest);
    throw error;
  }
}

export function resetImportRetryBudget(manifest: ProcessingManifest): boolean {
  const exhaustedInFlight = (manifest.attempt ?? 0) >= MAX_PROCESSING_ATTEMPTS
    && ['importing', 'transcribing', 'extracting', 'synthesizing', 'saving'].includes(manifest.status);
  if (manifest.source !== 'import' || (manifest.status !== 'failed' && !exhaustedInFlight)) return false;
  manifest.status = manifest.importPrepared === false ? 'importing' : 'transcribing';
  manifest.attempt = 0;
  manifest.error = undefined;
  manifest.failureKind = undefined;
  manifest.nextAttemptAt = undefined;
  return true;
}
