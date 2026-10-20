import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistImportedJob } from './persist-import-job.ts';
import type { ProcessingManifest } from '../../note-generation/types.ts';

const input = { audioPath: '/recordings/a.mp3', sourcePath: '/original/meeting.wav', noteTitle: 'Meeting', language: '', glossary: ['Siti'],
  context: { recordedAt: '2026-08-30T03:00:00.000Z', timezone: 'Asia/Jakarta' }, userId: 'alice' };

function fixture() {
  const events: string[] = [];
  let manifest: ProcessingManifest | null = null;
  const store = {
    claim: async () => { events.push('claim'); return true; },
    release: async () => { events.push('release'); },
    load: async (): Promise<ProcessingManifest | null> => manifest,
    save: async (value: ProcessingManifest) => { events.push('save'); manifest = value; },
    currentUserId: () => 'alice' as string | undefined,
  };
  return { store, events, getManifest: () => manifest };
}

test('durably queues independent imports with glossary, auto language, ownership and meeting time', async () => {
  const f = fixture();
  await persistImportedJob(input, f.store);
  assert.deepEqual(f.events, ['claim', 'save', 'release']);
  const first = f.getManifest()!;
  assert.equal(first.ownerUserId, 'alice');
  assert.equal(first.source, 'import');
  assert.equal(first.language, '');
  assert.equal(first.recordedAt, input.context.recordedAt);
  assert.equal(first.timezone, 'Asia/Jakarta');
  assert.equal(first.status, 'importing');
  assert.equal(first.importPrepared, false);
  const restored = JSON.parse(JSON.stringify(first));
  assert.equal(restored.importSourcePath, input.sourcePath);
  assert.deepEqual(restored.importGlossary, input.glossary);
  const second = fixture();
  await persistImportedJob({ ...input, audioPath: '/recordings/b.mp3' }, second.store);
  assert.notEqual(second.getManifest()!.jobId, first.jobId);
});

test('retry after successful persistence keeps the existing job identity', async () => {
  const f = fixture();
  await persistImportedJob(input, f.store);
  const id = f.getManifest()!.jobId;
  await persistImportedJob(input, f.store);
  assert.equal(f.getManifest()!.jobId, id);
  assert.equal(f.events.filter(event => event === 'save').length, 1);
});

test('failed intent persistence releases the claim before any audio preparation', async () => {
  const f = fixture();
  f.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(persistImportedJob(input, f.store), /disk full/);
  assert.deepEqual(f.events, ['claim', 'release']);
  assert.equal(f.getManifest(), null);
});

test('account switch while loading never queues under another account', async () => {
  const f = fixture();
  f.store.load = async () => { f.store.currentUserId = () => 'bob'; return null; };
  await assert.rejects(persistImportedJob(input, f.store), /account changed/);
  assert.equal(f.getManifest(), null);
  assert.equal(f.events[f.events.length - 1], 'release');
});

test('a failed claim release reports failure but retry preserves the already durable job', async () => {
  const f = fixture();
  f.store.release = async () => { throw new Error('release failed'); };
  await assert.rejects(persistImportedJob(input, f.store), /release failed/);
  const id = f.getManifest()!.jobId;
  f.store.release = async () => {};
  await persistImportedJob(input, f.store);
  assert.equal(f.getManifest()!.jobId, id);
  assert.equal(f.events.filter(event => event === 'save').length, 1);
});

test('cannot overwrite an import owned by another account or steal an active claim', async () => {
  const f = fixture();
  await persistImportedJob(input, f.store);
  f.getManifest()!.ownerUserId = 'bob';
  await assert.rejects(persistImportedJob(input, f.store), /another account/);
  f.store.claim = async () => false;
  await assert.rejects(persistImportedJob(input, f.store), /already being queued/);
});
