import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CURRENT_AI_PIPELINE_VERSION,
  CURRENT_TRANSCRIPTION_PIPELINE_VERSION,
  shouldRecoverProcessingJob,
  shouldRepairWithStructuredFallback,
  shouldReviewGeneratedNote,
  shouldPublishRecordingToRag,
  shouldOpenAiDraftPreview,
  shouldRefreshTranscript,
  shouldUpgradeExtractiveFallback,
} from "./processing-review-policy.ts";
import { stripTranscriptSection } from "./canonical-transcript.ts";
import { appendTranscriptReviewSections } from "./transcript-review-sections.ts";

describe("canonical transcript separation", () => {
  it("removes a model-created Indonesian transcript section from the note", () => {
    const draft = `# Topik\n\n## Ringkasan\n\nRingkasan.\n\n## Transcript Lengkap\n\nModel menghilangkan detail.`;

    const result = stripTranscriptSection(draft);

    assert.equal(result, "# Topik\n\n## Ringkasan\n\nRingkasan.");
  });

  it("leaves a note without a transcript section unchanged", () => {
    const note = "# Topic\n\n## Summary\n\nFacts.";

    assert.equal(stripTranscriptSection(note), note);
  });
});

describe("review sections", () => {
  it("separates transcript evidence issues from capture diagnostics", () => {
    const result = appendTranscriptReviewSections(
      "# Rapat\n\n## Ringkasan\n\nIsi.",
      [
        "missing_timestamp_provenance: Provider tidak mengembalikan timestamp.",
        "audio_quality_requires_review: mic_clipping: chunk 0 has clipped samples",
      ],
      "id",
    );

    assert.match(result, /## Perlu Verifikasi Transkrip/u);
    assert.match(result, /## Kualitas Capture/u);
    assert.ok(result.indexOf("missing_timestamp_provenance") < result.indexOf("Kualitas Capture"));
    assert.ok(result.indexOf("mic_clipping") > result.indexOf("Kualitas Capture"));
  });
});

describe("recording publication gate", () => {
  it("fails closed when transcript evidence requires review", () => {
    assert.equal(shouldPublishRecordingToRag({
      processingDegraded: false,
      hasFailedSection: false,
      transcriptRequiresReview: true,
      noteWasManuallyEdited: false,
    }), false);
  });

  it("publishes only a clean, unmodified recording note", () => {
    assert.equal(shouldPublishRecordingToRag({
      processingDegraded: false,
      hasFailedSection: false,
      transcriptRequiresReview: false,
      noteWasManuallyEdited: false,
    }), true);
  });
});

describe("AI draft preview gate", () => {
  it("opens a non-empty draft even when review warnings remain", () => {
    assert.equal(shouldOpenAiDraftPreview(true, false), true);
  });

  it("blocks empty drafts and provider-wide structured fallbacks", () => {
    assert.equal(shouldOpenAiDraftPreview(false, false), false);
    assert.equal(shouldOpenAiDraftPreview(true, true), false);
  });
});

describe("shouldReviewGeneratedNote", () => {
  it("does not send a lossless fallback through another AI request", () => {
    assert.equal(shouldReviewGeneratedNote({
      processingDegraded: true,
      loopSuspected: true,
      usedMapReduce: false,
      transcriptLength: 17_327,
    }), false);
  });

  it("does not add a second provider pass solely because a transcript is long", () => {
    assert.equal(shouldReviewGeneratedNote({
      processingDegraded: false,
      loopSuspected: false,
      usedMapReduce: false,
      transcriptLength: 17_327,
    }), false);
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
  it("refreshes manifests written before the transcript normalization pipeline", () => {
    assert.equal(shouldRefreshTranscript(undefined), true);
    assert.equal(
      shouldRefreshTranscript(CURRENT_TRANSCRIPTION_PIPELINE_VERSION - 1),
      true,
    );
    assert.equal(
      shouldRefreshTranscript(CURRENT_TRANSCRIPTION_PIPELINE_VERSION),
      false,
    );
  });

  it("keeps terminal partial jobs idle until an explicit user retry", () => {
    assert.equal(shouldRecoverProcessingJob("partial", undefined), false);
    assert.equal(shouldRepairWithStructuredFallback("partial", 128, undefined), true);
    assert.equal(shouldRecoverProcessingJob("partial", 1), false);
    assert.equal(
      shouldRecoverProcessingJob(
        "partial",
        1,
        false,
        undefined,
        CURRENT_AI_PIPELINE_VERSION,
        false,
        undefined,
        true,
      ),
      false,
    );
    assert.equal(
      shouldRecoverProcessingJob(
        "partial",
        1,
        false,
        undefined,
        CURRENT_AI_PIPELINE_VERSION,
        false,
        CURRENT_TRANSCRIPTION_PIPELINE_VERSION - 1,
        false,
      ),
      false,
    );
    assert.equal(
      shouldRecoverProcessingJob(
        "partial",
        1,
        false,
        undefined,
        CURRENT_AI_PIPELINE_VERSION,
        false,
        1,
        true,
      ),
      false,
    );
    assert.equal(
      shouldRecoverProcessingJob(
        "partial",
        1,
        false,
        undefined,
        CURRENT_AI_PIPELINE_VERSION,
        false,
        CURRENT_TRANSCRIPTION_PIPELINE_VERSION,
        true,
      ),
      false,
    );
    assert.equal(shouldRepairWithStructuredFallback("partial", 128, 1), false);
    assert.equal(shouldRecoverProcessingJob("partial", 2), false);
    assert.equal(shouldRepairWithStructuredFallback("partial", 128, 2), false);
    assert.equal(
      shouldRecoverProcessingJob(
        "partial",
        1,
        false,
        "hybrid",
        CURRENT_AI_PIPELINE_VERSION - 1,
        false,
        CURRENT_TRANSCRIPTION_PIPELINE_VERSION,
        true,
      ),
      false,
    );
    assert.equal(
      shouldRecoverProcessingJob(
        "partial",
        1,
        false,
        "hybrid",
        CURRENT_AI_PIPELINE_VERSION,
        false,
        CURRENT_TRANSCRIPTION_PIPELINE_VERSION,
        true,
      ),
      false,
    );
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

  it("detects an upgrade candidate without replaying it automatically", () => {
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
      false,
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
