import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldReviewGeneratedNote } from "./processing-review-policy.ts";

describe("shouldReviewGeneratedNote", () => {
  it("does not send a lossless fallback through another AI request", () => {
    assert.equal(shouldReviewGeneratedNote({
      processingDegraded: true,
      loopSuspected: true,
      usedMapReduce: false,
      transcriptLength: 17_327,
    }), false);
  });

  it("reviews a long successful single-pass draft", () => {
    assert.equal(shouldReviewGeneratedNote({
      processingDegraded: false,
      loopSuspected: false,
      usedMapReduce: false,
      transcriptLength: 17_327,
    }), true);
  });
});
