import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProcessingManifest } from '../../note-generation/lib/manifest-state.ts';
import { MAX_PROCESSING_ATTEMPTS } from '../../note-generation/lib/processing-review-policy.ts';
import type { ProcessingManifest } from '../../note-generation/types.ts';
import { prepareImportJob, resetImportRetryBudget } from './prepare-import-job.ts';

function fixture() {
  const manifest = createProcessingManifest('/recordings/import.mp3', 'Meeting', '', {
    recordedAt: '2026-08-30T03:00:00.000Z', timezone: 'Asia/Jakarta',
  });
  Object.assign(manifest, { source: 'import', ownerUserId: 'alice', status: 'importing',
    importPrepared: false, importSourcePath: '/original/meeting.wav', importGlossary: ['Siti'], attempt: 2 });
  let currentUser: string | undefined = 'alice';
  const events: string[] = [];
  const saved: ProcessingManifest[] = [];
  const store = {
    load: async (_path: string): Promise<ProcessingManifest | null> => manifest,
    save: async (value: ProcessingManifest) => { events.push('save'); saved.push(structuredClone(value)); },
    saveGlossary: async (_path: string, _terms: string[]) => { events.push('glossary'); },
    resume: async (_sourcePath: string, _outputPath: string) => { events.push('resume'); },
    currentUserId: () => currentUser,
  };
  return { manifest, store, events, saved, changeUser: (value?: string) => { currentUser = value; } };
}

test('conversion follows durable intent and successful preparation restores the previous attempt', async () => {
  const f = fixture();
  f.store.resume = async (source, output) => {
    assert.equal(source, '/original/meeting.wav');
    assert.equal(output, f.manifest.audioPath);
    assert.equal(f.saved[0].importSourcePath, source);
    assert.equal(f.saved[0].importPrepared, false);
    assert.equal(f.saved[0].attempt, 3);
    f.events.push('resume');
  };
  assert.equal(await prepareImportJob(f.manifest.audioPath, 'alice', f.store), true);
  assert.deepEqual(f.events, ['save', 'glossary', 'resume', 'save']);
  assert.equal(f.saved[f.saved.length - 1].attempt, 2);
  assert.equal(f.saved[f.saved.length - 1].status, 'transcribing');
  assert.equal(f.saved[f.saved.length - 1].importPrepared, true);
  assert.equal(f.saved[f.saved.length - 1].importSourcePath, undefined);
  assert.equal(f.saved[f.saved.length - 1].importGlossary, undefined);
});

test('recovers completed conversion through native resume using the persisted output path', async () => {
  const f = fixture();
  const completedOutputs = new Set([f.manifest.audioPath]);
  f.store.resume = async (source, output) => {
    assert.equal(source, f.saved[0].importSourcePath);
    assert.equal(completedOutputs.has(output), true);
    f.events.push('resume-existing-output');
  };
  assert.equal(await prepareImportJob(f.manifest.audioPath, 'alice', f.store), true);
  assert.deepEqual(f.events, ['save', 'glossary', 'resume-existing-output', 'save']);
  assert.equal(f.saved[f.saved.length - 1].importPrepared, true);
  assert.equal(f.saved[f.saved.length - 1].attempt, 2);
});

test('failed durable attempt write never starts conversion', async () => {
  const f = fixture();
  f.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(prepareImportJob(f.manifest.audioPath, 'alice', f.store), /disk full/);
  assert.deepEqual(f.events, []);
});

test('missing original source path is persisted as terminal instead of endlessly retried', async () => {
  const f = fixture();
  f.manifest.importSourcePath = undefined;
  await assert.rejects(prepareImportJob(f.manifest.audioPath, 'alice', f.store), /file path is missing/);
  assert.deepEqual(f.events, ['save', 'save']);
  assert.equal(f.saved[f.saved.length - 1].status, 'failed');
  assert.equal(f.saved[f.saved.length - 1].failureKind, 'terminal');
  assert.equal(f.saved[f.saved.length - 1].attempt, 3);
});

