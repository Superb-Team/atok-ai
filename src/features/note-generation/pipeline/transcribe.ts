import { authService } from "@/features/auth/api/auth.service";
import { evaluateTranscriptIntegrity, transcribeAudio } from "@/features/note-generation/api/ai";
import { recordProcessingFailure } from "@/features/note-generation/lib/manifest-state";
import {
  CURRENT_AI_PIPELINE_VERSION,
  CURRENT_TRANSCRIPTION_PIPELINE_VERSION,
} from "@/features/note-generation/lib/processing-review-policy";
import { markStage, type ProcessingRun } from "@/features/note-generation/pipeline/processing-run";
import { saveNote } from "@/features/note-generation/pipeline/save-note";
import type { AudioProcessingResult } from "@/features/note-generation/types";
import { errorMessage, logger } from "@/lib/logger";

export type TranscriptionOutcome =
  | { kind: "transcribed"; transcript: string; requiresReview: boolean; reviewIssues: string[] }
  /** The run ended here (no speech, or transcription failed). */
  | { kind: "finished"; result: AudioProcessingResult };

export async function transcribeRecording(
  run: ProcessingRun,
  options: {
    refreshTranscript: boolean;
    repairWithStructuredFallback: boolean;
    assetsLoaded: Promise<unknown>;
  },
): Promise<TranscriptionOutcome> {
  const { manifest, audioPath, lang, noteTitle, previewOnly } = run;
  const tTranscribe = performance.now();
  try {
    // Language is pinned so quiet chunks don't drift.
    const transcript = !options.refreshTranscript && manifest.transcript?.trim()
      ? manifest.transcript
      : await transcribeAudio(audioPath, lang, options.refreshTranscript);
    if (!transcript.trim()) {
      // Silence/background noise is a successful transcription outcome, not
      // an infrastructure failure. Keep the recording, finish the manifest,
      // and skip note generation so no empty or scary "failure note" appears.
      await options.assetsLoaded;
      manifest.transcript = "";
      manifest.transcriptionPipelineVersion = CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
      manifest.status = "complete";
      manifest.error = undefined;
      manifest.timingsMs = {
        ...run.timings,
        transcribe: Math.round(performance.now() - tTranscribe),
        total: Math.round(performance.now() - run.startedAt),
      };
      await run.persist();
      return {
        kind: "finished",
        result: {
          noteTitle,
          enhancedText: "",
          success: true,
          outcome: "no_speech",
          message: lang === "id"
            ? "Rekaman tersimpan, tetapi tidak ada percakapan yang terdeteksi. Periksa microphone yang dipilih lalu coba lagi."
            : "The recording was saved, but no speech was detected. Check the selected microphone and try again.",
        },
      };
    }
    manifest.transcript = transcript;
    manifest.transcriptionPipelineVersion = CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
    const integrity = await evaluateTranscriptIntegrity(audioPath, transcript).catch((error) => ({
      revisionId: "unavailable",
      requiresReview: true,
      issues: [{
        code: "integrity_evaluation_failed",
        detail: `Transcript integrity evaluation failed: ${String(error)}`,
        advisory: false,
      }],
    }));
    const reviewIssues = integrity.issues
      .filter((issue) => issue.advisory !== true)
      .map((issue) => `${issue.code}: ${issue.detail}`);
    manifest.transcriptRevisionId = integrity.revisionId;
    manifest.transcriptReviewIssues = reviewIssues;
    const enhancementStageKey = `note:${CURRENT_AI_PIPELINE_VERSION}:${lang}:${integrity.revisionId}`;
    if (manifest.enhancementStageKey && manifest.enhancementStageKey !== enhancementStageKey) {
      manifest.sections = [];
    }
    manifest.enhancementStageKey = enhancementStageKey;
    manifest.status = options.repairWithStructuredFallback ? "partial" : "extracting";
    if (!options.repairWithStructuredFallback) manifest.error = undefined;
    await run.persist();
    markStage(run, "transcribe", tTranscribe);
    return { kind: "transcribed", transcript, requiresReview: integrity.requiresReview, reviewIssues };
  } catch (transcribeError) {
    recordProcessingFailure(manifest, transcribeError);
    await run.persistBestEffort();
    const user = authService.getUser();
    logger.error("note_generation.transcription_failed", {
      jobId: manifest.jobId,
      reason: "provider_or_capture_error",
      error: errorMessage(transcribeError),
    });
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
      await run.persistBestEffort();
    }
    return {
      kind: "finished",
      result: {
        noteTitle,
        enhancedText: "",
        success: false,
        error: previewOnly
          ? "The recording transcript could not be verified; the original note was kept."
          : String(transcribeError),
      },
    };
  }
}
