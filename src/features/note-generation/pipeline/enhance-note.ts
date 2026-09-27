import { detailedChat, getModelLimits } from "@/features/note-generation/api/ai";
import type { TranscriptWithAssets } from "@/features/note-generation/lib/asset-markers";
import { mapWithConcurrency } from "@/features/note-generation/lib/concurrency";
import {
  DETERMINISTIC_FALLBACK_BUDGET,
  SECTION_MAX_CONCURRENT,
  longFormBudgetFor,
  type LongFormBudget,
} from "@/features/note-generation/lib/long-form-budget";
import {
  composeLongFormNote,
  estimateTokenUpperBound,
  isUsableSectionBackedDraft,
  sectionSourceFingerprint,
  splitTranscriptByTokenBudget,
  type ProcessedSection,
} from "@/features/note-generation/lib/long-form-processing";
import { buildLosslessStructuredFallback } from "@/features/note-generation/lib/lossless-note-fallback";
import type { RerunPlan } from "@/features/note-generation/lib/manifest-state";
import { assessGeneratedNote } from "@/features/note-generation/lib/note-quality";
import { CURRENT_AI_PIPELINE_VERSION } from "@/features/note-generation/lib/processing-review-policy";
import {
  noteSectionLabels,
  screenshotPromptRules,
  singlePassSystemPrompt,
} from "@/features/note-generation/lib/prompts";
import { collapseRepeatedLines } from "@/features/note-generation/lib/repeated-lines";
import { synthesizeGlobalNote } from "@/features/note-generation/pipeline/global-synthesis";
import { markStage, type ProcessingRun } from "@/features/note-generation/pipeline/processing-run";
import { processSectionReliably } from "@/features/note-generation/pipeline/section-notes";
import type { ManifestSection } from "@/features/note-generation/types";

export interface EnhancedDraft {
  text: string;
  /** What a review pass should fact-check against. */
  reviewSource: string;
  usedMapReduce: boolean;
  processingDegraded: boolean;
  usedStructuredFallback: boolean;
  processingError?: string;
}

// Every request is planned against a conservative token budget. Long-form
// detail is assembled from bounded section outputs; only compact global front
// matter goes through a hierarchical reduce.
export async function enhanceTranscript(
  run: ProcessingRun,
  source: TranscriptWithAssets,
  rerun: RerunPlan,
): Promise<EnhancedDraft> {
  const { markedTranscript, assetContext, assets } = source;
  const userContent = assets.length > 0
    ? `Screenshot contexts (what was on screen at each marker):\n${assetContext}\n\nTranscript:\n${markedTranscript}`
    : markedTranscript;
  const budget = rerun.repairWithStructuredFallback
    ? DETERMINISTIC_FALLBACK_BUDGET
    : longFormBudgetFor(await getModelLimits());
  const tEnhance = performance.now();
  try {
    if (rerun.repairWithStructuredFallback) {
      return {
        text: buildLosslessStructuredFallback(run.noteTitle, markedTranscript, run.lang),
        reviewSource: markedTranscript,
        usedMapReduce: false,
        processingDegraded: true,
        usedStructuredFallback: true,
        processingError: rerun.repairReason ?? "Previous AI enhancement did not complete",
      };
    }
    if (estimateTokenUpperBound(userContent) > budget.maxSourceTokens) {
      return await enhanceInSections(run, source, budget);
    }
    return await enhanceInSinglePass(run, source, userContent, budget);
  } catch (enhancementError) {
    console.warn(JSON.stringify({
      event: "recording_enhancement_fallback",
      jobId: run.manifest.jobId,
      stage: "enhance",
      reason: "provider_error",
    }));
    return {
      text: buildLosslessStructuredFallback(run.noteTitle, markedTranscript, run.lang),
      reviewSource: markedTranscript,
      usedMapReduce: estimateTokenUpperBound(userContent) > budget.maxSourceTokens,
      processingDegraded: true,
      usedStructuredFallback: true,
      processingError: `Note enhancement failed: ${String(enhancementError)}`,
    };
  } finally {
    markStage(run, "enhance", tEnhance);
  }
}

