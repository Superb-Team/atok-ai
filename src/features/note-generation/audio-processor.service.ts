import { NoteConflictError, noteService } from "@/features/notes/api/note.service";
import { authService } from "@/features/auth/api/auth.service";
import type { Note } from "@/features/notes/types";
import { noteAssetService, type RecordingAsset } from "@/features/notes/api/note-asset.service";
import { invoke } from "@tauri-apps/api/core";
import { detailedChat, getModelLimits } from "@/features/note-generation/api/ai-chat";
import {
  claimProcessingJob,
  loadProcessingManifest,
  releaseProcessingJob,
  saveProcessingManifest,
} from "@/features/note-generation/api/processing-manifest";
import { applyAssetMarkers, formatElapsed, insertAssetMarkers } from "@/features/note-generation/lib/asset-markers";
import { mapWithConcurrency } from "@/features/note-generation/lib/concurrency";
import {
  DETERMINISTIC_FALLBACK_BUDGET,
  SECTION_MAX_CONCURRENT,
  longFormBudgetFor,
} from "@/features/note-generation/lib/long-form-budget";
import {
  composeLongFormNote,
  estimateTokenUpperBound,
  isUsableSectionBackedDraft,
  splitTranscriptByTokenBudget,
  stripPlaceholderSections,
  sectionSourceFingerprint,
  type ProcessedSection,
} from "@/features/note-generation/lib/long-form-processing";
import { assessGeneratedNote, hasBlockingDefect, shouldUseLosslessFallback } from "@/features/note-generation/lib/note-quality";
import {
  LANGUAGE_NAMES,
  noteSectionLabels,
  screenshotPromptRules,
  singlePassSystemPrompt,
} from "@/features/note-generation/lib/prompts";
import { collapseRepeatedLines } from "@/features/note-generation/lib/repeated-lines";
import { recordingProcessingGuard } from "@/features/recording/lib/recording-processing-guard";
import {
  buildLosslessStructuredFallback,
  isExtractiveFallbackNote,
} from "@/features/note-generation/lib/lossless-note-fallback";
import { stripTranscriptSection } from "@/features/note-generation/lib/canonical-transcript";
import { stripMetaCommentary } from "@/features/note-generation/lib/note-commentary";
import {
  CURRENT_AI_PIPELINE_VERSION,
  CURRENT_TRANSCRIPTION_PIPELINE_VERSION,
  classifyProcessingFailure,
  nextProcessingAttemptAt,
  shouldRepairWithStructuredFallback,
  shouldPublishRecordingToRag,
  shouldOpenAiDraftPreview,
  shouldReviewGeneratedNote,
  shouldRefreshTranscript,
  shouldUpgradeExtractiveFallback,
} from "@/features/note-generation/lib/processing-review-policy";
import {
  deriveRecordingNoteTitle,
  inferRecordingNoteContext,
  replaceDocumentTitle,
  type RecordingNoteContext,
} from "@/features/recording/lib/recording-note-metadata";
import { processSectionReliably } from "@/features/note-generation/pipeline/section-notes";
import { synthesizeGlobalNote } from "@/features/note-generation/pipeline/global-synthesis";
import { reviewNote } from "@/features/note-generation/pipeline/review-note";
import type {
  ManifestSection,
  ProcessingManifest,
  TranscriptIntegrityReport,
} from "@/features/note-generation/types";

function recordProcessingFailure(manifest: ProcessingManifest, error: unknown): void {
  const attempt = manifest.attempt ?? 1;
  manifest.status = "failed";
  manifest.error = String(error);
  manifest.failureKind = classifyProcessingFailure(manifest.error, attempt);
  manifest.nextAttemptAt = manifest.failureKind === "retryable"
    ? nextProcessingAttemptAt(attempt)
    : undefined;
}


export interface AudioProcessingResult {
  noteTitle: string;
  enhancedText: string;
  success: boolean;
  canonicalTranscript?: string;
  transcriptRevisionId?: string;
  warnings?: string[];
  outcome?: "note_created" | "draft_preview" | "no_speech" | "already_processing";
  message?: string;
  error?: string;
}

