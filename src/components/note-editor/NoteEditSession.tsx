import { useCallback, useEffect, useRef, useState } from "react";
import { noteAssetService } from "@/services/note-asset.service";
import {
  applyMarkdownAction,
  insertMarkdownAtSelection,
  type MarkdownAction,
} from "@/lib/markdown-editing";
import type { Note } from "@/types/note.types";
import { NoteEditor } from "./NoteEditor";
import { useNoteDraft } from "./use-note-draft";

interface NoteEditSessionProps {
  note: Note;
  userId: string;
  onSaved: (note: Note) => void;
  onDone: () => void;
  registerFinish: (finish: (() => Promise<boolean>) | null) => void;
}

export function NoteEditSession({
  note,
  userId,
  onSaved,
  onDone,
  registerFinish,
}: NoteEditSessionProps) {
  const editor = useNoteDraft({ note, userId, onSaved });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const finish = useCallback(async () => {
    const saved = await editor.saveNow();
    if (saved) onDone();
    return saved;
  }, [editor.saveNow, onDone]);

  useEffect(() => {
    registerFinish(finish);
    return () => registerFinish(null);
  }, [finish, registerFinish]);

  const restoreSelection = (start: number, end: number) => {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start, end);
    });
  };

  const handleFormat = (action: MarkdownAction) => {
    const textarea = textareaRef.current;
    const edit = applyMarkdownAction(
      editor.draft.content,
      textarea?.selectionStart ?? editor.draft.content.length,
      textarea?.selectionEnd ?? editor.draft.content.length,
      action,
    );
    editor.setContent(edit.value);
    restoreSelection(edit.selectionStart, edit.selectionEnd);
  };

  const handleAttach = async () => {
    if (attaching) return;
    try {
      setAttachmentError(null);
      const sourcePath = await noteAssetService.pickAssetFile();
      if (!sourcePath) return;
      setAttaching(true);
      const asset = await noteAssetService.importAsset(sourcePath);
      const textarea = textareaRef.current;
      const edit = insertMarkdownAtSelection(
        editor.draft.content,
        textarea?.selectionStart ?? editor.draft.content.length,
        textarea?.selectionEnd ?? editor.draft.content.length,
        noteAssetService.assetMarkdown(asset),
      );
      editor.setContent(edit.value);
      restoreSelection(edit.selectionStart, edit.selectionEnd);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "Failed to attach file.",
      );
    } finally {
      setAttaching(false);
    }
  };

  return (
    <NoteEditor
      title={editor.draft.title}
      content={editor.draft.content}
      tags={editor.draft.tags}
      status={editor.status}
      error={attachmentError ?? editor.error}
      isDirty={editor.isDirty}
      attaching={attaching}
      textareaRef={textareaRef}
      onTitleChange={editor.setTitle}
      onContentChange={editor.setContent}
      onTagsChange={editor.setTags}
      onFormat={handleFormat}
      onAttach={() => void handleAttach()}
      onSave={() => void editor.saveNow()}
      onDone={() => void finish()}
      onReloadLatest={() => void editor.reloadLatest()}
      onOverwriteLatest={() => void editor.overwriteLatest()}
    />
  );
}
