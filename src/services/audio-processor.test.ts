import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  shouldRecoverProcessingJob,
  shouldRepairWithStructuredFallback,
  shouldReviewGeneratedNote,
} from "./processing-review-policy.ts";

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

describe("processing recovery policy", () => {
  it("repairs a legacy partial job exactly until fallback version 1 is persisted", () => {
    assert.equal(shouldRecoverProcessingJob("partial", undefined), true);
    assert.equal(shouldRepairWithStructuredFallback("partial", 128, undefined), true);
    assert.equal(shouldRecoverProcessingJob("partial", 1), false);
    assert.equal(shouldRepairWithStructuredFallback("partial", 128, 1), false);
    assert.equal(shouldRecoverProcessingJob("partial", 2), false);
    assert.equal(shouldRepairWithStructuredFallback("partial", 128, 2), false);
    assert.equal(shouldRecoverProcessingJob("saving", undefined, true), true);
    assert.equal(shouldRepairWithStructuredFallback("saving", 128, undefined, true), true);
  });

  it("continues recovering unfinished jobs but never reopens complete jobs", () => {
    assert.equal(shouldRecoverProcessingJob("extracting", undefined), true);
    assert.equal(shouldRecoverProcessingJob("failed", undefined), true);
    assert.equal(shouldRecoverProcessingJob("complete", undefined), false);
  });
});
