import { useEffect, useState } from "react";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import type { Note } from "@/types/note.types";
import { ArrowLeft, Star, Trash2, Edit, Calendar, Tag, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NoteViewPageProps {
  noteId: number;
  onBack: () => void;
  onEdit?: (note: Note) => void;
}

export default function NoteViewPage({ noteId, onBack, onEdit }: NoteViewPageProps) {
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
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

  const handleDelete = async () => {
    if (!note) return;
    
    if (!confirm("Are you sure you want to delete this note?")) {
      return;
    }

    try {
      const user = authService.getUser();
      if (!user) return;

      await noteService.deleteNote(note.id, user.id);
      onBack();
    } catch (error) {
      console.error("Failed to delete note:", error);
      setError("Failed to delete note");
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-neutral-900">
        <p className="text-neutral-600 dark:text-neutral-400">Loading note...</p>
      </div>
    );
  }

  if (error || !note) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-white dark:bg-neutral-900">
        <p className="text-red-600 dark:text-red-400 mb-4">{error || "Note not found"}</p>
        <Button onClick={onBack} variant="outline">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Go Back
        </Button>
      </div>
    );
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden bg-white dark:bg-neutral-900">
      {/* Header */}
      <div className="border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <Button
              onClick={onBack}
              variant="ghost"
              size="sm"
              className="text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Notes
            </Button>

            <div className="flex items-center gap-2">
              <Button
                onClick={handleToggleFavorite}
                variant="ghost"
                size="sm"
                className={note.is_favorite ? "text-yellow-500" : "text-neutral-600 dark:text-neutral-400"}
              >
                <Star className={`w-4 h-4 ${note.is_favorite ? "fill-current" : ""}`} />
              </Button>
              
              {onEdit && (
                <Button
                  onClick={() => onEdit(note)}
                  variant="ghost"
                  size="sm"
                  className="text-neutral-600 dark:text-neutral-400"
                >
                  <Edit className="w-4 h-4" />
                </Button>
              )}

              <Button
                onClick={handleDelete}
                variant="ghost"
                size="sm"
                className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* Color Badge */}
          {note.color && (
            <div className="flex items-center gap-2 mb-4">
              <Palette className="w-4 h-4 text-neutral-500 dark:text-neutral-400" />
              <div
                className="w-6 h-6 rounded-full border-2 border-neutral-300 dark:border-neutral-600"
                style={{ backgroundColor: note.color }}
              />
            </div>
          )}

          {/* Title */}
          <h1 className="text-4xl font-bold text-neutral-900 dark:text-white mb-6">
            {note.title}
          </h1>

          {/* Metadata */}
          <div className="flex flex-wrap items-center gap-4 mb-8 text-sm text-neutral-600 dark:text-neutral-400">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              <span>Created {formatDate(note.created_at)}</span>
            </div>
            
            {note.updated_at !== note.created_at && (
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                <span>Updated {formatDate(note.updated_at)}</span>
              </div>
            )}
          </div>

          {/* Tags */}
          {note.tags && note.tags.length > 0 && (
            <div className="flex items-center gap-2 mb-8">
              <Tag className="w-4 h-4 text-neutral-500 dark:text-neutral-400" />
              <div className="flex flex-wrap gap-2">
                {note.tags.map((tag, index) => (
                  <span
                    key={index}
                    className="px-3 py-1 bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 rounded-full text-sm"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Content */}
          <div className="prose prose-neutral dark:prose-invert max-w-none">
            {note.content ? (
              <div className="text-neutral-700 dark:text-neutral-300 text-lg leading-relaxed whitespace-pre-wrap">
                {note.content}
              </div>
            ) : (
              <p className="text-neutral-500 dark:text-neutral-400 italic">
                No content
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
