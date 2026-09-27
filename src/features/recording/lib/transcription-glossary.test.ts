import assert from "node:assert/strict";
import test from "node:test";

import { parseTranscriptionGlossary } from "./transcription-glossary.ts";

test("parses arbitrary per-recording terms without built-in business vocabulary", () => {
  assert.deepEqual(
    parseTranscriptionGlossary("Acme Fiber, Siti Aminah\nRFI; acme fiber"),
    ["Acme Fiber", "Siti Aminah", "RFI"],
  );
});

test("empty glossary stays empty", () => {
  assert.deepEqual(parseTranscriptionGlossary("  , \n ; "), []);
});
