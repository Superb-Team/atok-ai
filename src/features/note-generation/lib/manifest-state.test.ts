import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginProcessingAttempt,
  createProcessingManifest,
  markProcessingFinished,
  planRerun,
  recordProcessingFailure,
} from "./manifest-state.ts";

const context = { recordedAt: "2026-09-27T03:00:00.000Z", timezone: "Asia/Jakarta" };
const cachedSection = {
  id: "section-0001",
  index: 0,
  sourceHash: "h",
  markdown: "- cached",
  markers: [],
  isDegraded: false,
  status: "complete" as const,
};

function manifest(overrides = {}) {
  return { ...createProcessingManifest("/rec.wav", "Recording", "id", context), ...overrides };
}

describe("planRerun", () => {
  it("drops cached sections on a forced AI upgrade", () => {
    const m = manifest({ status: "partial", savedNoteId: 1, sections: [cachedSection], error: "old" });
    const plan = planRerun(m, "New title", "en", context, true);
    assert.deepEqual(plan, { repairWithStructuredFallback: false, changed: true });
    assert.deepEqual(m.sections, []);
    assert.equal(m.upgradingAi, true);
    assert.equal(m.error, undefined);
    assert.equal(m.noteTitle, "New title");
  });

  it("repairs a saved partial note that never got the structured fallback", () => {
    const m = manifest({ status: "partial", savedNoteId: 1, error: "provider down", sections: [cachedSection] });
    const plan = planRerun(m, "Recording", "id", context, false);
    assert.deepEqual(plan, { repairWithStructuredFallback: true, repairReason: "provider down", changed: true });
    assert.equal(m.repairingFallback, true);
    assert.equal(m.sections.length, 1);
  });

  it("upgrades an extractive fallback made by an older AI pipeline", () => {
    const m = manifest({
      status: "partial",
      savedNoteId: 1,
      fallbackVersion: 1,
      enhancementMode: "extractive-fallback",
      aiPipelineVersion: 0,
      sections: [cachedSection],
    });
    const plan = planRerun(m, "Recording", "id", context, false);
    assert.deepEqual(plan, { repairWithStructuredFallback: false, changed: true });
    assert.deepEqual(m.sections, []);
  });

  it("keeps cached work for an interrupted run", () => {
    const m = manifest({ status: "extracting", sections: [cachedSection] });
    assert.deepEqual(planRerun(m, "Recording", "id", context, false), {
      repairWithStructuredFallback: false,
      changed: false,
    });
    assert.equal(m.sections.length, 1);
  });
});

describe("attempt accounting", () => {
  it("counts attempts and resets the budget on a user retry", () => {
    const m = manifest({ attempt: 3, failureKind: "retryable" });
    beginProcessingAttempt(m, false);
    assert.equal(m.attempt, 4);
    assert.equal(m.failureKind, undefined);
    beginProcessingAttempt(m, true);
    assert.equal(m.attempt, 1);
  });

  it("schedules a retry only for transient failures", () => {
    const m = manifest({ attempt: 1 });
    recordProcessingFailure(m, new Error("chat request failed after retries"));
    assert.equal(m.status, "failed");
    assert.equal(m.failureKind, "retryable");
    assert.ok(m.nextAttemptAt);

    recordProcessingFailure(m, new Error("invalid audio file"));
    assert.equal(m.failureKind, "terminal");
    assert.equal(m.nextAttemptAt, undefined);
  });
});

describe("markProcessingFinished", () => {
  it("marks a note needing review as partial with a reason", () => {
    const m = manifest();
    markProcessingFinished(m, {
      usedStructuredFallback: true,
      processingDegraded: true,
      needsReview: true,
      timings: { total: 10 },
    });
    assert.equal(m.status, "partial");
    assert.equal(m.enhancementMode, "extractive-fallback");
    assert.equal(m.fallbackVersion, 1);
    assert.equal(m.error, "One or more transcript sections used a lossless fallback");
  });

  it("clears the error for a clean AI note", () => {
    const m = manifest({ error: "old" });
    markProcessingFinished(m, {
      usedStructuredFallback: false,
      processingDegraded: false,
      needsReview: false,
      timings: {},
    });
    assert.equal(m.status, "complete");
    assert.equal(m.enhancementMode, "ai");
    assert.equal(m.error, undefined);
  });
});
