import assert from "node:assert/strict";
import test from "node:test";
import { recordingProcessingErrorMessage } from "./recording-error-message.ts";

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
