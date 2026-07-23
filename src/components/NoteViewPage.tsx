import { useEffect, useMemo, useRef, useState, Component } from "react";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import type { Note } from "@/types/note.types";
import { ArrowLeft, Star, Trash2, Edit, Paperclip } from "lucide-react";
import { noteAssetService } from "@/services/note-asset.service";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { NoteEditSession } from "@/components/note-editor/NoteEditSession";

class ErrorBoundary extends Component<{ fallback: React.ReactNode; children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: unknown) {
    console.error("Markdown rendering failed; showing raw note text instead:", error);
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

// AI-generated notes often open with a "# <title>" heading that repeats the
// note's title field verbatim (or a truncated version of it, from older
// title-length limits) — drop it so the title isn't shown twice on the page.
function stripLeadingDuplicateHeading(content: string, title: string): string {
  const match = content.match(/^\s*#\s+(.+?)\s*\n+([\s\S]*)$/);
  if (!match) return content;

  const normalize = (value: string) =>
    value
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .replace(/\.{3}$/, "");

  const heading = normalize(match[1]);
  const noteTitle = normalize(title);
  if (!heading || !noteTitle) return content;

  if (heading === noteTitle || heading.startsWith(noteTitle) || noteTitle.startsWith(heading)) {
    return match[2];
  }
  return content;
}

interface NoteViewPageProps {
  noteId: number;
  onBack: () => void;
}

const headerIconButton =
  "inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

export default function NoteViewPage({ noteId, onBack }: NoteViewPageProps) {
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const finishEditorRef = useRef<(() => Promise<boolean>) | null>(null);

  const bodyContent = useMemo(
    () => (note?.content ? stripLeadingDuplicateHeading(note.content, note.title) : ""),
    [note?.content, note?.title]
  );

  useEffect(() => {
    setIsEditing(false);
    loadNote();
  }, [noteId]);

  const loadNote = async () => {
    try {
      setError("");
      const user = authService.getUser();
      if (!user) {
        setError("User not authenticated");
        return;
      }

      const fetchedNote = await noteService.getNote(noteId, user.id);
      setNote(fetchedNote);
    } catch (err) {
      console.error("Failed to load note:", err);
      setError(err instanceof Error ? err.message : "Failed to load note");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleFavorite = async () => {
    if (!note) return;

    try {
      const user = authService.getUser();
      if (!user) return;

      await noteService.toggleFavorite(note.id, user.id);
      await loadNote();
    } catch (error) {
      console.error("Failed to toggle favorite:", error);
    }
  };

  const handleAttach = async () => {
    if (!note || attaching) return;
    try {
      const sourcePath = await noteAssetService.pickAssetFile();
      if (!sourcePath) return;

      setAttaching(true);
      const user = authService.getUser();
      if (!user) throw new Error("User not authenticated");

      const asset = await noteAssetService.importAsset(sourcePath);
      const content = noteAssetService.appendAssetToContent(note.content ?? "", asset);
      await noteService.updateNote(note.id, user.id, {
        content,
        expected_updated_at: note.updated_at,
      });
      await loadNote();
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttaching(false);
    }
  };

  const handleDelete = () => {
    if (!note || deleting) return;
    setShowDeleteConfirm(true);
  };

  const handleBack = async () => {
    if (isEditing && finishEditorRef.current) {
      const saved = await finishEditorRef.current();
      if (!saved) return;
    }
    onBack();
  };

  const confirmDelete = async () => {
    if (!note) return;
    setDeleting(true);
    try {
      const user = authService.getUser();
      if (!user) {
        setDeleting(false);
        return;
      }

      await noteService.deleteNote(note.id, user.id);
      onBack();
    } catch (error) {
      console.error("Failed to delete note:", error);
      setError("Failed to delete note");
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen flex-1 flex-col overflow-hidden bg-background">
        <div className="border-b border-border px-10 py-4">
          <div className="mx-auto flex max-w-4xl items-center justify-between">
            <div className="h-9 w-24 animate-pulse rounded-lg bg-muted" />
            <div className="flex gap-1.5">
              <div className="h-9 w-9 animate-pulse rounded-lg bg-muted" />
              <div className="h-9 w-9 animate-pulse rounded-lg bg-muted" />
            </div>
          </div>
        </div>
        <div className="mx-auto w-full max-w-4xl flex-1 px-10 py-12">
          <div className="h-4 w-40 animate-pulse rounded-md bg-muted/70" />
          <div className="mt-4 h-9 w-3/4 animate-pulse rounded-lg bg-muted" />
          <div className="mt-10 space-y-3">
            <div className="h-3 animate-pulse rounded-full bg-muted/70" />
            <div className="h-3 w-11/12 animate-pulse rounded-full bg-muted/70" />
            <div className="h-3 w-4/5 animate-pulse rounded-full bg-muted/70" />
            <div className="h-3 w-2/3 animate-pulse rounded-full bg-muted/70" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !note) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-background">
        <div className="flex flex-col items-center rounded-xl border border-border bg-card px-10 py-14 text-center shadow-sm">
          <p className="mb-6 text-sm text-destructive">{error || "Note not found"}</p>
          <button
            type="button"
            onClick={() => void handleBack()}
            className="inline-flex items-center gap-2 rounded-lg border border-input bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent active:scale-[0.98]"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            Back to notes
          </button>
        </div>
      </div>
    );
  }

  const formatDate = (dateString: string, timeZone?: string) => {
    const date = new Date(dateString);
    try {
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        ...(timeZone ? { timeZone } : {}),
      });
    } catch {
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  };

  return (
    <>
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={(open) => {
          if (!deleting) setShowDeleteConfirm(open);
        }}
        title="Delete note?"
        description="Are you sure you want to delete this note? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
        loading={deleting}
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={attachError !== null}
        onOpenChange={(open) => {
          if (!open) setAttachError(null);
        }}
        title="Attachment failed"
        description={attachError ?? ""}
        confirmText="OK"
        mode="alert"
        variant="destructive"
      />
      <div className="flex h-screen flex-1 flex-col overflow-hidden bg-background">
        {/* Header */}
        <div className="border-b border-border bg-background/90 backdrop-blur-sm">
          <div className="mx-auto max-w-4xl px-10 py-3.5">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => void handleBack()}
                className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-[0.98]"
              >
                <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
                Notes
              </button>

              <div className="flex items-center gap-1">
                {!isEditing && (
                  <>
                    <button
                      type="button"
                      onClick={handleAttach}
                      disabled={attaching}
                      className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-[0.98] disabled:opacity-50"
                      aria-label="Attach file"
                    >
                      <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                      {attaching ? "Attaching…" : "Attach"}
                    </button>

                    <button
                      type="button"
                      onClick={handleToggleFavorite}
                      className={
                        note.is_favorite
                          ? "inline-flex h-9 w-9 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary/10 active:scale-[0.96]"
                          : headerIconButton
                      }
                      aria-label={note.is_favorite ? "Remove from favorites" : "Add to favorites"}
                    >
                      <Star
                        className={`h-4 w-4 ${note.is_favorite ? "fill-current" : ""}`}
                        strokeWidth={1.75}
                      />
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsEditing(true)}
                      className={headerIconButton}
                      aria-label="Edit note"
                    >
                      <Edit className="h-4 w-4" strokeWidth={1.75} />
                    </button>

                    <button
                      type="button"
                      onClick={handleDelete}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:scale-[0.96]"
                      aria-label="Delete note"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Content: the note reads like a document, not a boxed widget. */}
        <div className="flex-1 overflow-y-auto">
          {isEditing ? (
            <NoteEditSession
              note={note}
              userId={authService.getUser()?.id ?? ""}
              onSaved={setNote}
              onDone={() => setIsEditing(false)}
              registerFinish={(finish) => {
                finishEditorRef.current = finish;
              }}
            />
          ) : (
          <article className="mx-auto max-w-4xl px-10 pb-24 pt-12">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] text-muted-foreground">
              {note.color && (
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15"
                  style={{ backgroundColor: note.color }}
                />
              )}
              {note.recorded_at ? (
                <>
                  <span>
                    Recorded {formatDate(note.recorded_at, note.recording_timezone)}
                  </span>
                  <span className="text-muted-foreground/60">
                    Created {formatDate(note.created_at)}
                  </span>
                </>
              ) : (
                <span>Created {formatDate(note.created_at)}</span>
              )}
              {note.updated_at !== note.created_at && (
                <span className="text-muted-foreground/60">
                  Updated {formatDate(note.updated_at)}
                </span>
              )}
            </div>

            <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.15] tracking-tight text-foreground">
              {note.title}
            </h1>

            {(note.tags ?? []).length > 0 && (
              <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1">
                {(note.tags ?? []).map((tag) => (
                  <span key={tag} className="font-mono text-xs text-muted-foreground">
                    #{tag}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-9 border-t border-border pt-9">
              {bodyContent ? (
                // Keyed so the boundary resets when the note changes — a caught
                // error (e.g. a transient one during dev HMR) otherwise pins the
                // raw-text fallback until the whole page unmounts.
                <ErrorBoundary key={`${note.id}-${note.updated_at}`} fallback={
                  <pre className="whitespace-pre-wrap leading-relaxed text-foreground/90">
                    {bodyContent}
                  </pre>
                }>
                  <MarkdownRenderer content={bodyContent} />
                </ErrorBoundary>
              ) : (
                <p className="italic text-muted-foreground">No content</p>
              )}
            </div>
          </article>
          )}
        </div>
      </div>
    </>
  );
}
