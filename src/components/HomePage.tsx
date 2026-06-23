import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import type { Note } from "@/types/note.types";
import { FileText, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface HomePageProps {
  onNoteClick?: (noteId: number) => void;
}

export default function HomePage({ onNoteClick }: HomePageProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [processingNotes, setProcessingNotes] = useState<Set<string>>(new Set());
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const loadRequestId = useRef(0);

  const filteredNotes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return notes.filter((note) => {
      if (note.is_archived) return false;

      const matchesQuery =
        !query ||
        note.title.toLowerCase().includes(query) ||
        (note.content ?? "").toLowerCase().includes(query) ||
        (note.tags ?? []).some((tag) => tag.toLowerCase().includes(query));

      const matchesFavorite = !favoriteOnly || note.is_favorite;

      return matchesQuery && matchesFavorite;
    });
  }, [notes, searchQuery, favoriteOnly]);

  const hasActiveFilters = searchQuery.trim().length > 0 || favoriteOnly;

  const clearFilters = () => {
    setSearchQuery("");
    setFavoriteOnly(false);
  };

  const loadNotes = useCallback(async () => {
    const requestId = ++loadRequestId.current;

    try {
      setError("");
      const user = authService.getUser();
      if (!user) {
        if (requestId === loadRequestId.current) {
          setError("User not authenticated");
          setLoading(false);
        }
        return;
      }

      const fetchedNotes = await noteService.getNotes(user.id);
      if (requestId === loadRequestId.current) {
        setNotes(fetchedNotes);
        setError("");
      }
    } catch (err) {
      if (requestId === loadRequestId.current) {
        setError(getErrorMessage(err, "Failed to load notes"));
      }
    } finally {
      if (requestId === loadRequestId.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadNotes();

    let unlisten1: (() => void) | undefined;
    let storageInterval: NodeJS.Timeout | undefined;

    let lastRecordingCheck = 0;

    // The recording popup hands off the finished take via the 'audio_to_process'
    // localStorage key; this component picks it up, transcribes + saves the note,
    // and clears its own processing indicator inline in processAudioRecording.
    storageInterval = setInterval(() => {
      const audioData = localStorage.getItem('audio_to_process');
      if (audioData) {
        try {
          const { audioPath, noteTitle, language, timestamp } = JSON.parse(audioData);
          if (timestamp > lastRecordingCheck) {
            lastRecordingCheck = timestamp;
            setProcessingNotes(prev => new Set(prev).add(noteTitle));
            localStorage.removeItem('audio_to_process');
            processAudioRecording(audioPath, noteTitle, language);
          }
        } catch {
          localStorage.removeItem('audio_to_process');
        }
      }
    }, 500);

    const setupTauriListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        unlisten1 = await listen('recording-started', (event: any) => {
          const noteTitle = event.payload?.noteTitle;
          if (noteTitle) {
            setProcessingNotes(prev => new Set(prev).add(noteTitle));
          }
        });
      } catch (err) {
        console.error("Failed to set up Tauri event listeners:", err);
      }
    };

    setupTauriListeners();

    return () => {
      if (storageInterval) clearInterval(storageInterval);
      unlisten1?.();
    };
  }, [loadNotes]);

  const processAudioRecording = async (audioPath: string, noteTitle: string, language?: string) => {
    try {
      const { processAudioRecording: processAudio } = await import('@/services/audio-processor.service');
      const result = await processAudio(audioPath, noteTitle, language);

      if (!result.success) {
        throw new Error(result.error || 'Processing failed');
      }

      setProcessingNotes(prev => {
        const next = new Set(prev);
        next.delete(noteTitle);
        return next;
      });

      await loadNotes();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setAlertMessage(`Recording processing failed:\n${errorMessage}`);

      setProcessingNotes(prev => {
        const next = new Set(prev);
        next.delete(noteTitle);
        return next;
      });
    }
  };

  const handleToggleFavorite = async (noteId: number) => {
    try {
      const user = authService.getUser();
      if (!user) return;

      await noteService.toggleFavorite(noteId, user.id);
      await loadNotes();
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-neutral-900">
        <p className="text-neutral-600 dark:text-neutral-400">Loading notes...</p>
      </div>
    );
  }

  return (
    <>
      <ConfirmDialog
        open={alertMessage !== null}
        onOpenChange={(open) => {
          if (!open) setAlertMessage(null);
        }}
        title="Recording processing failed"
        description={alertMessage ?? ""}
        confirmText="OK"
        mode="alert"
        variant="destructive"
      />
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-neutral-950">
      <div className="px-8 py-6 border-b border-white/10 bg-neutral-950/85 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight text-white">
            My Notes
          </h1>
          <p className="text-sm text-neutral-400">
            Search, organize, and revisit your workspace knowledge.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-7xl mx-auto">
          {error && (
            <div className="mb-6 rounded-2xl border border-red-500/30 bg-red-950/30 p-4 text-sm text-red-200">
              {error}
            </div>
          )}

          <div className="mb-6 rounded-[1.75rem] border border-white/10 bg-[#111111]/90 p-4 shadow-xl shadow-black/20 backdrop-blur">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex h-12 flex-1 items-center gap-3 rounded-2xl border border-white/[0.08] bg-black/25 px-4 transition focus-within:border-white/20 focus-within:bg-black/35 focus-within:ring-2 focus-within:ring-white/[0.06]">
                <Search className="h-4 w-4 shrink-0 text-neutral-500" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search notes by title, content, or tag..."
                  className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="shrink-0 rounded-lg p-1 text-neutral-500 transition hover:bg-white/10 hover:text-neutral-200"
                    aria-label="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFavoriteOnly((value) => !value)}
                  className={`inline-flex h-11 items-center gap-2 rounded-2xl border px-4 text-sm font-medium transition ${
                    favoriteOnly
                      ? "border-white/20 bg-white/[0.09] text-white"
                      : "border-white/[0.08] bg-black/25 text-neutral-300 hover:border-white/15 hover:bg-white/[0.06]"
                  }`}
                >
                  <Star className={`h-4 w-4 ${favoriteOnly ? "fill-current" : ""}`} />
                  Favorites
                </button>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/[0.08] bg-black/25 px-4 text-sm font-medium text-neutral-400 transition hover:border-white/15 hover:bg-white/[0.06] hover:text-neutral-200"
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>

          {notes.length === 0 && processingNotes.size === 0 ? (
            <EmptyState
              title="No notes yet"
              description="Create your first note or record audio to start building your workspace."
            />
          ) : filteredNotes.length === 0 && processingNotes.size === 0 ? (
            <EmptyState
              title="No matching notes"
              description="Try another keyword or clear the active filters."
              actionLabel="Clear filters"
              onAction={clearFilters}
            />
          ) : (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
              {Array.from(processingNotes).map((noteTitle) => (
                <LoadingNoteCard key={noteTitle} title={noteTitle} />
              ))}

              {filteredNotes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  onToggleFavorite={handleToggleFavorite}
                  onClick={() => onNoteClick?.(note.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl border border-white/10 bg-neutral-900/60 px-6 py-20 text-center shadow-2xl shadow-black/20">
      <div className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-neutral-950/80">
        <FileText className="h-8 w-8 text-neutral-500" />
      </div>
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-neutral-400">{description}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-6 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-white/10"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function LoadingNoteCard({ title }: { title: string }) {
  return (
    <div className="min-h-[250px] rounded-[1.75rem] border border-white/[0.08] bg-[#151515] p-5 shadow-xl shadow-black/20 animate-pulse">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">Processing</p>
          <h3 className="mt-2 line-clamp-2 text-lg font-semibold text-neutral-50">{title}</h3>
        </div>
        <div className="h-9 w-9 rounded-2xl bg-white/5" />
      </div>
      <div className="space-y-2">
        <div className="h-2 rounded-full bg-white/10" />
        <div className="h-2 w-5/6 rounded-full bg-white/10" />
        <div className="h-2 w-2/3 rounded-full bg-white/10" />
      </div>
      <div className="mt-6 flex items-center gap-2 text-sm text-neutral-500">
        <div className="flex space-x-1">
          <div className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-bounce [animation-delay:-0.3s]" />
          <div className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-bounce [animation-delay:-0.15s]" />
          <div className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-bounce" />
        </div>
        Generating notes
      </div>
    </div>
  );
}

interface NoteCardProps {
  note: Note;
  onToggleFavorite: (noteId: number) => void;
  onClick?: () => void;
}

function NoteCard({ note, onToggleFavorite, onClick }: NoteCardProps) {
  const tags = note.tags ?? [];
  const preview = cleanNotePreview(note.content);

  return (
    <article
      onClick={onClick}
      className="group relative flex min-h-[250px] cursor-pointer flex-col overflow-hidden rounded-[1.75rem] border border-white/[0.08] bg-[#151515] p-5 shadow-xl shadow-black/20 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/15 hover:bg-[#191919]"
    >

      <div className="relative mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-lg font-semibold leading-snug text-white">
            {note.title}
          </h3>
          <p className="mt-2 text-xs text-neutral-500">
            Updated {formatNoteDate(note.updated_at)}
          </p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(note.id);
          }}
          className={`rounded-2xl border p-2 transition ${
            note.is_favorite
              ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
              : "border-white/10 bg-white/[0.03] text-neutral-500 hover:bg-white/10 hover:text-neutral-200"
          }`}
          aria-label={note.is_favorite ? "Remove from favorites" : "Add to favorites"}
        >
          <Star className={`h-4 w-4 ${note.is_favorite ? "fill-current" : ""}`} />
        </button>
      </div>

      <p className="relative line-clamp-4 flex-1 text-sm leading-6 text-neutral-300/85">
        {preview || "No content yet."}
      </p>

      <div className="relative mt-5 border-t border-white/10 pt-4">
        <div className="flex flex-wrap gap-2">
          {tags.length > 0 ? (
            <>
              {tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-neutral-300"
                >
                  {tag}
                </span>
              ))}
              {tags.length > 3 && (
                <span className="rounded-full px-2.5 py-1 text-[11px] font-medium text-neutral-500">
                  +{tags.length - 3}
                </span>
              )}
            </>
          ) : (
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-neutral-500">
              note
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function cleanNotePreview(content?: string) {
  return (content ?? "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function formatNoteDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
