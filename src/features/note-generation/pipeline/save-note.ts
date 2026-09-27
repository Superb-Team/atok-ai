import { authService } from "@/features/auth/api/auth.service";
import { NoteConflictError, noteService } from "@/features/notes/api/note.service";
import { insertRagDocument } from "@/features/note-generation/api/ai";
import { markProcessingFinished } from "@/features/note-generation/lib/manifest-state";
import { shouldPublishRecordingToRag } from "@/features/note-generation/lib/processing-review-policy";
import type { RecordingNoteContext } from "@/features/recording/lib/recording-note-metadata";
import { markStage, type ProcessingRun } from "@/features/note-generation/pipeline/processing-run";

export async function saveNote(
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

export interface GeneratedNote {
  title: string;
  content: string;
  processingDegraded: boolean;
  usedStructuredFallback: boolean;
  processingError?: string;
  hasFailedSection: boolean;
  transcriptRequiresReview: boolean;
  needsReview: boolean;
}

export async function saveGeneratedNote(run: ProcessingRun, note: GeneratedNote): Promise<void> {
  const { manifest } = run;
  const tSave = performance.now();
  const user = authService.getUser();
  if (!user) throw new Error("User not authenticated");

  const tags = ["voice-recording", "transcription", ...(note.needsReview ? ["needs-review"] : [])];
  manifest.status = "saving";
  await run.persist();
  let noteWasManuallyEdited = false;
  if (!manifest.savedNoteId) {
    const savedNote = await saveNote(note.title, note.content, tags, user.id, manifest.jobId, run.context);
    manifest.savedNoteId = savedNote.id;
    manifest.savedNoteUpdatedAt = savedNote.updated_at;
    // Persist the note id before optional indexing so a crash cannot create a
    // duplicate note when this job resumes.
    await run.persist();
  } else if (manifest.savedNoteUpdatedAt) {
    try {
      const savedNote = await noteService.updateNote(manifest.savedNoteId, user.id, {
        title: note.title,
        content: note.content,
        tags,
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

  if (shouldPublishRecordingToRag({
    processingDegraded: note.processingDegraded,
    hasFailedSection: note.hasFailedSection,
    transcriptRequiresReview: note.transcriptRequiresReview,
    noteWasManuallyEdited,
  })) {
    try {
      await insertRagDocument(user.id, note.content, {
        type: "voice_recording",
        date: run.context.recordedAt.split("T")[0],
        recorded_at: run.context.recordedAt,
        timezone: run.context.timezone,
        source: "whisper_transcription",
        note_id: manifest.savedNoteId,
        note_updated_at: manifest.savedNoteUpdatedAt,
      });
    } catch {
      // RAG insertion is optional — don't fail the workflow
    }
  }
  markStage(run, "save+rag", tSave);
  markStage(run, "total", run.startedAt);
  markProcessingFinished(manifest, {
    usedStructuredFallback: note.usedStructuredFallback,
    processingDegraded: note.processingDegraded,
    needsReview: note.needsReview,
    processingError: note.processingError,
    timings: run.timings,
  });
  await run.persist();
  console.log(JSON.stringify({
    event: "recording_processing_completed",
    jobId: manifest.jobId,
    status: manifest.status,
    enhancementMode: manifest.enhancementMode,
    timingsMs: run.timings,
  }));
}
