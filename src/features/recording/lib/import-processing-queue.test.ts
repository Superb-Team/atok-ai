import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImportProcessingQueue, isRecoverableImport, type ImportJob } from './import-processing-queue.ts';

const job = (path: string): ImportJob => ({ audioPath: path, noteTitle: path, language: '', ownerUserId: 'alice', source: 'import', status: 'transcribing' });

test('serializes imports and coalesces overlapping drains without losing either recording', async () => {
  const jobs = [job('first'), job('second')];
  const events: string[] = [];
  let resolveFirst!: () => void;
  const gate = new Promise<void>(resolve => { resolveFirst = resolve; });
  const queue = new ImportProcessingQueue({ userId: 'alice', list: async () => jobs,
    load: async path => jobs.find(item => item.audioPath === path)!, isCurrentUser: () => true,
    onJobs: () => {}, onError: error => { throw error; },
    process: async item => {
      events.push(`start:${item.audioPath}`);
      if (item.audioPath === 'first') await gate;
      events.push(`end:${item.audioPath}`);
    },
  });
  const firstDrain = queue.drain();
  const secondDrain = queue.drain();
  assert.equal(firstDrain, secondDrain);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['start:first']);
  resolveFirst();
  await firstDrain;
  assert.deepEqual(events, ['start:first', 'end:first', 'start:second', 'end:second']);
});

test('recovers persisted imports after restart and continues after one job fails', async () => {
  const jobs = [job('broken'), job('valid')];
  const processed: string[] = [];
  const errors: unknown[] = [];
  const queue = new ImportProcessingQueue({ userId: 'alice', list: async () => jobs,
    load: async path => jobs.find(item => item.audioPath === path)!, isCurrentUser: () => true,
    onJobs: () => {}, onError: error => errors.push(error),
    process: async item => { processed.push(item.audioPath); if (item.audioPath === 'broken') throw new Error('bad'); },
  });
  await queue.drain();
  assert.deepEqual(processed, ['broken', 'valid']);
  assert.equal(errors.length, 1);
});

test('does not resume another account, live recordings, terminal failures, or completed imports', () => {
  assert.equal(isRecoverableImport(job('a'), 'alice'), true);
  assert.equal(isRecoverableImport({ ...job('a'), status: 'importing' }, 'alice'), true);
  assert.equal(isRecoverableImport(job('a'), 'bob'), false);
  assert.equal(isRecoverableImport({ ...job('a'), ownerUserId: undefined }, 'alice'), false);
  assert.equal(isRecoverableImport({ ...job('a'), source: 'recording' }, 'alice'), false);
  assert.equal(isRecoverableImport({ ...job('a'), status: 'complete' }, 'alice'), false);
  assert.equal(isRecoverableImport({ ...job('a'), status: 'failed', failureKind: 'terminal' }, 'alice'), false);
  assert.equal(isRecoverableImport({ ...job('a'), attempt: 4 }, 'alice'), false);
});

test('reloads state before processing and stops queued jobs when the account changes', async () => {
  let currentUser = true;
  const processed: string[] = [];
  const jobs = [job('finished'), job('first'), job('second')];
  const queue = new ImportProcessingQueue({ userId: 'alice', list: async () => jobs,
    load: async path => path === 'finished' ? { ...job(path), status: 'complete' } : job(path),
    isCurrentUser: () => currentUser, onJobs: () => {}, onError: error => { throw error; },
    process: async item => { processed.push(item.audioPath); currentUser = false; },
  });
  await queue.drain();
  assert.deepEqual(processed, ['first']);
});
