import { authService } from "@/features/auth/api/auth.service";
import { noteService } from "@/features/notes/api/note.service";
import type { Note } from "@/features/notes/types";
import { insertRagDocument } from "@/features/note-generation/api/ai";
import {
  claimProcessingJob,
  loadProcessingManifest,
  releaseProcessingJob,
  saveProcessingManifest,
} from "@/features/note-generation/api/processing-manifest";
import { anchorAssetsInTranscript } from "@/features/note-generation/lib/asset-markers";
import {
  beginProcessingAttempt,
  clearTranscriptState,
  createProcessingManifest,
  markDraftAccepted,
  planRerun,
  recordProcessingFailure,
  resolveRecordingContext,
  type RerunPlan,
} from "@/features/note-generation/lib/manifest-state";
import {
  shouldOpenAiDraftPreview,
  shouldRefreshTranscript,
} from "@/features/note-generation/lib/processing-review-policy";
import { LANGUAGE_NAMES } from "@/features/note-generation/lib/prompts";
import { enhanceTranscript } from "@/features/note-generation/pipeline/enhance-note";
import { finalizeNote, type FinalizedNote } from "@/features/note-generation/pipeline/finalize-note";
import type { ProcessingRun } from "@/features/note-generation/pipeline/processing-run";
import { loadRecordingAssets } from "@/features/note-generation/pipeline/recording-assets";
import { saveGeneratedNote } from "@/features/note-generation/pipeline/save-note";
import { transcribeRecording } from "@/features/note-generation/pipeline/transcribe";
import type {
  AudioProcessingOptions,
  AudioProcessingResult,
  ProcessingManifest,
} from "@/features/note-generation/types";
import { recordingProcessingGuard } from "@/features/recording/lib/recording-processing-guard";
import type { RecordingNoteContext } from "@/features/recording/lib/recording-note-metadata";
import { errorMessage, logger } from "@/lib/logger";

export type { AudioProcessingOptions, AudioProcessingResult } from "@/features/note-generation/types";

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

