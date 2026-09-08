import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CURRENT_AI_PIPELINE_VERSION,
  CURRENT_TRANSCRIPTION_PIPELINE_VERSION,
  MAX_PROCESSING_ATTEMPTS,
  classifyProcessingFailure,
  nextProcessingAttemptAt,
  shouldRecoverProcessingJob,
  shouldRepairWithStructuredFallback,
  shouldReviewGeneratedNote,
  shouldPublishRecordingToRag,
  shouldOpenAiDraftPreview,
  shouldRefreshTranscript,
  shouldUpgradeExtractiveFallback,
} from "./processing-review-policy.ts";
import { stripTranscriptSection } from "./canonical-transcript.ts";
import { stripMetaCommentary } from "./note-commentary.ts";

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

describe("model commentary about the recording", () => {
  it("drops a closing parenthetical remark about transcript quality", () => {
    const draft = "# Rapat\n\n## Ringkasan\n\nIsi.\n\n(Catatan: transkrip mengandung bagian yang tidak jelas.)";

    assert.equal(stripMetaCommentary(draft), "# Rapat\n\n## Ringkasan\n\nIsi.");
  });

  it("drops a mid-document aside about audio quality", () => {
    const draft = "# Rapat\n\nCatatan: kualitas audio rekaman ini kurang baik.\n\n## Keputusan\n\nDeploy hari Jumat.";

    assert.equal(stripMetaCommentary(draft), "# Rapat\n\n## Keputusan\n\nDeploy hari Jumat.");
  });

  it("keeps a note that merely mentions a recording without judging it", () => {
    const draft = "# Rapat\n\nNote: the transcript will be shared with the team.\n\n## Decisions\n\nShip on Friday.";

    assert.equal(stripMetaCommentary(draft), draft);
  });

  it("keeps discussion whose subject really is audio quality", () => {
    const draft = "# Rapat\n\n## Pembahasan\n\nTim membahas kualitas audio pada produk baru.";

    assert.equal(stripMetaCommentary(draft), draft);
  });

  it("drops a hedge about the transcript that has no explicit lead-in", () => {
    const draft =
      "# Rapat\n\n## Ringkasan\n\nIsi.\n\nBeberapa bagian rekaman kurang jelas sehingga sebagian rangkuman bersifat perkiraan.";

    assert.equal(stripMetaCommentary(draft), "# Rapat\n\n## Ringkasan\n\nIsi.");
  });

  it("keeps a sentence that scopes work without judging the recording", () => {
    const draft = "# Rapat\n\nBeberapa bagian fitur akan dikerjakan minggu depan.\n\n## Keputusan\n\nRilis Jumat.";

    assert.equal(stripMetaCommentary(draft), draft);
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
  it("refreshes a stored transcript written before the normalization pipeline", () => {
    assert.equal(shouldRefreshTranscript(undefined, "transkrip lama"), true);
    assert.equal(
      shouldRefreshTranscript(CURRENT_TRANSCRIPTION_PIPELINE_VERSION - 1, "transkrip lama"),
      true,
    );
    assert.equal(
      shouldRefreshTranscript(CURRENT_TRANSCRIPTION_PIPELINE_VERSION, "transkrip baru"),
      false,
    );
  });

  it("never re-uploads audio for a recording that has no stored transcript yet", () => {
    assert.equal(shouldRefreshTranscript(undefined, undefined), false);
    assert.equal(shouldRefreshTranscript(undefined, "   "), false);
  });

  it("keeps terminal partial jobs idle until an explicit user retry", () => {
    assert.equal(shouldRecoverProcessingJob({ status: "partial" }), false);
    assert.equal(shouldRecoverProcessingJob({ status: "partial", repairingFallback: true }), false);
    assert.equal(shouldRecoverProcessingJob({ status: "partial", upgradingAi: true }), false);
    assert.equal(shouldRepairWithStructuredFallback("partial", 128, undefined), true);
    assert.equal(shouldRepairWithStructuredFallback("partial", 128, 1), false);
    assert.equal(shouldRepairWithStructuredFallback("partial", 128, 2), false);
  });

  it("recovers interrupted jobs but never reopens completed ones", () => {
    assert.equal(shouldRecoverProcessingJob({ status: "transcribing" }), true);
    assert.equal(shouldRecoverProcessingJob({ status: "extracting" }), true);
    assert.equal(shouldRecoverProcessingJob({ status: "synthesizing" }), true);
    assert.equal(shouldRecoverProcessingJob({ status: "saving" }), true);
    assert.equal(shouldRecoverProcessingJob({ status: "complete" }), false);
    assert.equal(shouldRecoverProcessingJob({ status: "unknown-status" }), false);
    assert.equal(shouldRecoverProcessingJob({ status: "saving", repairingFallback: true }), true);
    assert.equal(shouldRepairWithStructuredFallback("saving", 128, undefined, true), true);
  });

  it("retries a transient failure only once its backoff has elapsed", () => {
    const now = new Date("2026-08-31T10:00:00Z");
    const due = {
      status: "failed",
      failureKind: "retryable" as const,
      attempt: 1,
      nextAttemptAt: "2026-08-31T09:59:00Z",
    };

    assert.equal(shouldRecoverProcessingJob(due, now), true);
    assert.equal(
      shouldRecoverProcessingJob({ ...due, nextAttemptAt: "2026-08-31T10:05:00Z" }, now),
      false,
    );
  });

  it("never reopens a terminal failure", () => {
    assert.equal(shouldRecoverProcessingJob({ status: "failed" }), false);
    assert.equal(
      shouldRecoverProcessingJob({ status: "failed", failureKind: "terminal", attempt: 1 }),
      false,
    );
  });

  it("stops replaying a job that dies at the same point on every launch", () => {
    assert.equal(
      shouldRecoverProcessingJob({
        status: "transcribing",
        attempt: MAX_PROCESSING_ATTEMPTS - 1,
      }),
      true,
    );
    assert.equal(
      shouldRecoverProcessingJob({ status: "transcribing", attempt: MAX_PROCESSING_ATTEMPTS }),
      false,
    );
  });

  it("separates network failures from credential failures", () => {
    assert.equal(
      classifyProcessingFailure("Transcription request failed: error sending request", 1),
      "retryable",
    );
    assert.equal(
      classifyProcessingFailure("Transcription failed (503 Service Unavailable): busy", 1),
      "retryable",
    );
    assert.equal(
      classifyProcessingFailure("DEEPINFRA_API_KEY not configured in .env", 1),
      "terminal",
    );
    assert.equal(
      classifyProcessingFailure("Transcription failed (401 Unauthorized): invalid token", 1),
      "terminal",
    );
    assert.equal(classifyProcessingFailure("User not authenticated", 1), "terminal");
  });

  it("gives up on a transient failure once the attempt budget is spent", () => {
    const transient = "Transcription request failed: error sending request";

    assert.equal(classifyProcessingFailure(transient, MAX_PROCESSING_ATTEMPTS - 1), "retryable");
    assert.equal(classifyProcessingFailure(transient, MAX_PROCESSING_ATTEMPTS), "terminal");
  });

  it("waits longer before each further attempt", () => {
    const now = new Date("2026-08-31T10:00:00Z");

    assert.equal(nextProcessingAttemptAt(1, now), "2026-08-31T10:01:00.000Z");
    assert.equal(nextProcessingAttemptAt(2, now), "2026-08-31T10:02:00.000Z");
    assert.equal(nextProcessingAttemptAt(3, now), "2026-08-31T10:04:00.000Z");
    assert.equal(nextProcessingAttemptAt(9, now), "2026-08-31T10:16:00.000Z");
  });

  it("detects an upgrade candidate without replaying it automatically", () => {
    assert.equal(
      shouldUpgradeExtractiveFallback("partial", "extractive-fallback", undefined),
      true,
    );
    assert.equal(
      shouldUpgradeExtractiveFallback(
        "partial",
        "extractive-fallback",
        CURRENT_AI_PIPELINE_VERSION,
      ),
      false,
    );
    assert.equal(shouldRecoverProcessingJob({ status: "partial" }), false);
    assert.equal(shouldRecoverProcessingJob({ status: "saving", upgradingAi: true }), true);
  });
});
