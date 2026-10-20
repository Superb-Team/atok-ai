import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { createProcessingManifest } from '../lib/manifest-state.ts';
import { pendingRecordingContent } from '../lib/pending-recording-note.ts';
import type { Note } from '../../notes/types.ts';
import type { ProcessingRun } from './processing-run.ts';
import type { GeneratedNote } from './save-note.ts';

// Load the real pipeline with its app aliases, without a browser or Tauri IPC.
test('recording saves recover an idempotent placeholder and preserve account/manual edit boundaries', async t => {
  const server = await createServer({ configFile: false, logLevel: 'silent',
    resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  try {
    const { saveGeneratedNote } = await server.ssrLoadModule('/src/features/note-generation/pipeline/save-note.ts');
    const { noteService, NoteConflictError } = await server.ssrLoadModule('/src/features/notes/api/note.service.ts');
    const { authService } = await server.ssrLoadModule('/src/features/auth/api/auth.service.ts');
    const { logger } = await server.ssrLoadModule('/src/lib/logger.ts');
    logger.info = logger.warn = () => {};
    const context = { recordedAt: '2026-08-30T03:00:00.000Z', timezone: 'Asia/Jakarta' };
    const generated: GeneratedNote = { title: 'Meeting result', content: '# Verified transcript',
      processingDegraded: false, usedStructuredFallback: false, hasFailedSection: false,
      transcriptRequiresReview: true, needsReview: true };
    function fixture(content = pendingRecordingContent('Meeting', 'id')) {
      const manifest = createProcessingManifest('/import.mp3', 'Meeting', 'id', context);
      manifest.ownerUserId = 'alice';
      let stored: Note = { id: 17, title: 'Meeting', content, updated_at: 'original-version',
        created_at: 'original-version', is_favorite: false, is_archived: false };
      let writes = 0;
      let creates = 0;
      authService.getUser = () => ({ id: 'alice' });
      noteService.createRecordingNote = async (owner: string, jobId: string) => {
        assert.equal(owner, 'alice'); assert.equal(jobId, manifest.jobId); creates++;
        return stored;
      };
      noteService.updateNote = async (id: number, owner: string, changes: { expected_updated_at: string; content: string; title: string }) => {
        assert.equal(id, 17); assert.equal(owner, 'alice');
        assert.equal(changes.expected_updated_at, stored.updated_at);
        writes++; stored = { ...stored, ...changes, updated_at: 'new-version' }; return stored;
      };
      const run: ProcessingRun = { audioPath: manifest.audioPath, noteTitle: 'Meeting', lang: 'id', langName: 'Indonesian',
        context, manifest, previewOnly: false, startedAt: performance.now(), timings: {},
        persist: async () => {}, persistBestEffort: async () => {} };
      return { run, read: () => stored, writes: () => writes, creates: () => creates };
    }
    await t.test('crash before placeholder ID checkpoint updates the same DB note on recovery', async () => {
      const f = fixture();
      await saveGeneratedNote(f.run, generated);
      assert.equal(f.run.manifest.savedNoteId, 17);
      assert.equal(f.read().content, generated.content);
      assert.equal(f.run.manifest.savedNoteUpdatedAt, 'new-version');
      assert.equal(f.writes(), 1);
      assert.equal(f.creates(), 1);
      assert.equal(f.run.manifest.status, 'partial');
    });
    await t.test('an existing job note with user edits survives recovery', async () => {
      const f = fixture('My manually edited note');
      await saveGeneratedNote(f.run, generated);
      assert.equal(f.read().content, 'My manually edited note');
      assert.equal(f.writes(), 0);
    });
    await t.test('a concurrent manual edit conflict preserves the existing note', async () => {
      const f = fixture();
      noteService.updateNote = async () => { throw new NoteConflictError(); };
      await saveGeneratedNote(f.run, generated);
      assert.equal(f.read().content, pendingRecordingContent('Meeting', 'id'));
      assert.equal(f.writes(), 0);
    });
    await t.test('account changes prevent all DB writes', async () => {
      const f = fixture();
      authService.getUser = () => ({ id: 'bob' });
      await assert.rejects(saveGeneratedNote(f.run, generated), /account changed/);
      assert.equal(f.creates(), 0);
      assert.equal(f.writes(), 0);
    });
  } finally { await server.close(); }
});
