import test from "node:test";
import assert from "node:assert/strict";
import { blockingQualityWarnings, requiresCaptureReview } from "./recording-quality-policy.ts";

test("track imbalance is advisory for legacy quality reports", () => {
  const warnings = ["track_imbalance: chunk 0 microphone/system RMS differs by 30dB"];

  assert.deepEqual(blockingQualityWarnings(warnings), []);
  assert.equal(requiresCaptureReview(true, warnings), false);
});

test("marginal microphone clipping is advisory", () => {
  const warnings = ["mic_clipping_advisory: chunk 8 has 0.60% near-full-scale samples"];

  assert.deepEqual(blockingQualityWarnings(warnings), []);
  assert.equal(requiresCaptureReview(true, warnings), false);
});

test("known capture failures remain review-required", () => {
  const warnings = [
    "track_imbalance: chunk 0 microphone/system RMS differs by 30dB",
    "mic_clipping: chunk 0 has 1.2% near-full-scale samples",
  ];

  assert.deepEqual(blockingQualityWarnings(warnings), [warnings[1]]);
  assert.equal(requiresCaptureReview(true, warnings), true);
});

test("missing diagnostics fail closed when a report requires review", () => {
  assert.equal(requiresCaptureReview(true, []), true);
  assert.equal(requiresCaptureReview(false, ["unknown_warning: value"]), false);
});
