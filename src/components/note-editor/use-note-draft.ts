import { useCallback, useEffect, useRef, useState } from "react";
import {
  NoteConflictError,
  noteService,
} from "@/services/note.service";
import type { Note } from "@/types/note.types";

export type NoteSaveStatus = "saved" | "unsaved" | "saving" | "error" | "conflict";

interface NoteDraft {
  title: string;
  content: string;
  tags: string[];
}

interface UseNoteDraftOptions {
  note: Note;
  userId: string;
  onSaved: (note: Note) => void;
  autosaveMs?: number;
}

export function useNoteDraft({
  note,
  userId,
  onSaved,
  autosaveMs = 900,
}: UseNoteDraftOptions) {
  const initialDraft = (): NoteDraft => ({
    title: note.title,
    content: note.content ?? "",
    tags: note.tags ?? [],
  });
  const [draft, setDraftState] = useState<NoteDraft>(initialDraft);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<NoteSaveStatus>("saved");
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const baseUpdatedAtRef = useRef(note.updated_at);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const conflictRef = useRef(false);
  const onSavedRef = useRef(onSaved);

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    const next = initialDraft();
    draftRef.current = next;
    revisionRef.current = 0;
    savedRevisionRef.current = 0;
    baseUpdatedAtRef.current = note.updated_at;
    conflictRef.current = false;
    setDraftState(next);
    setRevision(0);
    setStatus("saved");
    setError(null);
  }, [note.id]);

  const updateDraft = useCallback((update: (current: NoteDraft) => NoteDraft) => {
    const next = update(draftRef.current);
    draftRef.current = next;
    revisionRef.current += 1;
    conflictRef.current = false;
    setDraftState(next);
    setRevision(revisionRef.current);
    setStatus("unsaved");
    setError(null);
  }, []);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (conflictRef.current) return false;

    if (saveInFlightRef.current) {
      await saveInFlightRef.current.catch(() => undefined);
    }
    if (conflictRef.current) return false;
    if (savedRevisionRef.current === revisionRef.current) return true;

    const snapshot = draftRef.current;
    const targetRevision = revisionRef.current;
    const title = snapshot.title.trim();
    if (!title) {
      setStatus("error");
      setError("Title cannot be empty.");
      return false;
    }

    setStatus("saving");
    setError(null);
    const request = noteService
      .updateNote(note.id, userId, {
        title,
        content: snapshot.content,
        tags: snapshot.tags,
        expected_updated_at: baseUpdatedAtRef.current,
      })
      .then((saved) => {
        baseUpdatedAtRef.current = saved.updated_at;
        savedRevisionRef.current = targetRevision;
        onSavedRef.current(saved);
        setStatus(
          savedRevisionRef.current === revisionRef.current ? "saved" : "unsaved",
        );
      })
      .catch((saveError: unknown) => {
        if (saveError instanceof NoteConflictError) {
          conflictRef.current = true;
          setStatus("conflict");
          setError(saveError.message);
          return;
        }
        setStatus("error");
        setError(saveError instanceof Error ? saveError.message : "Failed to save note.");
      })
      .finally(() => {
        saveInFlightRef.current = null;
      });

    saveInFlightRef.current = request;
    await request;
    return savedRevisionRef.current >= targetRevision && !conflictRef.current;
  }, [note.id, userId]);

  const reloadLatest = useCallback(async (): Promise<void> => {
    const latest = await noteService.getNote(note.id, userId);
    const next: NoteDraft = {
      title: latest.title,
      content: latest.content ?? "",
      tags: latest.tags ?? [],
    };
    draftRef.current = next;
    revisionRef.current = 0;
    savedRevisionRef.current = 0;
    baseUpdatedAtRef.current = latest.updated_at;
    conflictRef.current = false;
    setDraftState(next);
    setRevision(0);
    setStatus("saved");
    setError(null);
    onSavedRef.current(latest);
  }, [note.id, userId]);

  const overwriteLatest = useCallback(async (): Promise<boolean> => {
    const latest = await noteService.getNote(note.id, userId);
    baseUpdatedAtRef.current = latest.updated_at;
    conflictRef.current = false;
    setStatus("unsaved");
    setError(null);
    return saveNow();
  }, [note.id, saveNow, userId]);

  useEffect(() => {
    if (revision === savedRevisionRef.current || status !== "unsaved") {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveNow();
    }, autosaveMs);
    return () => window.clearTimeout(timer);
  }, [autosaveMs, revision, saveNow, status]);

  return {
    draft,
    status,
    error,
    isDirty: revision !== savedRevisionRef.current,
    setTitle: (title: string) => updateDraft((current) => ({ ...current, title })),
    setContent: (content: string) => updateDraft((current) => ({ ...current, content })),
    setTags: (tags: string[]) => updateDraft((current) => ({ ...current, tags })),
    saveNow,
    reloadLatest,
    overwriteLatest,
  };
}
