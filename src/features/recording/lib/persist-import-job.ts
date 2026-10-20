import { createProcessingManifest } from '../../note-generation/lib/manifest-state.ts';
import type { ProcessingManifest } from '../../note-generation/types.ts';
import type { RecordingNoteContext } from './recording-note-metadata.ts';

export async function persistImportedJob(input: {
  audioPath: string;
  sourcePath: string;
  noteTitle: string;
  language: string;
  glossary: string[];
  context: RecordingNoteContext;
  userId: string;
}, store: {
  claim: (path: string, runId: string) => Promise<boolean>;
  release: (path: string, runId: string) => Promise<void>;
  load: (path: string) => Promise<ProcessingManifest | null>;
  save: (manifest: ProcessingManifest) => Promise<void>;
  currentUserId: () => string | undefined;
}): Promise<void> {
  const runId = globalThis.crypto.randomUUID();
  if (!await store.claim(input.audioPath, runId)) throw new Error('This import is already being queued. Try again in a moment.');
  try {
    if (store.currentUserId() !== input.userId) throw new Error('The signed-in account changed. Import the file again.');
    const existing = await store.load(input.audioPath);
    if (store.currentUserId() !== input.userId) throw new Error('The signed-in account changed. Import the file again.');
    if (existing) {
      if (existing.ownerUserId !== input.userId || existing.source !== 'import') throw new Error('This import belongs to another account.');
      return;
    }
    const manifest = createProcessingManifest(input.audioPath, input.noteTitle, input.language, input.context);
    manifest.ownerUserId = input.userId;
    manifest.source = 'import';
    manifest.status = 'importing';
    manifest.importPrepared = false;
    manifest.importSourcePath = input.sourcePath;
    manifest.importGlossary = input.glossary;
    await store.save(manifest);
  } finally {
    await store.release(input.audioPath, runId);
  }
}
