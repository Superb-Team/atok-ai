import { useEffect, useState } from "react";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import type { Note } from "@/types/note.types";
import { Search, Settings, Share2, FileText, Star, Palette, Edit, Pin } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function HomePage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadNotes();
  }, []);

  const loadNotes = async () => {
    try {
      setError("");
      const user = authService.getUser();
      if (!user) {
        console.error("No user found");
        setError("User not authenticated");
        setLoading(false);
        return;
      }

      console.log("Loading notes for user:", user.id);
      const fetchedNotes = await noteService.getNotes(user.id);
      console.log("Notes loaded:", fetchedNotes);
      setNotes(fetchedNotes);
    } catch (err) {
      console.error("Failed to load notes:", err);
      setError(err instanceof Error ? err.message : "Failed to load notes");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleFavorite = async (noteId: number) => {
    try {
      const user = authService.getUser();
      if (!user) return;

      await noteService.toggleFavorite(noteId, user.id);
      await loadNotes();
    } catch (error) {
      console.error("Failed to toggle favorite:", error);
    }
  };

  const filteredNotes = notes.filter((note) =>
    note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    note.content?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-neutral-900">
        <p className="text-neutral-600 dark:text-neutral-400">Loading notes...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden">
      {/* Header with Search Bar */}
      <div className="p-6 border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900">
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-neutral-400 w-5 h-5" />
            <Input
              type="text"
              placeholder="Search notes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 w-full bg-gray-100 dark:bg-neutral-800 border-none"
            />
          </div>
          <button className="p-2 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg transition-colors">
            <Settings className="w-6 h-6 text-neutral-600 dark:text-neutral-400" />
          </button>
        </div>
      </div>

      {/* Notes Grid */}
      <div className="flex-1 overflow-y-auto p-8 bg-gray-50 dark:bg-neutral-900">
        <div className="max-w-7xl mx-auto">
          {error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          
          {filteredNotes.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-neutral-600 dark:text-neutral-400 text-lg">
                {searchQuery ? "No notes found" : "No notes yet. Click the + button to create one!"}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredNotes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  onToggleFavorite={handleToggleFavorite}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface NoteCardProps {
  note: Note;
  onToggleFavorite: (noteId: number) => void;
}

function NoteCard({ note, onToggleFavorite }: NoteCardProps) {
  const backgroundColor = note.color || "#E5E7EB";

  return (
    <div
      className="rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow relative group"
      style={{ backgroundColor }}
    >
      {/* Pin Icon */}
      <button
        onClick={() => onToggleFavorite(note.id)}
        className="absolute top-4 right-4 p-1.5 hover:bg-black/10 rounded-full transition-colors"
      >
        <Pin
          className={`w-5 h-5 ${
            note.is_favorite ? "fill-current text-neutral-700" : "text-neutral-600"
          }`}
        />
      </button>

      {/* Title */}
      <h3 className="text-2xl font-semibold text-neutral-800 mb-4 pr-8">
        {note.title}
      </h3>

      {/* Content Preview */}
      <div className="mb-6 min-h-[80px]">
        {note.content ? (
          <p className="text-neutral-700 line-clamp-3">{note.content}</p>
        ) : (
          <div className="space-y-2">
            <div className="h-2 bg-neutral-400/30 rounded-full w-full"></div>
            <div className="h-2 bg-neutral-400/30 rounded-full w-full"></div>
            <div className="h-2 bg-neutral-400/30 rounded-full w-3/4"></div>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-3 pt-4 border-t border-neutral-400/30">
        <button className="p-2 hover:bg-black/10 rounded-lg transition-colors">
          <Share2 className="w-5 h-5 text-neutral-700" />
        </button>
        <button className="p-2 hover:bg-black/10 rounded-lg transition-colors">
          <FileText className="w-5 h-5 text-neutral-700" />
        </button>
        <button
          onClick={() => onToggleFavorite(note.id)}
          className="p-2 hover:bg-black/10 rounded-lg transition-colors"
        >
          <Star
            className={`w-5 h-5 ${
              note.is_favorite ? "fill-current text-yellow-500" : "text-neutral-700"
            }`}
          />
        </button>
        <button className="p-2 hover:bg-black/10 rounded-lg transition-colors">
          <Palette className="w-5 h-5 text-neutral-700" />
        </button>
        <button className="p-2 hover:bg-black/10 rounded-lg transition-colors">
          <Edit className="w-5 h-5 text-neutral-700" />
        </button>
      </div>
    </div>
  );
}