export interface AudioProcessingOptions {
  /** Re-run AI enhancement even when the manifest already reached the current version. */
  forceAiUpgrade?: boolean;
  /** Generate and validate content without saving the note or mutating the manifest. */
  previewOnly?: boolean;
  /** Operator recovery: restart the automatic retry budget for this recording. */
  retryFromUser?: boolean;
}

export function processAudioRecording(
  audioPath: string,
  noteTitle: string,
  language?: string,
  context?: RecordingNoteContext,
  options: AudioProcessingOptions = {},
): Promise<AudioProcessingResult> {
  return recordingProcessingGuard.run(audioPath, async () => {
    const runId = globalThis.crypto.randomUUID();
    const claimed = await claimProcessingJob(audioPath, runId);
    if (!claimed) {
      return { noteTitle, enhancedText: "", success: true, outcome: "already_processing" };
    }
    try {
      return await processAudioRecordingOnce(audioPath, noteTitle, language, context, options);
    } finally {
      await releaseProcessingJob(audioPath, runId);
    }
  }, { joinExisting: options.previewOnly !== true });
}

async function processAudioRecordingOnce(
  audioPath: string,
  noteTitle: string,
  language?: string,
  context?: RecordingNoteContext,
  options: AudioProcessingOptions = {},
): Promise<AudioProcessingResult> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const mark = (stage: string, since: number) => {
    timings[stage] = Math.round(performance.now() - since);
  };
  let manifest: ProcessingManifest | null = null;
  let repairWithStructuredFallback = false;
  let upgradeExtractiveFallback = false;
  let repairReason: string | undefined;
  const previewOnly = options.previewOnly === true;
  const forceAiUpgrade = options.forceAiUpgrade === true;
  const persistManifest = async () => {
    if (manifest && !previewOnly) await saveProcessingManifest(manifest);
  };
  const persistManifestBestEffort = async () => {
    if (manifest && !previewOnly) await saveProcessingManifest(manifest).catch(() => {});
  };
  try {
    // `??` not `||`: an explicit "" means AUTO-detect and must survive; only a
    // missing language (legacy handoff) falls back to Indonesian.
    const lang = language ?? "id";
    const langName = LANGUAGE_NAMES[lang] || "the same language as the transcript";
    manifest = await loadProcessingManifest(audioPath);
    const resolvedContext = context
      ?? (manifest?.recordedAt && manifest.timezone
        ? { recordedAt: manifest.recordedAt, timezone: manifest.timezone }
        : undefined)
      ?? inferRecordingNoteContext(audioPath)
      ?? {
        recordedAt: manifest?.createdAt ?? new Date().toISOString(),
        timezone: "UTC",
      };
    if (!manifest) {
      const now = new Date().toISOString();
      manifest = {
        schemaVersion: 1,
        generation: 0,
        jobId: `job-${globalThis.crypto.randomUUID()}`,
        audioPath,
        noteTitle,
        language: lang,
        recordedAt: resolvedContext.recordedAt,
        timezone: resolvedContext.timezone,
        status: "transcribing",
        sections: [],
        createdAt: now,
        updatedAt: now,
      };
      await persistManifest();
    } else {
      manifest.noteTitle = noteTitle;
      manifest.language = lang;
      manifest.recordedAt = resolvedContext.recordedAt;
      manifest.timezone = resolvedContext.timezone;
      if (forceAiUpgrade) {
        repairWithStructuredFallback = false;
        upgradeExtractiveFallback = true;
        manifest.repairingFallback = undefined;
        manifest.upgradingAi = true;
        manifest.error = undefined;
        // A forced upgrade must not reuse extractive or older model output.
        manifest.sections = [];
        await persistManifest();
      } else {
        repairWithStructuredFallback = shouldRepairWithStructuredFallback(
          manifest.status,
          manifest.savedNoteId,
          manifest.fallbackVersion,
          manifest.repairingFallback,
        );
        if (repairWithStructuredFallback) {
          repairReason = manifest.error;
          manifest.repairingFallback = true;
          await persistManifest();
        } else {
          upgradeExtractiveFallback = shouldUpgradeExtractiveFallback(
            manifest.status,
            manifest.enhancementMode,
            manifest.aiPipelineVersion,
          );
          if (upgradeExtractiveFallback) {
            manifest.upgradingAi = true;
            // Cached section output belongs to an older prompt/model policy.
            manifest.sections = [];
            await persistManifest();
          }
        }
      }
    }

    // Counted before the work: a run killed mid-transcript must still spend its budget.
    manifest.attempt = options.retryFromUser === true ? 1 : (manifest.attempt ?? 0) + 1;
    manifest.failureKind = undefined;
    manifest.nextAttemptAt = undefined;
    await persistManifest();

    const refreshTranscript = shouldRefreshTranscript(
      manifest.transcriptionPipelineVersion,
      manifest.transcript,
    );
    if (refreshTranscript) {
      // Transcript changes invalidate every derived section. The sidecar is the
      // durable source; cached note sections must never mix with a new run.
      manifest.transcript = undefined;
      manifest.transcriptRevisionId = undefined;
      manifest.transcriptReviewIssues = undefined;
      manifest.enhancementStageKey = undefined;
      manifest.sections = [];
      await persistManifest();
    }

    // Screenshots + vision descriptions only need audioPath, so run them
    // concurrently with Whisper instead of after it. Best-effort: any failure
    // resolves to null and the note simply has no assets.
    const assetsPromise = (async () => {
      const started = performance.now();
      const taken = await noteAssetService.takeRecordingAssets(audioPath);
      const descriptions = await mapWithConcurrency(taken.assets, 2, async (a) => {
        try {
          return repairWithStructuredFallback
            ? ""
            : await invoke<string>("describe_image", { imagePath: a.path, language: langName });
        } catch {
          return "";
        }
      });
      return { taken, descriptions, elapsed: Math.round(performance.now() - started) };
    })().catch((assetErr) => {
      console.error("Failed to load recording assets:", assetErr);
      return null;
    });

    // Step 1: Transcribe via Whisper (language pinned so quiet chunks don't drift)
    const tTranscribe = performance.now();
    let transcript: string;
    let transcriptRequiresReview = false;
    let transcriptReviewIssues: string[] = [];
    try {
      transcript = !refreshTranscript && manifest.transcript?.trim()
        ? manifest.transcript
        : await invoke<string>("transcribe_audio", {
          audioPath,
          language: lang,
          forceRefresh: refreshTranscript,
        });
      if (!transcript.trim()) {
        // Silence/background noise is a successful transcription outcome, not
        // an infrastructure failure. Keep the recording, finish the manifest,
        // and skip note generation so no empty or scary "failure note" appears.
        await assetsPromise;
        manifest.transcript = "";
        manifest.transcriptionPipelineVersion = CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
        manifest.status = "complete";
        manifest.error = undefined;
        manifest.timingsMs = {
          ...timings,
          transcribe: Math.round(performance.now() - tTranscribe),
          total: Math.round(performance.now() - t0),
        };
        await persistManifest();
        return {
          noteTitle,
          enhancedText: "",
          success: true,
          outcome: "no_speech",
          message: lang === "id"
            ? "Rekaman tersimpan, tetapi tidak ada percakapan yang terdeteksi. Periksa microphone yang dipilih lalu coba lagi."
            : "The recording was saved, but no speech was detected. Check the selected microphone and try again.",
        };
      }
      manifest.transcript = transcript;
      manifest.transcriptionPipelineVersion = CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
      const integrity = await invoke<TranscriptIntegrityReport>("evaluate_transcript_integrity", {
        audioPath,
        transcript,
      }).catch((error) => ({
        revisionId: "unavailable",
        requiresReview: true,
        issues: [{
          code: "integrity_evaluation_failed",
          detail: `Transcript integrity evaluation failed: ${String(error)}`,
          advisory: false,
        }],
      }));
      transcriptRequiresReview = integrity.requiresReview;
      transcriptReviewIssues = integrity.issues
        .filter((issue) => issue.advisory !== true)
        .map((issue) => `${issue.code}: ${issue.detail}`);
      manifest.transcriptRevisionId = integrity.revisionId;
      manifest.transcriptReviewIssues = transcriptReviewIssues;
      const enhancementStageKey = `note:${CURRENT_AI_PIPELINE_VERSION}:${lang}:${integrity.revisionId}`;
      if (manifest.enhancementStageKey && manifest.enhancementStageKey !== enhancementStageKey) {
        manifest.sections = [];
      }
      manifest.enhancementStageKey = enhancementStageKey;
      manifest.status = repairWithStructuredFallback ? "partial" : "extracting";
      if (!repairWithStructuredFallback) manifest.error = undefined;
      await persistManifest();
    } catch (transcribeError) {
      recordProcessingFailure(manifest, transcribeError);
      await persistManifestBestEffort();
      const user = authService.getUser();
      console.error(JSON.stringify({
        event: "recording_transcription_failed",
        jobId: manifest.jobId,
        reason: "provider_or_capture_error",
        error: String(transcribeError),
      }));
      if (!previewOnly && !manifest.failureNoteId) {
        const failureContent = lang === "id"
          ? `# ${noteTitle}\n\n## Pemrosesan rekaman tertunda\n\nRekaman sudah tersimpan, tetapi transkripsinya belum selesai. Audio dan status pemrosesan tetap dipertahankan agar dapat dicoba lagi.`
          : `# ${noteTitle}\n\n## Recording processing pending\n\nThe recording was saved, but transcription did not finish. The audio and processing state were retained so it can be retried.`;
        const failureNote = await saveNote(
          noteTitle,
          failureContent,
          ["voice-recording", "transcription", "needs-review"],
          user?.id,
        );
        manifest.failureNoteId = failureNote.id;
        await persistManifestBestEffort();
      }
      return {
        noteTitle,
        enhancedText: "",
        success: false,
        error: previewOnly
          ? "The recording transcript could not be verified; the original note was kept."
          : String(transcribeError),
      };
    }
    mark("transcribe", tTranscribe);

    // Step 1.5: anchor the screenshots into the transcript as short markers so
    // the note can reference what was on screen.
    let assets: RecordingAsset[] = [];
    let markedTranscript = transcript;
    let assetContext = "";
    const assetResult = await assetsPromise;
    if (assetResult) {
      timings["assets+vision"] = assetResult.elapsed;
      assets = assetResult.taken.assets;
      if (assets.length > 0) {
        markedTranscript = insertAssetMarkers(transcript, assets, assetResult.taken.duration_ms);
        assetContext = assets
          .map((a, i) =>
            `[[ATOK_ASSET_${i + 1}]] (screen at ${formatElapsed(a.elapsed_ms)})${assetResult.descriptions[i] ? `: ${assetResult.descriptions[i]}` : ""}`,
          )
          .join("\n");
      }
    }

    const screenshotRules = screenshotPromptRules(assets.length > 0);

    const userContent = assets.length > 0
      ? `Screenshot contexts (what was on screen at each marker):\n${assetContext}\n\nTranscript:\n${markedTranscript}`
      : transcript;

    // Step 2: every request is planned against a conservative token budget.
    // Long-form detail is assembled from bounded section outputs; only compact
    // global front matter goes through a hierarchical reduce.
    const budget = repairWithStructuredFallback
      ? DETERMINISTIC_FALLBACK_BUDGET
      : longFormBudgetFor(await getModelLimits());
    let usedMapReduce = !repairWithStructuredFallback &&
      estimateTokenUpperBound(userContent) > budget.maxSourceTokens;
    let processingDegraded = false;
    let usedStructuredFallback = false;
    let processingError: string | undefined;
    const tEnhance = performance.now();
    let enhancedText: string;
    let reviewSource = markedTranscript;
    const labels = noteSectionLabels(lang);
    try {
      if (repairWithStructuredFallback) {
        processingDegraded = true;
        usedStructuredFallback = true;
        processingError = repairReason ?? "Previous AI enhancement did not complete";
        enhancedText = buildLosslessStructuredFallback(noteTitle, markedTranscript, lang);
      } else if (usedMapReduce) {
        const sections = splitTranscriptByTokenBudget(markedTranscript, budget.maxSourceTokens);
        console.log(`[audio-processor] map-reduce enhance: ${sections.length} sections`);
        manifest.status = "extracting";
        await persistManifest();
        let persistQueue = Promise.resolve();
        const processedSections = await mapWithConcurrency(sections, SECTION_MAX_CONCURRENT, async (section, i) => {
          const sourceHash = sectionSourceFingerprint(
            `${CURRENT_AI_PIPELINE_VERSION}:${budget.model}`,
            lang,
            section.text,
          );
          const cached = manifest!.sections.find(
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

          const processed = await processSectionReliably(section.text, i, sections.length, langName, section.markers.length > 0, budget);
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
          manifest!.sections = manifest!.sections.filter((item) => item.id !== artifact.id);
          manifest!.sections.push(artifact);
          // Save the latest shared manifest at queue execution time. Persisting
          // snapshots created by concurrent workers would make generation CAS
          // reject valid section progress as stale.
          persistQueue = persistQueue.then(() => persistManifest());
          await persistQueue;
          return result;
        });
        const sectionNotes = processedSections.map((section) => section.markdown);
        reviewSource = sectionNotes
          .map((note, i) => `--- PART ${i + 1} ---\n${note}`)
          .join("\n\n");
        let globalNote: string;
        manifest.status = "synthesizing";
        await persistManifest();
        try {
          const synthesisInputs = assetContext
            ? [...sectionNotes, `SCREENSHOT CONTEXT (supporting evidence only)\n${assetContext}`]
            : sectionNotes;
          globalNote = await synthesizeGlobalNote(
            synthesisInputs,
            langName,
            lang,
            resolvedContext,
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
        enhancedText = composeLongFormNote(globalNote, processedSections, lang);
      } else {
        const single = await detailedChat(
          [
            {
              role: "system",
              content: singlePassSystemPrompt(resolvedContext, langName, labels, screenshotRules),
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
        if (singleIssues.length > 0) {
          const recovered = await processSectionReliably(
            markedTranscript,
            0,
            1,
            langName,
            assets.length > 0,
            budget,
          );
          enhancedText = composeLongFormNote(
            "",
            [{
              id: "section-0001",
              index: 0,
              markdown: recovered.markdown,
              markers: markedTranscript.match(/\[\[ATOK_ASSET_\d+\]\]/g) ?? [],
              isDegraded: recovered.isDegraded,
            }],
            lang,
          );
          processingDegraded = processingDegraded || recovered.isDegraded;
          if (recovered.isDegraded) {
            processingError = "Single-pass output did not pass deterministic quality checks";
          }
          usedMapReduce = true;
        } else {
          enhancedText = single.content;
        }
      }
    } catch (enhancementError) {
      processingDegraded = true;
      usedStructuredFallback = true;
      processingError = `Note enhancement failed: ${String(enhancementError)}`;
      enhancedText = buildLosslessStructuredFallback(noteTitle, markedTranscript, lang);
      console.warn(JSON.stringify({
        event: "recording_enhancement_fallback",
        jobId: manifest.jobId,
        stage: "enhance",
        reason: "provider_error",
      }));
    }
    mark("enhance", tEnhance);

    const collapsed = usedMapReduce ? enhancedText : collapseRepeatedLines(enhancedText);
    const loopSuspected = !usedMapReduce && collapsed !== enhancedText;
    enhancedText = collapsed;

    // A second provider pass is reserved for an actual repetition loop.
    // Length alone is not a reason to double the request count; deterministic
    // source and structure checks still run for every draft below.
    const tReview = performance.now();
    if (shouldReviewGeneratedNote({
      processingDegraded,
      loopSuspected,
      usedMapReduce,
      transcriptLength: markedTranscript.length,
    })) {
      enhancedText = await reviewNote(reviewSource, enhancedText, langName);
      enhancedText = collapseRepeatedLines(enhancedText);
      mark("review", tReview);
    }
    enhancedText = stripPlaceholderSections(stripMetaCommentary(enhancedText));

    // A provider can return a previous degraded artifact as ordinary text
    // without throwing. Treat that as degraded too; otherwise preview mode
    // could present the old extractive note as a successful AI draft.
    if (isExtractiveFallbackNote(enhancedText)) {
      processingDegraded = true;
      usedStructuredFallback = true;
      processingError = "AI returned an extractive fallback artifact";
      enhancedText = buildLosslessStructuredFallback(noteTitle, markedTranscript, lang);
    }

    const finalQualityIssues = assessGeneratedNote(markedTranscript, enhancedText, {
      isTruncated: false,
      requireUsefulTitle: true,
    });
    if (hasBlockingDefect(finalQualityIssues)) {
      processingDegraded = true;
      processingError = `Generated note rejected by quality checks: ${finalQualityIssues.map((issue) => issue.code).join(", ")}`;
      if (!previewOnly && shouldUseLosslessFallback(finalQualityIssues)) {
        usedStructuredFallback = true;
        enhancedText = buildLosslessStructuredFallback(noteTitle, markedTranscript, lang);
      }
    } else if (finalQualityIssues.length > 0) {
      console.warn(JSON.stringify({
        event: "recording_note_advisory_findings",
        jobId: manifest.jobId,
        findings: finalQualityIssues.map((issue) => issue.code),
      }));
    }

    // Keep semantic markers in the quality-gate input. Convert them to local
    // image embeds only after validation, otherwise the gate sees every embed
    // as a missing marker and forces a needless extractive fallback.
    if (assets.length > 0) {
      enhancedText = applyAssetMarkers(enhancedText, assets);
    }

    // Derive the title from the structured draft only.
    const finalTitle = deriveRecordingNoteTitle(
      // A deterministic/extractive fallback is not a title source. Its first
      // sentence is often a greeting or a fragment, which previously became
      // titles such as “Oh, gue putus-putus, Kak.”.
      usedStructuredFallback ? "" : enhancedText,
      transcript,
      noteTitle,
      resolvedContext,
      lang,
    );
    enhancedText = stripTranscriptSection(enhancedText);
    enhancedText = replaceDocumentTitle(enhancedText, finalTitle);
    const hasFailedSection = manifest.sections.some((section) => section.status === "failed");
    const needsReview = processingDegraded || hasFailedSection || transcriptRequiresReview;

    if (previewOnly) {
      const previewWarnings = [
        ...finalQualityIssues.map((issue) => `${issue.code}: ${issue.detail}`),
        ...(hasFailedSection ? ["Satu atau lebih bagian memakai transcript sumber karena hasil AI bagian tersebut tidak lolos validasi."] : []),
        ...transcriptReviewIssues,
      ];
      if (!shouldOpenAiDraftPreview(enhancedText.trim().length > 0, usedStructuredFallback)) {
        const reason = usedStructuredFallback
          ? `AI provider gagal menghasilkan draft yang dapat direview${processingError ? `: ${processingError}` : "."}`
          : "AI menghasilkan draft kosong.";
        return {
          noteTitle: finalTitle,
          enhancedText: "",
          success: false,
          error: reason,
        };
      }
      return {
        noteTitle: finalTitle,
        enhancedText,
        success: true,
        canonicalTranscript: transcript,
        transcriptRevisionId: manifest.transcriptRevisionId,
        warnings: previewWarnings,
        outcome: "draft_preview",
        message: "AI draft passed transcript and quality checks; review it before saving.",
      };
    }

    // Step 3: Save note
    const tSave = performance.now();
    const user = authService.getUser();
    if (!user) throw new Error("User not authenticated");

    manifest.status = "saving";
    await persistManifest();
    let noteWasManuallyEdited = false;
    if (!manifest.savedNoteId) {
      const savedNote = await saveNote(
        finalTitle,
        enhancedText,
        ["voice-recording", "transcription", ...(needsReview ? ["needs-review"] : [])],
        user.id,
        manifest.jobId,
        resolvedContext,
      );
      manifest.savedNoteId = savedNote.id;
      manifest.savedNoteUpdatedAt = savedNote.updated_at;
      // Persist the note id before optional indexing so a crash cannot create a
      // duplicate note when this job resumes.
      await persistManifest();
    } else if (manifest.savedNoteUpdatedAt) {
      try {
        const savedNote = await noteService.updateNote(manifest.savedNoteId, user.id, {
          title: finalTitle,
          content: enhancedText,
          tags: ["voice-recording", "transcription", ...(needsReview ? ["needs-review"] : [])],
          expected_updated_at: manifest.savedNoteUpdatedAt,
        });
        manifest.savedNoteUpdatedAt = savedNote.updated_at;
      } catch (error) {
        if (!(error instanceof NoteConflictError)) throw error;
        noteWasManuallyEdited = true;
        console.warn(JSON.stringify({
          event: "recording_note_manual_edit_preserved",
          jobId: manifest.jobId,
          noteId: manifest.savedNoteId,
        }));
      }
    } else {
      // Older manifests do not contain the version that was originally saved.
      // Updating them blindly could erase a user's later manual edits.
      noteWasManuallyEdited = true;
      console.warn(JSON.stringify({
        event: "recording_note_legacy_version_unknown",
        jobId: manifest.jobId,
        noteId: manifest.savedNoteId,
      }));
    }

    // Step 4: Insert to RAG (optional, non-fatal)
    if (shouldPublishRecordingToRag({
      processingDegraded,
      hasFailedSection,
      transcriptRequiresReview,
      noteWasManuallyEdited,
    })) {
      try {
        await invoke<boolean>("agent_insert_document", {
          userId: user.id,
          text: enhancedText,
          metadata: {
            type: "voice_recording",
            date: resolvedContext.recordedAt.split("T")[0],
            recorded_at: resolvedContext.recordedAt,
            timezone: resolvedContext.timezone,
            source: "whisper_transcription",
            note_id: manifest.savedNoteId,
            note_updated_at: manifest.savedNoteUpdatedAt,
          },
        });
      } catch {
        // RAG insertion is optional — don't fail the workflow
      }
    }
    mark("save+rag", tSave);
    mark("total", t0);
    manifest.enhancementMode = usedStructuredFallback
      ? "extractive-fallback"
      : processingDegraded ? "hybrid" : "ai";
    if (usedStructuredFallback) manifest.fallbackVersion = 1;
    manifest.repairingFallback = undefined;
    manifest.aiPipelineVersion = CURRENT_AI_PIPELINE_VERSION;
    manifest.upgradingAi = undefined;
    manifest.timingsMs = timings;
    manifest.status = needsReview ? "partial" : "complete";
    manifest.error = manifest.status === "partial"
      ? processingError ?? "One or more transcript sections used a lossless fallback"
      : undefined;
    manifest.failureKind = undefined;
    manifest.nextAttemptAt = undefined;
    await persistManifest();
    console.log(JSON.stringify({
      event: "recording_processing_completed",
      jobId: manifest.jobId,
      status: manifest.status,
      enhancementMode: manifest.enhancementMode,
      timingsMs: timings,
    }));

    return { noteTitle: finalTitle, enhancedText, success: true, outcome: "note_created" };
  } catch (error) {
    if (manifest) {
      recordProcessingFailure(manifest, error);
      await persistManifestBestEffort();
    }
    return {
      noteTitle,
      enhancedText: "",
      success: false,
      error: previewOnly
        ? "AI draft generation failed; the original note was kept."
        : String(error),
    };
  }
}

export interface AudioDraftCommitInput {
  audioPath: string;
  noteId: number;
  noteTitle: string;
  content: string;
  expectedUpdatedAt: string;
  canonicalTranscript: string;
  transcriptRevisionId?: string;
  tags?: string[];
}

/**
 * Accept a previously previewed AI draft with note-level compare-and-swap.
 * The preview itself never writes state; this is the only explicit commit
 * path, and it also retires the extractive fallback manifest after success.
 */
export function commitAudioRecordingDraft(input: AudioDraftCommitInput): Promise<Note> {
  return recordingProcessingGuard.run(input.audioPath, async () => {
    const runId = globalThis.crypto.randomUUID();
    const claimed = await claimProcessingJob(input.audioPath, runId);
    if (!claimed) throw new Error("This recording is still being processed. Try again in a moment.");

    try {
      const manifest = await loadProcessingManifest(input.audioPath);
      if (!manifest || manifest.savedNoteId !== input.noteId) {
        throw new Error("The recording source for this note is no longer available.");
      }

      const user = authService.getUser();
      if (!user) throw new Error("User not authenticated");

      const updated = await noteService.updateNote(input.noteId, user.id, {
        title: input.noteTitle,
        content: input.content,
        tags: input.tags?.filter((tag) => tag !== "needs-review"),
        expected_updated_at: input.expectedUpdatedAt,
      });

      manifest.noteTitle = input.noteTitle;
      manifest.savedNoteUpdatedAt = updated.updated_at;
      manifest.transcript = input.canonicalTranscript;
      manifest.transcriptionPipelineVersion = CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
      manifest.transcriptRevisionId = input.transcriptRevisionId;
      manifest.enhancementStageKey = `note:${CURRENT_AI_PIPELINE_VERSION}:${manifest.language}:${input.transcriptRevisionId ?? "unknown"}`;
      manifest.sections = [];
      manifest.enhancementMode = "ai";
      manifest.fallbackVersion = undefined;
      manifest.repairingFallback = undefined;
      manifest.aiPipelineVersion = CURRENT_AI_PIPELINE_VERSION;
      manifest.upgradingAi = undefined;
      manifest.transcriptReviewIssues = undefined;
      manifest.status = "complete";
      manifest.error = undefined;
      try {
        await saveProcessingManifest(manifest);
      } catch (error) {
        // The note is already protected by CAS and saved. A manifest sync
        // failure should not make the UI report a failed note update; log it so
        // the next explicit regeneration can repair the sidecar.
        console.error(JSON.stringify({
          event: "recording_ai_draft_manifest_sync_failed",
          jobId: manifest.jobId,
          noteId: input.noteId,
          reason: String(error),
        }));
      }

      if (manifest.transcript?.trim()) {
        try {
          await invoke<boolean>("agent_insert_document", {
            userId: user.id,
            text: input.content,
            metadata: {
              type: "voice_recording",
              date: manifest.recordedAt?.split("T")[0] ?? new Date().toISOString().split("T")[0],
              recorded_at: manifest.recordedAt,
              timezone: manifest.timezone,
              source: "whisper_transcription",
              note_id: manifest.savedNoteId,
              note_updated_at: updated.updated_at,
            },
          });
        } catch {
          // RAG indexing is optional and must not undo an accepted note.
        }
      }

      return updated;
    } finally {
      await releaseProcessingJob(input.audioPath, runId);
    }
  }, { joinExisting: false });
}

async function saveNote(
  title: string,
  content: string,
  tags: string[],
  userId?: string,
  jobId?: string,
  context?: RecordingNoteContext,
) {
  if (!userId) {
    const user = authService.getUser();
    if (!user) throw new Error("User not authenticated");
    userId = user.id;
  }
  const request = {
    title,
    content,
    tags,
    color: "#E0F2FE",
    recorded_at: context?.recordedAt,
    recording_timezone: context?.timezone,
  };
  return jobId
    ? noteService.createRecordingNote(userId, jobId, request)
    : noteService.createNote(userId, request);
}


export function generateNoteTitle(): string {
  const now = new Date();
  const timestamp = now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `Recording - ${timestamp}`;
}
