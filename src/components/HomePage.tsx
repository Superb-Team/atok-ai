import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import type { Note } from "@/types/note.types";
import { FileText, Loader2, Search, Star, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { installAsyncListener } from "@/services/recording-processing-guard";
import { shouldRecoverProcessingJob } from "@/services/processing-review-policy";
import { recordingProcessingErrorMessage } from "@/services/recording-error-message";
import { blockingQualityWarnings, requiresCaptureReview } from "@/services/recording-quality-policy";

function captureQualityGuidance(warnings: string[]): string {
  const guidance = new Set<string>();
  for (const warning of warnings) {
    if (warning.startsWith("mic_clipping:")) {
      guidance.add("Turunkan gain/input microphone dan pastikan level tidak menyentuh 0 dBFS.");
    }
    if (warning.startsWith("mic_missing:")) {
      guidance.add("Periksa permission dan device microphone; sebagian chunk tidak menerima sample mic.");
    }
    if (warning.startsWith("mic_overrun:")) {
      guidance.add("Sebagian sample mic jatuh karena buffer penuh; cek beban CPU, disk, dan proses berat saat merekam.");
    }
    if (warning.startsWith("mixed_clipping:")) {
      guidance.add("Turunkan volume sumber atau gain system audio agar output mix tidak clipping.");
    }
  }
  return guidance.size > 0
    ? [...guidance].join("\n")
    : "Periksa microphone dan jalur audio sebelum merekam ulang.";
}

interface HomePageProps {
  onNoteClick?: (noteId: number) => void;
}

export default function HomePage({ onNoteClick }: HomePageProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [processingNotes, setProcessingNotes] = useState<Set<string>>(new Set());
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null);
  const [recordingQualityNotice, setRecordingQualityNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [pendingFavorites, setPendingFavorites] = useState<Set<number>>(new Set());
  const loadRequestId = useRef(0);
  const seenRecordingHandoffs = useRef(new Set<string>());
  const activeAudioPaths = useRef(new Set<string>());

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

    let storageInterval: NodeJS.Timeout | undefined;

    // Shared between the event fast path and the localStorage poll so the same
    // take is never processed twice (both carry the handoff timestamp).
    const startProcessing = async (
      audioPath: string,
      noteTitle: string,
      language: string | undefined,
      timestamp: number,
      recordedAt?: string,
      timezone?: string,
      qualityWarnings: string[] = [],
      qualityRequiresReview = false,
    ): Promise<void> => {
      const handoffId = `${audioPath}:${timestamp}`;
      if (seenRecordingHandoffs.current.has(handoffId)) return;
      seenRecordingHandoffs.current.add(handoffId);
      localStorage.removeItem('audio_to_process');
      if (activeAudioPaths.current.has(audioPath)) return;
      activeAudioPaths.current.add(audioPath);
      const rawWarnings = Array.isArray(qualityWarnings)
        ? qualityWarnings.filter((warning): warning is string => typeof warning === 'string')
        : [];
      const warnings = blockingQualityWarnings(rawWarnings);
      if (requiresCaptureReview(qualityRequiresReview, rawWarnings)) {
        const details = warnings.length > 0
          ? warnings.join('\n')
          : 'Capture diagnostics require review.';
        setRecordingQualityNotice(
          `Rekaman tersimpan, tetapi sebagian capture perlu diverifikasi.\n\n${details}\n\n${captureQualityGuidance(warnings)}`,
        );
      }
      setProcessingNotes(prev => new Set(prev).add(noteTitle));
      await processAudioRecording(
        audioPath,
        noteTitle,
        language,
        recordedAt && timezone ? { recordedAt, timezone } : undefined,
      );
    };

    // Recovery is serialized so a pipeline upgrade cannot replay every old
    // recording at once and turn a provider hiccup into a request storm.
    let recoveryQueue = Promise.resolve();
    const enqueueRecovery = (job: () => Promise<void>) => {
      recoveryQueue = recoveryQueue
        .catch(() => {})
        .then(job)
        .catch(() => {});
    };

    // Fallback handoff: the poll covers ImportAudioDialog (which only writes
    // localStorage) and the case where the popup's event invoke failed.
    storageInterval = setInterval(() => {
      const audioData = localStorage.getItem('audio_to_process');
      if (audioData) {
        try {
          const {
            audioPath,
            noteTitle,
            language,
            timestamp,
            recordedAt,
            timezone,
            qualityWarnings,
            qualityRequiresReview,
          } = JSON.parse(audioData);
          startProcessing(
            audioPath,
            noteTitle,
            language,
            timestamp,
            recordedAt,
            timezone,
            qualityWarnings,
            qualityRequiresReview,
          );
        } catch {
          localStorage.removeItem('audio_to_process');
        }
      }
    }, 500);

    const cleanupRecordingListener = installAsyncListener<any>(
      async (handler) => {
        const { listen } = await import('@tauri-apps/api/event');
        return listen('recording-started', handler);
      },
      (event) => {
        const {
          noteTitle,
          audioPath,
          language,
          timestamp,
          recordedAt,
          timezone,
          qualityWarnings,
          qualityRequiresReview,
        } = event.payload ?? {};
        if (noteTitle && audioPath && typeof timestamp === 'number') {
          startProcessing(
            audioPath,
            noteTitle,
            language ?? undefined,
            timestamp,
            recordedAt,
            timezone,
            qualityWarnings,
            qualityRequiresReview,
          );
        } else if (noteTitle) {
          setProcessingNotes(prev => new Set(prev).add(noteTitle));
        }
      },
    );

    // Manifest-backed recovery: a crash or app restart no longer loses a job
    // after the localStorage handoff has already been consumed.
    import('@/services/recording.service').then(({ recordingService }) =>
      recordingService.listProcessingJobs().then((jobs) => {
        jobs
          .filter((job) => shouldRecoverProcessingJob(
            job.status,
            job.fallbackVersion,
            job.repairingFallback,
            job.enhancementMode,
            job.aiPipelineVersion,
            job.upgradingAi,
            job.transcriptionPipelineVersion,
            job.transcript !== undefined,
          ))
          .forEach((job) => {
            const timestamp = Date.parse(job.updatedAt) || Date.now();
            enqueueRecovery(() => startProcessing(
              job.audioPath,
              job.noteTitle,
              job.language,
              timestamp,
              job.recordedAt,
              job.timezone,
            ));
          });
      }).catch(() => {}),
    );

    return () => {
      if (storageInterval) clearInterval(storageInterval);
      cleanupRecordingListener();
    };
  }, [loadNotes]);

  const processAudioRecording = async (
    audioPath: string,
    noteTitle: string,
    language?: string,
    context?: { recordedAt: string; timezone: string },
  ) => {
    try {
      const { processAudioRecording: processAudio } = await import('@/services/audio-processor.service');
      const result = await processAudio(audioPath, noteTitle, language, context);

      if (!result.success) {
        throw new Error(result.error || 'Processing failed');
      }
      if (result.outcome === "no_speech") {
        setRecordingNotice(
          result.message ??
            "The recording was saved, but no speech was detected. Check the selected microphone and try again.",
        );
      }

      setProcessingNotes(prev => {
        const next = new Set(prev);
        next.delete(noteTitle);
        return next;
      });
      activeAudioPaths.current.delete(audioPath);

      await loadNotes();
    } catch (err) {
      console.error("Recording processing failed:", err);
      const errorMessage = recordingProcessingErrorMessage(err);
      setAlertMessage(`Recording processing failed:\n${errorMessage}`);

      setProcessingNotes(prev => {
        const next = new Set(prev);
        next.delete(noteTitle);
        return next;
      });
      activeAudioPaths.current.delete(audioPath);
    }
  };

  const handleToggleFavorite = async (noteId: number) => {
    setPendingFavorites((prev) => new Set(prev).add(noteId));
    try {
      const user = authService.getUser();
      if (!user) return;

      await noteService.toggleFavorite(noteId, user.id);
      await loadNotes();
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
    } finally {
      setPendingFavorites((prev) => {
        const next = new Set(prev);
        next.delete(noteId);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen flex-1 flex-col overflow-hidden bg-background">
        <div className="flex-1 overflow-y-auto px-10 pb-10 pt-9">
          <div className="mx-auto max-w-7xl">
            <div className="h-10 w-44 animate-pulse rounded-lg bg-muted" />
            <div className="mt-2 h-4 w-64 animate-pulse rounded-md bg-muted/70" />
            <div className="mt-8 h-11 animate-pulse rounded-lg bg-muted/70" />
            <div className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonNoteCard key={i} />
              ))}
            </div>
          </div>
        </div>
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
      <ConfirmDialog
        open={recordingNotice !== null}
        onOpenChange={(open) => {
          if (!open) setRecordingNotice(null);
        }}
        title="No speech detected"
        description={recordingNotice ?? ""}
        confirmText="OK"
        mode="alert"
        variant="default"
      />
      <ConfirmDialog
        open={recordingQualityNotice !== null}
        onOpenChange={(open) => {
          if (!open) setRecordingQualityNotice(null);
        }}
        title="Audio quality needs review"
        description={recordingQualityNotice ?? ""}
        confirmText="OK"
        mode="alert"
        variant="default"
      />
      <div className="flex h-screen flex-1 flex-col overflow-hidden bg-background">
        <div className="flex-1 overflow-y-auto px-10 pb-16 pt-9">
          <div className="mx-auto max-w-7xl">
            <header className="flex items-end justify-between gap-6">
              <div>
                <h1 className="font-display text-[2rem] font-semibold leading-tight tracking-tight text-foreground">
                  Notes
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Everything you have written and recorded, in one place.
                </p>
              </div>
              <p className="hidden shrink-0 pb-1 font-mono text-xs text-muted-foreground sm:block">
                {filteredNotes.length} of {notes.filter((n) => !n.is_archived).length} notes
              </p>
            </header>

            {error && (
              <div className="mt-6 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="mt-7 flex flex-col gap-3 border-b border-border pb-5 md:flex-row md:items-center">
              <div className="flex h-10 flex-1 items-center gap-2.5 rounded-lg border border-input bg-card px-3.5 transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search title, content, or tag"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="shrink-0 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFavoriteOnly((value) => !value)}
                  aria-pressed={favoriteOnly}
                  className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition-colors active:scale-[0.98] ${
                    favoriteOnly
                      ? "border-primary/35 bg-primary/10 text-primary"
                      : "border-input bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <Star
                    className={`h-4 w-4 ${favoriteOnly ? "fill-current" : ""}`}
                    strokeWidth={1.75}
                  />
                  Favorites
                </button>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            <div className="mt-7">
              {notes.length === 0 && processingNotes.size === 0 ? (
                <EmptyState
                  title="No notes yet"
                  description="Create your first note, or record audio and let the transcript become one."
                />
              ) : filteredNotes.length === 0 && processingNotes.size === 0 ? (
                <EmptyState
                  title="Nothing matches"
                  description="Try another keyword, or reset the active filters."
                  actionLabel="Reset filters"
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
                      favoritePending={pendingFavorites.has(note.id)}
                      onClick={() => onNoteClick?.(note.id)}
                    />
                  ))}
                </div>
              )}
            </div>
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
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-24 text-center">
      <div className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10">
        <FileText className="h-6 w-6 text-primary" strokeWidth={1.5} />
      </div>
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      <p className="mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-6 rounded-lg border border-input bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent active:scale-[0.98]"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function SkeletonNoteCard() {
  return (
    <div className="min-h-[230px] animate-pulse rounded-xl border border-border bg-card p-5">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2.5">
          <div className="h-5 w-3/4 rounded-md bg-muted" />
          <div className="h-3 w-1/3 rounded-md bg-muted/70" />
        </div>
        <div className="h-8 w-8 rounded-lg bg-muted/70" />
      </div>
      <div className="space-y-2">
        <div className="h-2.5 rounded-full bg-muted/70" />
        <div className="h-2.5 w-5/6 rounded-full bg-muted/70" />
        <div className="h-2.5 w-2/3 rounded-full bg-muted/70" />
      </div>
    </div>
  );
}

function LoadingNoteCard({ title }: { title: string }) {
  return (
    <div className="flex min-h-[230px] flex-col rounded-xl border border-primary/25 bg-card p-5">
      <div className="mb-4">
        <p className="font-mono text-[11px] uppercase tracking-widest text-primary">
          Transcribing
        </p>
        <h3 className="mt-2 line-clamp-2 font-display text-[17px] font-semibold leading-snug text-foreground">
          {title}
        </h3>
      </div>
      <div className="animate-pulse space-y-2">
        <div className="h-2 rounded-full bg-muted" />
        <div className="h-2 w-5/6 rounded-full bg-muted" />
        <div className="h-2 w-2/3 rounded-full bg-muted" />
      </div>
      <div className="mt-auto flex items-center gap-2.5 pt-6 text-sm text-muted-foreground">
        <div className="flex space-x-1">
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
        </div>
        Writing the note
      </div>
    </div>
  );
}

interface NoteCardProps {
  note: Note;
  onToggleFavorite: (noteId: number) => void;
  favoritePending?: boolean;
  onClick?: () => void;
}

function NoteCard({ note, onToggleFavorite, favoritePending, onClick }: NoteCardProps) {
  const tags = note.tags ?? [];
  const preview = cleanNotePreview(note.content);

  return (
    <article
      onClick={onClick}
      className="group relative flex min-h-[230px] cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card p-5 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-ring/35 hover:shadow-md"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground/80">
            {note.color && (
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15"
                style={{ backgroundColor: note.color }}
              />
            )}
            {formatNoteDate(note.updated_at)}
          </div>
          <h3 className="mt-2 line-clamp-2 font-display text-[17px] font-semibold leading-snug text-foreground">
            {note.title}
          </h3>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!favoritePending) onToggleFavorite(note.id);
          }}
          disabled={favoritePending}
          className={`rounded-lg p-2 transition-colors disabled:cursor-wait ${
            note.is_favorite
              ? "text-primary"
              : "text-muted-foreground/40 opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          }`}
          aria-label={note.is_favorite ? "Remove from favorites" : "Add to favorites"}
        >
          {favoritePending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Star
              className={`h-4 w-4 ${note.is_favorite ? "fill-current" : ""}`}
              strokeWidth={1.75}
            />
          )}
        </button>
      </div>

      <p className="line-clamp-4 flex-1 text-sm leading-6 text-muted-foreground">
        {preview || "No content yet."}
      </p>

      {tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-3.5">
          {tags.slice(0, 3).map((tag) => (
            <span key={tag} className="font-mono text-[11px] text-muted-foreground/80">
              #{tag}
            </span>
          ))}
          {tags.length > 3 && (
            <span className="font-mono text-[11px] text-muted-foreground/50">
              +{tags.length - 3}
            </span>
          )}
        </div>
      )}
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
  const date = new Date(value);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}
