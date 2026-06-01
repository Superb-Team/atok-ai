import { useCallback, useEffect, useRef, useState } from "react";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import type { Note } from "@/types/note.types";
import { FileText, Star } from "lucide-react";

interface HomePageProps {
  onNoteClick?: (noteId: number) => void;
}

export default function HomePage({ onNoteClick }: HomePageProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [processingNotes, setProcessingNotes] = useState<Set<string>>(new Set());
  const loadRequestId = useRef(0);

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
    let unlisten2: (() => void) | undefined;
    let storageInterval: NodeJS.Timeout | undefined;

    let lastRecordingCheck = 0;
    let lastNoteCheck = 0;

    storageInterval = setInterval(() => {
      const audioData = localStorage.getItem('audio_to_process');
      if (audioData) {
        try {
          const { audioPath, noteTitle, timestamp } = JSON.parse(audioData);
          if (timestamp > lastRecordingCheck) {
            lastRecordingCheck = timestamp;
            setProcessingNotes(prev => new Set(prev).add(noteTitle));
            localStorage.removeItem('audio_to_process');
            processAudioRecording(audioPath, noteTitle);
          }
        } catch {
          localStorage.removeItem('audio_to_process');
        }
      }

      const recordingData = localStorage.getItem('recording_started');
      if (recordingData) {
        try {
          const { noteTitle, timestamp } = JSON.parse(recordingData);
          if (timestamp > lastRecordingCheck) {
            lastRecordingCheck = timestamp;
            setProcessingNotes(prev => new Set(prev).add(noteTitle));
            localStorage.removeItem('recording_started');
          }
        } catch {
          localStorage.removeItem('recording_started');
        }
      }

      const noteCreatedData = localStorage.getItem('note_created');
      if (noteCreatedData) {
        try {
          const { noteTitle, timestamp } = JSON.parse(noteCreatedData);
          if (timestamp > lastNoteCheck) {
            lastNoteCheck = timestamp;
            setProcessingNotes(prev => {
              const next = new Set(prev);
              next.delete(noteTitle);
              return next;
            });
            loadNotes();
            localStorage.removeItem('note_created');
          }
        } catch {
          localStorage.removeItem('note_created');
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

        unlisten2 = await listen('note-created', (event: any) => {
          const noteTitle = event.payload?.noteTitle;
          if (noteTitle) {
            setProcessingNotes(prev => {
              const next = new Set(prev);
              next.delete(noteTitle);
              return next;
            });
            loadNotes();
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
      unlisten2?.();
    };
  }, [loadNotes]);

  const processAudioRecording = async (audioPath: string, noteTitle: string) => {
    try {
      const { processAudioRecording: processAudio } = await import('@/services/audio-processor.service');
      const result = await processAudio(audioPath, noteTitle);

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
      alert(`Recording processing failed:\n${errorMessage}`);

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
    <div className="flex-1 flex flex-col h-screen overflow-hidden bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-900 dark:to-neutral-950">
      <div className="px-8 py-6 border-b border-neutral-200/50 dark:border-neutral-700/50 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold text-neutral-900 dark:text-white">
            My Notes
          </h1>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-7xl mx-auto">
          {error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          {notes.length === 0 && processingNotes.size === 0 ? (
            <div className="text-center py-20">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-neutral-200 dark:bg-neutral-800 mb-4">
                <FileText className="w-8 h-8 text-neutral-400 dark:text-neutral-500" />
              </div>
              <p className="text-neutral-600 dark:text-neutral-400 text-lg font-medium">
                No notes yet
              </p>
              <p className="text-neutral-500 dark:text-neutral-500 text-sm mt-2">
                Click the + button to create your first note!
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
              {Array.from(processingNotes).map((noteTitle) => (
                <LoadingNoteCard key={noteTitle} title={noteTitle} />
              ))}

              {notes.map((note) => (
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
  );
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function LoadingNoteCard({ title }: { title: string }) {
  return (
    <div className="rounded-xl p-5 shadow-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 animate-pulse">
      <h3 className="text-lg font-semibold mb-3 text-neutral-900 dark:text-white">
        {title}
      </h3>
      <div className="mb-4 min-h-[60px] space-y-2">
        <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
          <div className="flex space-x-1">
            <div className="w-2 h-2 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
            <div className="w-2 h-2 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
            <div className="w-2 h-2 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce"></div>
          </div>
          <span className="text-sm">Generating notes...</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        <span className="px-2 py-0.5 bg-neutral-200 dark:bg-neutral-700 rounded text-xs text-neutral-600 dark:text-neutral-400">
          voice-recording
        </span>
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
  const backgroundColor = note.color || "#FFFFFF";
  const isDark = note.color && note.color !== "#FFFFFF";

  return (
    <div
      onClick={onClick}
      className="rounded-xl p-5 shadow-sm hover:shadow-lg transition-all duration-200 relative group cursor-pointer border border-neutral-200 dark:border-neutral-700 hover:scale-[1.02]"
      style={{ backgroundColor, color: isDark ? "#1F2937" : undefined }}
    >
      {note.is_favorite && (
        <div className="absolute top-3 right-3">
          <Star className="w-4 h-4 fill-current text-yellow-500" />
        </div>
      )}

      <h3 className="text-lg font-semibold mb-3 pr-6 line-clamp-2" style={{ color: isDark ? "#1F2937" : undefined }}>
        {note.title}
      </h3>

      <div className="mb-4 min-h-[60px]">
        {note.content ? (
          <p className="text-sm line-clamp-3 opacity-80" style={{ color: isDark ? "#374151" : undefined }}>
            {note.content}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="h-2 bg-neutral-300/40 dark:bg-neutral-600/40 rounded-full w-full"></div>
            <div className="h-2 bg-neutral-300/40 dark:bg-neutral-600/40 rounded-full w-5/6"></div>
          </div>
        )}
      </div>

      {note.tags && note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {note.tags.slice(0, 2).map((tag, index) => (
            <span
              key={index}
              className="px-2 py-0.5 bg-neutral-200/60 dark:bg-neutral-700/60 rounded text-xs"
              style={{ color: isDark ? "#4B5563" : undefined }}
            >
              {tag}
            </span>
          ))}
          {note.tags.length > 2 && (
            <span className="px-2 py-0.5 text-xs opacity-60">
              +{note.tags.length - 2}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-3 border-t border-neutral-300/40 dark:border-neutral-600/40">
        <span className="text-xs opacity-60">
          {new Date(note.updated_at).toLocaleDateString()}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(note.id);
          }}
          className="p-1.5 hover:bg-black/10 dark:hover:bg-white/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
        >
          <Star
            className={`w-4 h-4 ${note.is_favorite ? "fill-current text-yellow-500" : ""}`}
            style={{ color: isDark && !note.is_favorite ? "#4B5563" : undefined }}
          />
        </button>
      </div>
    </div>
  );
}