// Pipeline: prepare manifest -> transcribe (screenshots load in parallel)
// -> AI enhancement -> quality gate/title -> preview or save.
async function processAudioRecordingOnce(
  audioPath: string,
  noteTitle: string,
  language?: string,
  context?: RecordingNoteContext,
  options: AudioProcessingOptions = {},
): Promise<AudioProcessingResult> {
  const startedAt = performance.now();
  const previewOnly = options.previewOnly === true;
  let manifest: ProcessingManifest | null = null;
  const persist = async () => {
    if (manifest && !previewOnly) await saveProcessingManifest(manifest);
  };
  const persistBestEffort = async () => {
    if (manifest && !previewOnly) await saveProcessingManifest(manifest).catch(() => {});
  };
  try {
    // `??` not `||`: an explicit "" means AUTO-detect and must survive; only a
    // missing language (legacy handoff) falls back to Indonesian.
    const lang = language ?? "id";
    const langName = LANGUAGE_NAMES[lang] || "the same language as the transcript";
    const existing = await loadProcessingManifest(audioPath);
    const resolvedContext = resolveRecordingContext(context, existing, audioPath);
    const activeManifest = existing ?? createProcessingManifest(audioPath, noteTitle, lang, resolvedContext);
    manifest = activeManifest;
    let rerun: RerunPlan = { repairWithStructuredFallback: false, changed: false };
    if (!existing) {
      await persist();
    } else {
      rerun = planRerun(existing, noteTitle, lang, resolvedContext, options.forceAiUpgrade === true);
      if (rerun.changed) await persist();
    }
    const run: ProcessingRun = {
      audioPath,
      noteTitle,
      lang,
      langName,
      context: resolvedContext,
      manifest: activeManifest,
      previewOnly,
      startedAt,
      timings: {},
      persist,
      persistBestEffort,
    };

    beginProcessingAttempt(run.manifest, options.retryFromUser === true);
    await persist();

    const refreshTranscript = shouldRefreshTranscript(
      run.manifest.transcriptionPipelineVersion,
      run.manifest.transcript,
    );
    if (refreshTranscript) {
      clearTranscriptState(run.manifest);
      await persist();
    }

    const assetsLoaded = loadRecordingAssets(audioPath, langName, rerun.repairWithStructuredFallback);
    const transcription = await transcribeRecording(run, {
      refreshTranscript,
      repairWithStructuredFallback: rerun.repairWithStructuredFallback,
      assetsLoaded,
    });
    if (transcription.kind === "finished") return transcription.result;

    const loadedAssets = await assetsLoaded;
    if (loadedAssets) run.timings["assets+vision"] = loadedAssets.elapsed;
    const source = anchorAssetsInTranscript(transcription.transcript, loadedAssets);

    const draft = await enhanceTranscript(run, source, rerun);
    const note = await finalizeNote(run, transcription.transcript, source, draft);
    const hasFailedSection = run.manifest.sections.some((section) => section.status === "failed");
    const needsReview = note.processingDegraded || hasFailedSection || transcription.requiresReview;

    if (previewOnly) {
      return previewResult(note, transcription.transcript, run.manifest, {
        hasFailedSection,
        transcriptReviewIssues: transcription.reviewIssues,
      });
    }

    await saveGeneratedNote(run, {
      title: note.title,
      content: note.content,
      processingDegraded: note.processingDegraded,
      usedStructuredFallback: note.usedStructuredFallback,
      processingError: note.processingError,
      hasFailedSection,
      transcriptRequiresReview: transcription.requiresReview,
      needsReview,
    });
    return { noteTitle: note.title, enhancedText: note.content, success: true, outcome: "note_created" };
  } catch (error) {
    if (manifest) {
      recordProcessingFailure(manifest, error);
      await persistBestEffort();
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

function previewResult(
  note: FinalizedNote,
  transcript: string,
  manifest: ProcessingManifest,
  review: { hasFailedSection: boolean; transcriptReviewIssues: string[] },
): AudioProcessingResult {
  const previewWarnings = [
    ...note.qualityIssues.map((issue) => `${issue.code}: ${issue.detail}`),
    ...(review.hasFailedSection ? ["Satu atau lebih bagian memakai transcript sumber karena hasil AI bagian tersebut tidak lolos validasi."] : []),
    ...review.transcriptReviewIssues,
  ];
  if (!shouldOpenAiDraftPreview(note.content.trim().length > 0, note.usedStructuredFallback)) {
    const reason = note.usedStructuredFallback
      ? `AI provider gagal menghasilkan draft yang dapat direview${note.processingError ? `: ${note.processingError}` : "."}`
      : "AI menghasilkan draft kosong.";
    return {
      noteTitle: note.title,
      enhancedText: "",
      success: false,
      error: reason,
    };
  }
  return {
    noteTitle: note.title,
    enhancedText: note.content,
    success: true,
    canonicalTranscript: transcript,
    transcriptRevisionId: manifest.transcriptRevisionId,
    warnings: previewWarnings,
    outcome: "draft_preview",
    message: "AI draft passed transcript and quality checks; review it before saving.",
  };
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

      markDraftAccepted(manifest, {
        noteTitle: input.noteTitle,
        noteUpdatedAt: updated.updated_at,
        canonicalTranscript: input.canonicalTranscript,
        transcriptRevisionId: input.transcriptRevisionId,
      });
      try {
        await saveProcessingManifest(manifest);
      } catch (error) {
        // The note is already protected by CAS and saved. A manifest sync
        // failure should not make the UI report a failed note update; log it so
        // the next explicit regeneration can repair the sidecar.
        logger.error("note_generation.draft_manifest_sync_failed", {
          jobId: manifest.jobId,
          noteId: input.noteId,
          reason: errorMessage(error),
        });
      }

      if (manifest.transcript?.trim()) {
        try {
          await insertRagDocument(user.id, input.content, {
            type: "voice_recording",
            date: manifest.recordedAt?.split("T")[0] ?? new Date().toISOString().split("T")[0],
            recorded_at: manifest.recordedAt,
            timezone: manifest.timezone,
            source: "whisper_transcription",
            note_id: manifest.savedNoteId,
            note_updated_at: updated.updated_at,
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