async function enhanceInSections(
  run: ProcessingRun,
  source: TranscriptWithAssets,
  budget: LongFormBudget,
): Promise<EnhancedDraft> {
  const { manifest } = run;
  const sections = splitTranscriptByTokenBudget(source.markedTranscript, budget.maxSourceTokens);
  console.log(`[audio-processor] map-reduce enhance: ${sections.length} sections`);
  manifest.status = "extracting";
  await run.persist();
  let persistQueue = Promise.resolve();
  const processedSections = await mapWithConcurrency(sections, SECTION_MAX_CONCURRENT, async (section, i) => {
    const sourceHash = sectionSourceFingerprint(
      `${CURRENT_AI_PIPELINE_VERSION}:${budget.model}`,
      run.lang,
      section.text,
    );
    const cached = manifest.sections.find(
      (item) => item.id === section.id && item.sourceHash === sourceHash && item.status === "complete",
    );
    if (cached) {
      return {
        id: cached.id,
        index: cached.index,
        markdown: cached.markdown,
        markers: cached.markers,
        isDegraded: cached.isDegraded,
      } satisfies ProcessedSection;
    }

    const processed = await processSectionReliably(section.text, i, sections.length, run.langName, section.markers.length > 0, budget);
    const result = {
      id: section.id,
      index: section.index,
      markdown: collapseRepeatedLines(processed.markdown),
      markers: section.markers,
      isDegraded: processed.isDegraded,
    } satisfies ProcessedSection;
    const artifact: ManifestSection = {
      ...result,
      sourceHash,
      status: processed.isDegraded ? "failed" : "complete",
    };
    manifest.sections = manifest.sections.filter((item) => item.id !== artifact.id);
    manifest.sections.push(artifact);
    // Save the latest shared manifest at queue execution time. Persisting
    // snapshots created by concurrent workers would make generation CAS
    // reject valid section progress as stale.
    persistQueue = persistQueue.then(() => run.persist());
    await persistQueue;
    return result;
  });
  const sectionNotes = processedSections.map((section) => section.markdown);
  const reviewSource = sectionNotes
    .map((note, i) => `--- PART ${i + 1} ---\n${note}`)
    .join("\n\n");
  let globalNote: string;
  let processingDegraded = false;
  let processingError: string | undefined;
  manifest.status = "synthesizing";
  await run.persist();
  try {
    const synthesisInputs = source.assetContext
      ? [...sectionNotes, `SCREENSHOT CONTEXT (supporting evidence only)\n${source.assetContext}`]
      : sectionNotes;
    globalNote = await synthesizeGlobalNote(
      synthesisInputs,
      run.langName,
      run.lang,
      run.context,
      budget,
    );
  } catch (globalError) {
    const sectionBackedDraft = isUsableSectionBackedDraft(processedSections);
    processingDegraded = !sectionBackedDraft;
    processingError = sectionBackedDraft
      ? undefined
      : `Global synthesis failed: ${String(globalError)}`;
    // Empty, not a placeholder: a placeholder H1 would become the note title.
    globalNote = "";
    console.warn(JSON.stringify({
      event: "recording_global_synthesis_fallback",
      jobId: manifest.jobId,
      sectionBackedDraft,
      reason: String(globalError),
    }));
  }
  return {
    text: composeLongFormNote(globalNote, processedSections, run.lang),
    reviewSource,
    usedMapReduce: true,
    processingDegraded,
    usedStructuredFallback: false,
    processingError,
  };
}

async function enhanceInSinglePass(
  run: ProcessingRun,
  source: TranscriptWithAssets,
  userContent: string,
  budget: LongFormBudget,
): Promise<EnhancedDraft> {
  const { markedTranscript, assets } = source;
  const labels = noteSectionLabels(run.lang);
  const screenshotRules = screenshotPromptRules(assets.length > 0);
  const single = await detailedChat(
    [
      {
        role: "system",
        content: singlePassSystemPrompt(run.context, run.langName, labels, screenshotRules),
      },
      { role: "user", content: userContent },
    ],
    0.2,
    budget.sectionOutputTokens,
  );
  const singleIssues = assessGeneratedNote(markedTranscript, single.content, {
    isTruncated: single.is_truncated,
    requireUsefulTitle: true,
  });
  if (singleIssues.length === 0) {
    return {
      text: single.content,
      reviewSource: markedTranscript,
      usedMapReduce: false,
      processingDegraded: false,
      usedStructuredFallback: false,
    };
  }
  const recovered = await processSectionReliably(
    markedTranscript,
    0,
    1,
    run.langName,
    assets.length > 0,
    budget,
  );
  return {
    text: composeLongFormNote(
      "",
      [{
        id: "section-0001",
        index: 0,
        markdown: recovered.markdown,
        markers: markedTranscript.match(/\[\[ATOK_ASSET_\d+\]\]/g) ?? [],
        isDegraded: recovered.isDegraded,
      }],
      run.lang,
    ),
    reviewSource: markedTranscript,
    usedMapReduce: true,
    processingDegraded: recovered.isDegraded,
    usedStructuredFallback: false,
    processingError: recovered.isDegraded
      ? "Single-pass output did not pass deterministic quality checks"
      : undefined,
  };
}
