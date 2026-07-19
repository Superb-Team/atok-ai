import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecordingProcessingGuard,
  installAsyncListener,
} from "./recording-processing-guard.ts";

test("coalesces concurrent processing requests for the same audio path", async () => {
  const guard = createRecordingProcessingGuard();
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<string>((resolve) => {
    release = () => resolve("done");
  });

  const first = guard.run("/recordings/meeting.mp3", async () => {
    calls += 1;
    return pending;
  });
  const second = guard.run("/recordings/meeting.mp3", async () => {
    calls += 1;
    return "duplicate";
  });

  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, "done");
});

test("allows a later retry after the active processing request settles", async () => {
  const guard = createRecordingProcessingGuard();
  let calls = 0;

  await guard.run("/recordings/meeting.mp3", async () => ++calls);
  await guard.run("/recordings/meeting.mp3", async () => ++calls);

  assert.equal(calls, 2);
});

test("unlistens when cleanup happens before async listener registration resolves", async () => {
  let resolveRegistration!: (unlisten: () => void) => void;
  let unlistenCalls = 0;
  const registration = new Promise<() => void>((resolve) => {
    resolveRegistration = resolve;
  });

  const cleanup = installAsyncListener(
    () => registration,
    () => undefined,
  );
  cleanup();
  resolveRegistration(() => {
    unlistenCalls += 1;
  });
  await registration;
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.equal(unlistenCalls, 1);
});
