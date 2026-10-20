import assert from "node:assert/strict";
import test from "node:test";
import { importPreparationErrorMessage, recordingProcessingErrorMessage } from "./recording-error-message.ts";

test("import preparation errors explain recovery without claiming an unsaved audio copy exists", () => {
  assert.match(importPreparationErrorMessage(new Error("No such file or directory")), /original location.*Retry/);
  assert.match(importPreparationErrorMessage("Failed to publish imported audio: no space left"), /disk space/);
  assert.match(importPreparationErrorMessage("corrupt audio packet"), /source file was kept/);
  const unknown = importPreparationErrorMessage('internals { "secret": "value" }');
  assert.match(unknown, /queue entry was kept/);
  assert.doesNotMatch(unknown, /secret|value|recording was saved/);
});

test("turns an empty provider response into a no-speech message", () => {
  const result = recordingProcessingErrorMessage(
    'Transcription returned empty. Response: Object {"segments": Array [], "text": String("")}',
  );
  assert.match(result, /no speech was detected/i);
  assert.doesNotMatch(result, /Object|segments|String/);
});

test("never exposes unknown provider internals", () => {
  const result = recordingProcessingErrorMessage(
    'Provider exploded. Response: Object {"request_id":"secret-debug-id"}',
  );
  assert.equal(
    result,
    "The recording was saved, but the note could not be processed. You can retry it from the recording later.",
  );
});
