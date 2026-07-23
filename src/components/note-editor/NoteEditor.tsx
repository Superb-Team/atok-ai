import { useEffect, useState, type RefObject } from "react";
import {
  AlertTriangle,
  Bold,
  Check,
  Eye,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  LoaderCircle,
  Paperclip,
  Pencil,
  Quote,
  Save,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import type {
  MarkdownAction,
} from "@/lib/markdown-editing";
import type { NoteSaveStatus } from "./use-note-draft";

interface NoteEditorProps {
  title: string;
  content: string;
  tags: string[];
  status: NoteSaveStatus;
  error: string | null;
  isDirty: boolean;
  attaching: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onTitleChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onTagsChange: (value: string[]) => void;
  onFormat: (action: MarkdownAction) => void;
  onAttach: () => void;
  onSave: () => void;
  onDone: () => void;
  onReloadLatest: () => void;
  onOverwriteLatest: () => void;
}

const formatButtons: Array<{
  action: MarkdownAction;
  label: string;
  icon: typeof Bold;
}> = [
  { action: "bold", label: "Bold", icon: Bold },
  { action: "italic", label: "Italic", icon: Italic },
  { action: "heading2", label: "Heading 2", icon: Heading2 },
  { action: "heading3", label: "Heading 3", icon: Heading3 },
  { action: "bullet", label: "Bullet list", icon: List },
  { action: "ordered", label: "Numbered list", icon: ListOrdered },
  { action: "checklist", label: "Checklist", icon: ListChecks },
  { action: "quote", label: "Quote", icon: Quote },
  { action: "link", label: "Link", icon: Link },
];

function SaveStatus({ status }: { status: NoteSaveStatus }) {
  if (status === "saving") {
    return <><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Saving…</>;
  }
  if (status === "saved") {
    return <><Check className="h-3.5 w-3.5" /> Saved</>;
  }
  if (status === "conflict") {
    return <><AlertTriangle className="h-3.5 w-3.5" /> Conflict</>;
  }
  if (status === "error") {
    return <><AlertTriangle className="h-3.5 w-3.5" /> Save failed</>;
  }
  return <><span className="h-1.5 w-1.5 rounded-full bg-primary" /> Unsaved</>;
}

export function NoteEditor({
  title,
  content,
  tags,
  status,
  error,
  isDirty,
  attaching,
  textareaRef,
  onTitleChange,
  onContentChange,
  onTagsChange,
  onFormat,
  onAttach,
  onSave,
  onDone,
  onReloadLatest,
  onOverwriteLatest,
}: NoteEditorProps) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [tagText, setTagText] = useState(tags.join(", "));

  useEffect(() => {
    setTagText(tags.join(", "));
  }, [tags]);

  const commitTags = () => {
    const next = Array.from(new Set(
      tagText.split(",").map((tag) => tag.trim()).filter(Boolean),
    ));
    onTagsChange(next);
    setTagText(next.join(", "));
  };

  return (
    <article
      className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-10 pb-24 pt-10"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSave();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          <button
            type="button"
            onClick={() => setMode("write")}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition ${
              mode === "write" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Pencil className="h-3.5 w-3.5" /> Write
          </button>
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition ${
              mode === "preview" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Eye className="h-3.5 w-3.5" /> Preview
          </button>
        </div>

        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 text-xs ${
              status === "error" || status === "conflict"
                ? "text-destructive"
                : "text-muted-foreground"
            }`}
          >
            <SaveStatus status={status} />
          </span>
          <button
            type="button"
            onClick={onSave}
            disabled={!isDirty || status === "saving" || status === "conflict"}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 text-xs font-medium transition hover:bg-accent disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" /> Save
          </button>
          <button
            type="button"
            onClick={onDone}
            className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      </div>

      {(error || status === "conflict") && (
        <div className="mt-4 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
          <p>{error ?? "This note was changed somewhere else."}</p>
          {status === "conflict" && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={onReloadLatest}
                className="rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10"
              >
                Reload latest
              </button>
              <button
                type="button"
                onClick={onOverwriteLatest}
                className="rounded-md bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground"
              >
                Keep my version
              </button>
            </div>
          )}
        </div>
      )}

      <input
        value={title}
        onChange={(event) => onTitleChange(event.target.value)}
        maxLength={240}
        aria-label="Note title"
        className="mt-7 w-full border-0 bg-transparent font-display text-4xl font-semibold leading-[1.15] tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
        placeholder="Untitled note"
      />

      <input
        value={tagText}
        onChange={(event) => setTagText(event.target.value)}
        onBlur={commitTags}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitTags();
          }
        }}
        aria-label="Note tags"
        className="mt-4 w-full border-0 bg-transparent font-mono text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/40"
        placeholder="tags, separated, by commas"
      />

      {mode === "write" ? (
        <>
          <div className="sticky top-0 z-10 mt-7 flex flex-wrap items-center gap-1 border-y border-border bg-background/95 py-2 backdrop-blur">
            {formatButtons.map(({ action, label, icon: Icon }) => (
              <button
                key={action}
                type="button"
                onClick={() => onFormat(action)}
                title={label}
                aria-label={label}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-border" />
            <button
              type="button"
              onClick={onAttach}
              disabled={attaching}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <Paperclip className="h-4 w-4" />
              {attaching ? "Attaching…" : "Attach"}
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(event) => onContentChange(event.target.value)}
            spellCheck
            aria-label="Note content"
            placeholder="Start writing…"
            className="mt-5 min-h-[55vh] w-full resize-none border-0 bg-transparent font-mono text-[14px] leading-7 text-foreground/90 outline-none placeholder:text-muted-foreground/40"
          />
        </>
      ) : (
        <div className="mt-9 border-t border-border pt-9">
          {content.trim() ? (
            <MarkdownRenderer content={content} />
          ) : (
            <p className="italic text-muted-foreground">No content</p>
          )}
        </div>
      )}
    </article>
  );
}
