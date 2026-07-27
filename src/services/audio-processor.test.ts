import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CURRENT_AI_PIPELINE_VERSION,
  shouldRecoverProcessingJob,
  shouldRepairWithStructuredFallback,
  shouldReviewGeneratedNote,
  shouldUpgradeExtractiveFallback,
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

  it("does not let a global editor rewrite already fact-checked map-reduce sections", () => {
    assert.equal(shouldReviewGeneratedNote({
      processingDegraded: false,
      loopSuspected: false,
      usedMapReduce: true,
      transcriptLength: 17_327,
    }), false);
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

  it("recovers interrupted jobs but never reopens terminal jobs", () => {
    assert.equal(shouldRecoverProcessingJob("transcribing", undefined), true);
    assert.equal(shouldRecoverProcessingJob("extracting", undefined), true);
    assert.equal(shouldRecoverProcessingJob("synthesizing", undefined), true);
    assert.equal(shouldRecoverProcessingJob("saving", undefined), true);
    assert.equal(shouldRecoverProcessingJob("failed", undefined), false);
    assert.equal(shouldRecoverProcessingJob("failed", undefined, true), false);
    assert.equal(shouldRecoverProcessingJob("complete", undefined), false);
    assert.equal(shouldRecoverProcessingJob("unknown-status", undefined), false);
  });

  it("upgrades a saved extractive fallback exactly once through the current AI pipeline", () => {
    assert.equal(
      shouldUpgradeExtractiveFallback("partial", "extractive-fallback", undefined),
      true,
    );
    assert.equal(
      shouldRecoverProcessingJob(
        "partial",
        1,
        false,
        "extractive-fallback",
        CURRENT_AI_PIPELINE_VERSION - 1,
      ),
      true,
    );
    assert.equal(
      shouldRecoverProcessingJob(
        "partial",
        1,
        false,
        "extractive-fallback",
        CURRENT_AI_PIPELINE_VERSION,
      ),
      false,
    );
    assert.equal(
      shouldRecoverProcessingJob(
        "saving",
        1,
        false,
        "extractive-fallback",
        CURRENT_AI_PIPELINE_VERSION,
        true,
      ),
      true,
    );
  });
});