test('conversion failure is persisted and retains source metadata for a retry', async () => {
  const f = fixture();
  f.store.resume = async () => { throw new Error('Unsupported codec'); };
  await assert.rejects(prepareImportJob(f.manifest.audioPath, 'alice', f.store), /Unsupported codec/);
  assert.equal(f.saved[f.saved.length - 1].status, 'failed');
  assert.equal(f.saved[f.saved.length - 1].error, 'Error: Unsupported codec');
  assert.equal(f.saved[f.saved.length - 1].importPrepared, false);
  assert.equal(f.saved[f.saved.length - 1].importSourcePath, '/original/meeting.wav');
});

test('account change during glossary persistence pauses before conversion without spending budget', async () => {
  const f = fixture();
  f.store.saveGlossary = async () => { f.changeUser('bob'); };
  assert.equal(await prepareImportJob(f.manifest.audioPath, 'alice', f.store), false);
  assert.equal(f.events.includes('resume'), false);
  assert.equal(f.saved[f.saved.length - 1].attempt, 2);
  assert.equal(f.saved[f.saved.length - 1].status, 'importing');
  assert.equal(f.saved[f.saved.length - 1].failureKind, undefined);
});

test('logout during successful or failed conversion pauses and preserves source metadata', async () => {
  for (const conversionFails of [false, true]) {
    const f = fixture();
    f.store.resume = async () => { f.changeUser(); if (conversionFails) throw new Error('conversion failed'); };
    assert.equal(await prepareImportJob(f.manifest.audioPath, 'alice', f.store), false);
    assert.equal(f.saved[f.saved.length - 1].attempt, 2);
    assert.equal(f.saved[f.saved.length - 1].status, 'importing');
    assert.equal(f.saved[f.saved.length - 1].error, undefined);
    assert.equal(f.saved[f.saved.length - 1].importPrepared, false);
    assert.equal(f.saved[f.saved.length - 1].importSourcePath, '/original/meeting.wav');
  }
});

test('preparation ignores other owners, non-import jobs, completed jobs and prepared conversions', async () => {
  for (const change of [{ ownerUserId: 'bob' }, { source: 'recording' }, { status: 'complete' }, { attempt: MAX_PROCESSING_ATTEMPTS }]) {
    const f = fixture();
    Object.assign(f.manifest, change);
    assert.equal(await prepareImportJob(f.manifest.audioPath, 'alice', f.store), false);
    assert.deepEqual(f.events, []);
  }
  const f = fixture();
  f.manifest.importPrepared = true;
  assert.equal(await prepareImportJob(f.manifest.audioPath, 'alice', f.store), true);
  assert.deepEqual(f.events, []);
});

test('explicit retry resets terminal and exhausted in-flight imports while keeping durable identity', () => {
  for (const status of ['failed', 'importing', 'transcribing', 'extracting', 'synthesizing', 'saving'] as const) {
    const f = fixture();
    Object.assign(f.manifest, { status, attempt: MAX_PROCESSING_ATTEMPTS, error: 'old', failureKind: 'terminal', nextAttemptAt: 'later' });
    const id = f.manifest.jobId;
    assert.equal(resetImportRetryBudget(f.manifest), true);
    assert.equal(f.manifest.status, 'importing');
    assert.equal(f.manifest.attempt, 0);
    assert.equal(f.manifest.error, undefined);
    assert.equal(f.manifest.failureKind, undefined);
    assert.equal(f.manifest.nextAttemptAt, undefined);
    assert.equal(f.manifest.jobId, id);
  }
  const f = fixture();
  f.manifest.status = 'failed';
  f.manifest.attempt = 1;
  f.manifest.importPrepared = true;
  assert.equal(resetImportRetryBudget(f.manifest), true);
  assert.equal(f.manifest.status, 'transcribing');
});

test('retry never resets complete, partial, another source, or active imports within budget', () => {
  for (const status of ['complete', 'partial', 'importing', 'transcribing', 'extracting', 'synthesizing', 'saving'] as const) {
    const f = fixture();
    f.manifest.status = status;
    f.manifest.attempt = status === 'complete' || status === 'partial' ? MAX_PROCESSING_ATTEMPTS : 1;
    const before = structuredClone(f.manifest);
    assert.equal(resetImportRetryBudget(f.manifest), false);
    assert.deepEqual(f.manifest, before);
  }
  const f = fixture();
  f.manifest.source = 'recording';
  f.manifest.status = 'failed';
  assert.equal(resetImportRetryBudget(f.manifest), false);
});
