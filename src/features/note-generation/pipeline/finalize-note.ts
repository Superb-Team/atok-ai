import { applyAssetMarkers, type TranscriptWithAssets } from "@/features/note-generation/lib/asset-markers";
import { normalizeNoteMarkdown } from "@/features/note-generation/lib/note-markdown";
import { stripTranscriptSection } from "@/features/note-generation/lib/canonical-transcript";
import { stripPlaceholderSections } from "@/features/note-generation/lib/long-form-processing";
import {
  buildLosslessStructuredFallback,
  isExtractiveFallbackNote,
} from "@/features/note-generation/lib/lossless-note-fallback";
import { stripMetaCommentary } from "@/features/note-generation/lib/note-commentary";
import {
  assessGeneratedNote,
  hasBlockingDefect,
  shouldUseLosslessFallback,
} from "@/features/note-generation/lib/note-quality";
import { shouldReviewGeneratedNote } from "@/features/note-generation/lib/processing-review-policy";
import { collapseRepeatedLines } from "@/features/note-generation/lib/repeated-lines";
import {
  deriveRecordingNoteTitle,
  replaceDocumentTitle,
} from "@/features/recording/lib/recording-note-metadata";
import type { EnhancedDraft } from "@/features/note-generation/pipeline/enhance-note";
import { markStage, type ProcessingRun } from "@/features/note-generation/pipeline/processing-run";
import { recoverRecordingTitle } from "@/features/note-generation/pipeline/recover-title";
import { reviewNote } from "@/features/note-generation/pipeline/review-note";
import { logger } from "@/lib/logger";

export interface FinalizedNote {
  title: string;
  content: string;
  qualityIssues: ReturnType<typeof assessGeneratedNote>;
  processingDegraded: boolean;
  usedStructuredFallback: boolean;
  processingError?: string;
}

export async function finalizeNote(
  run: ProcessingRun,
  transcript: string,
  source: TranscriptWithAssets,
  draft: EnhancedDraft,
): Promise<FinalizedNote> {
  const { markedTranscript, assets } = source;
  let { processingDegraded, usedStructuredFallback, processingError } = draft;
  const collapsed = draft.usedMapReduce ? draft.text : collapseRepeatedLines(draft.text);
  const loopSuspected = !draft.usedMapReduce && collapsed !== draft.text;
  let content = collapsed;

  // A second provider pass is reserved for an actual repetition loop.
  // Length alone is not a reason to double the request count; deterministic
  // source and structure checks still run for every draft below.
  const tReview = performance.now();
  if (shouldReviewGeneratedNote({
    processingDegraded,
    loopSuspected,
    usedMapReduce: draft.usedMapReduce,
    transcriptLength: markedTranscript.length,
  })) {
    content = await reviewNote(draft.reviewSource, content, run.langName);
    content = collapseRepeatedLines(content);
    markStage(run, "review", tReview);
  }
  content = stripPlaceholderSections(stripMetaCommentary(content));

  // A provider can return a previous degraded artifact as ordinary text
  // without throwing. Treat that as degraded too; otherwise preview mode
  // could present the old extractive note as a successful AI draft.
  if (isExtractiveFallbackNote(content)) {
    processingDegraded = true;
    usedStructuredFallback = true;
    processingError = "AI returned an extractive fallback artifact";
    content = buildLosslessStructuredFallback(run.noteTitle, markedTranscript, run.lang);
  }

  if (!usedStructuredFallback) {
    content = await recoverRecordingTitle(content, markedTranscript, run.langName);
  }

  const qualityIssues = assessGeneratedNote(markedTranscript, content, {
    isTruncated: false,
    requireUsefulTitle: true,
  });
  if (hasBlockingDefect(qualityIssues)) {
    processingDegraded = true;
    processingError = `Generated note rejected by quality checks: ${qualityIssues.map((issue) => issue.code).join(", ")}`;
    if (!run.previewOnly && shouldUseLosslessFallback(qualityIssues)) {
      usedStructuredFallback = true;
      content = buildLosslessStructuredFallback(run.noteTitle, markedTranscript, run.lang);
    }
  } else if (qualityIssues.length > 0) {
    logger.warn("note_generation.advisory_findings", {
      jobId: run.manifest.jobId,
      findings: qualityIssues.map((issue) => issue.code).join(","),
    });
  }

  // Keep semantic markers in the quality-gate input. Convert them to local
  // image embeds only after validation, otherwise the gate sees every embed
  // as a missing marker and forces a needless extractive fallback.
  if (assets.length > 0) {
    content = applyAssetMarkers(content, assets);
  }

  const title = deriveRecordingNoteTitle(
    // A deterministic/extractive fallback is not a title source. Its first
    // sentence is often a greeting or a fragment, which previously became
    // titles such as “Oh, gue putus-putus, Kak.”.
    usedStructuredFallback ? "" : content,
    transcript,
    run.noteTitle,
    run.context,
    run.lang,
  );
  content = stripTranscriptSection(content);
  content = normalizeNoteMarkdown(replaceDocumentTitle(content, title), { numberHeadings: true });

  return { title, content, qualityIssues, processingDegraded, usedStructuredFallback, processingError };
}
