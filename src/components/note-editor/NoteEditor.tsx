import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  AlertTriangle,
  Bold,
  Check,
  Columns3,
  Code2,
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
  Plus,
  Quote,
  Save,
  Strikethrough,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import {
  getSlashCommandContext,
  type MarkdownAction,
  type MarkdownBlockCommand,
  type SlashCommandContext,
} from "@/lib/markdown-editing";
import type { NoteSaveStatus } from "./use-note-draft";
import { EditorCommandMenu } from "./EditorCommandMenu";
import {
  filterEditorBlockCommands,
  moveCommandSelection,
} from "./editor-block-commands";

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
  onInsertBlock: (
    command: MarkdownBlockCommand,
    slashContext?: SlashCommandContext | null,
  ) => void;
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
  { action: "strikethrough", label: "Strikethrough", icon: Strikethrough },
  { action: "inlineCode", label: "Inline code", icon: Code2 },
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
  onInsertBlock,
  onAttach,
  onSave,
  onDone,
  onReloadLatest,
  onOverwriteLatest,
}: NoteEditorProps) {
  const [mode, setMode] = useState<"write" | "preview" | "split">("write");
  const [tagText, setTagText] = useState(tags.join(", "));
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null);
  const slashContext = useMemo(
    () => getSlashCommandContext(content, cursor),
    [content, cursor],
  );
  const slashSignature = slashContext
    ? `${slashContext.start}:${slashContext.query}`
    : null;
  const slashMenuOpen = Boolean(
    slashContext && slashSignature !== dismissedSlash,
  );
  const commandMenuOpen = insertMenuOpen || slashMenuOpen;
  const visibleCommands = useMemo(
    () => filterEditorBlockCommands(slashMenuOpen ? slashContext?.query ?? "" : ""),
    [slashContext?.query, slashMenuOpen],
  );
  const activeCommandId = visibleCommands[activeCommandIndex]?.id;

  useEffect(() => {
    setTagText(tags.join(", "));
  }, [tags]);

  useEffect(() => {
    setActiveCommandIndex(visibleCommands.length > 0 ? 0 : -1);
  }, [slashContext?.query, insertMenuOpen, visibleCommands.length]);

  useEffect(() => {
    if (!slashContext) setDismissedSlash(null);
  }, [slashContext]);

  const closeCommandMenu = () => {
    setInsertMenuOpen(false);
    if (slashSignature) setDismissedSlash(slashSignature);
  };

  const selectCommand = (index = activeCommandIndex) => {
    const command = visibleCommands[index];
    if (!command) return false;
    onInsertBlock(command.id, slashMenuOpen ? slashContext : null);
    setInsertMenuOpen(false);
    setDismissedSlash(null);
    return true;
  };

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
        if (
          commandMenuOpen &&
          !event.nativeEvent.isComposing &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveCommandIndex((current) =>
              moveCommandSelection(
                current,
                event.key === "ArrowDown" ? 1 : -1,
                visibleCommands.length,
              ),
            );
            return;
          }
          if (
            (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) &&
            visibleCommands.length > 0
          ) {
            event.preventDefault();
            selectCommand();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            closeCommandMenu();
            textareaRef.current?.focus();
            return;
          }
        }
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
          <button
            type="button"
            onClick={() => setMode("split")}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition ${
              mode === "split" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Columns3 className="h-3.5 w-3.5" /> Split
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

      {mode !== "preview" ? (
        <>
          <div className="sticky top-0 z-20 mt-7 flex flex-wrap items-center gap-1 border-y border-border bg-background/95 py-2 backdrop-blur">
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  const opening = !insertMenuOpen;
                  setInsertMenuOpen(opening);
                  setDismissedSlash(slashSignature);
                  setActiveCommandIndex(0);
                  if (opening) {
                    window.requestAnimationFrame(() => textareaRef.current?.focus());
                  }
                }}
                aria-expanded={commandMenuOpen}
                aria-controls="editor-command-menu"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary/10 px-2.5 text-xs font-semibold text-primary transition hover:bg-primary/15"
              >
                <Plus className="h-4 w-4" /> Insert
              </button>
              {commandMenuOpen && (
                <EditorCommandMenu
                  commands={visibleCommands}
                  activeIndex={activeCommandIndex}
                  onActiveIndexChange={setActiveCommandIndex}
                  onSelect={(command) => {
                    const index = visibleCommands.findIndex(({ id }) => id === command);
                    selectCommand(index);
                  }}
                  onClose={closeCommandMenu}
                />
              )}
            </div>
            <span className="mx-1 h-5 w-px bg-border" />
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
            <span className="ml-auto hidden text-[11px] text-muted-foreground lg:inline">
              Type <kbd className="rounded border border-border px-1 py-0.5 font-mono">/</kbd> for blocks
            </span>
          </div>
          <div className={mode === "split" ? "mt-5 grid min-h-[60vh] grid-cols-2 gap-0 overflow-hidden rounded-xl border border-border" : "mt-5"}>
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(event) => {
                setCursor(event.currentTarget.selectionStart);
                onContentChange(event.target.value);
              }}
              onClick={(event) => setCursor(event.currentTarget.selectionStart)}
              onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
              onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                const modifier = event.metaKey || event.ctrlKey;
                const key = event.key.toLowerCase();
                if (modifier && key === "b") {
                  event.preventDefault();
                  onFormat("bold");
                } else if (modifier && key === "i") {
                  event.preventDefault();
                  onFormat("italic");
                } else if (modifier && event.shiftKey && key === "7") {
                  event.preventDefault();
                  onFormat("ordered");
                } else if (modifier && event.shiftKey && key === "8") {
                  event.preventDefault();
                  onFormat("bullet");
                }
              }}
              spellCheck
              aria-label="Note content"
              aria-controls={commandMenuOpen ? "editor-command-menu" : undefined}
              aria-activedescendant={
                commandMenuOpen && activeCommandId
                  ? `editor-command-${activeCommandId}`
                  : undefined
              }
              aria-autocomplete="list"
              aria-expanded={commandMenuOpen}
              placeholder={'Start writing… Type "/" for headings, lists, tables, and more.'}
              className={`min-h-[60vh] w-full resize-none border-0 bg-transparent font-mono text-[14px] leading-7 text-foreground/90 outline-none placeholder:text-muted-foreground/40 ${
                mode === "split" ? "p-5" : ""
              }`}
            />
            {mode === "split" && (
              <div className="max-h-[70vh] overflow-y-auto border-l border-border bg-muted/15 p-6">
                {content.trim() ? (
                  <MarkdownRenderer content={content} />
                ) : (
                  <p className="italic text-muted-foreground">Preview appears here.</p>
                )}
              </div>
            )}
          </div>
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
