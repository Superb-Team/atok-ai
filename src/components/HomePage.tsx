import { useEffect, useState } from "react";
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

  useEffect(() => {
    console.log('🏠 HomePage mounted, setting up listeners...');
    loadNotes();
    
    // Listen for recording events via multiple methods
    let unlisten1: (() => void) | undefined;
    let unlisten2: (() => void) | undefined;
    let storageInterval: NodeJS.Timeout | undefined;
    
    // Method 1: localStorage polling (most reliable)
    let lastRecordingCheck = 0;
    let lastNoteCheck = 0;
    
    storageInterval = setInterval(() => {
      // Check for audio to process
      const audioData = localStorage.getItem('audio_to_process');
      if (audioData) {
        try {
          const { audioPath, noteTitle, timestamp } = JSON.parse(audioData);
          if (timestamp > lastRecordingCheck) {
            console.log('🎉 Audio to process detected!');
            console.log('📁 Audio path:', audioPath);
            console.log('📝 Note title:', noteTitle);
            lastRecordingCheck = timestamp;
            
            // Show loading note
            setProcessingNotes(prev => {
              const newSet = new Set(prev).add(noteTitle);
              console.log('📋 Processing notes:', Array.from(newSet));
              return newSet;
            });
            
            // Clear the flag immediately
            localStorage.removeItem('audio_to_process');
            
            // Process audio in main window
            processAudioRecording(audioPath, noteTitle);
          }
        } catch (e) {
          console.error('Error parsing audio_to_process:', e);
        }
      }
      
      // Check for recording started (legacy)
      const recordingData = localStorage.getItem('recording_started');
      if (recordingData) {
        try {
          const { noteTitle, timestamp } = JSON.parse(recordingData);
          if (timestamp > lastRecordingCheck) {
            console.log('🎉 Recording started detected via localStorage!');
            console.log('📝 Note title:', noteTitle);
            lastRecordingCheck = timestamp;
            setProcessingNotes(prev => {
              const newSet = new Set(prev).add(noteTitle);
              console.log('📋 Processing notes:', Array.from(newSet));
              return newSet;
            });
            // Clear the flag
            localStorage.removeItem('recording_started');
          }
        } catch (e) {
          console.error('Error parsing recording_started:', e);
        }
      }
      
      // Check for note created
      const noteCreatedData = localStorage.getItem('note_created');
      if (noteCreatedData) {
        try {
          const { noteTitle, timestamp } = JSON.parse(noteCreatedData);
          if (timestamp > lastNoteCheck) {
            console.log('🎉 Note created detected via localStorage!');
            console.log('📝 Note title:', noteTitle);
            lastNoteCheck = timestamp;
            setProcessingNotes(prev => {
              const newSet = new Set(prev);
              newSet.delete(noteTitle);
              console.log('📋 Processing notes after removal:', Array.from(newSet));
              return newSet;
            });
            // Refresh notes list
            console.log('🔄 Refreshing notes list...');
            loadNotes();
            // Clear the flag
            localStorage.removeItem('note_created');
          }
        } catch (e) {
          console.error('Error parsing note_created:', e);
        }
      }
    }, 500); // Check every 500ms
    
    // Method 2: Tauri events (backup)
    const setupTauriListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        
        unlisten1 = await listen('recording-started', (event: any) => {
          console.log('🎉 Recording started event received via Tauri!');
          const noteTitle = event.payload?.noteTitle;
          if (noteTitle) {
            setProcessingNotes(prev => new Set(prev).add(noteTitle));
          }
        });
        
        unlisten2 = await listen('note-created', (event: any) => {
          console.log('🎉 Note created event received via Tauri!');
          const noteTitle = event.payload?.noteTitle;
          if (noteTitle) {
            setProcessingNotes(prev => {
              const newSet = new Set(prev);
              newSet.delete(noteTitle);
              return newSet;
            });
            loadNotes();
          }
        });
        
        console.log('✅ Tauri event listeners registered');
      } catch (error) {
        console.error('❌ Error setting up Tauri listeners:', error);
      }
    };
    
    setupTauriListeners();
    
    return () => {
      console.log('🧹 HomePage unmounting, cleaning up...');
      if (storageInterval) clearInterval(storageInterval);
      unlisten1?.();
      unlisten2?.();
    };
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

  const processAudioRecording = async (audioPath: string, noteTitle: string) => {
    console.log('🎙️ Starting audio processing in main window...');
    console.log('📁 Audio path:', audioPath);
    console.log('📝 Note title:', noteTitle);

    try {
      // Step 1: Read audio file
      console.log('📖 Step 1: Reading audio file...');
      const { invoke } = await import('@tauri-apps/api/core');
      const base64Data = await invoke<string>('read_audio_file', { path: audioPath });
      console.log('✅ Audio file read, size:', base64Data.length);

      // Convert base64 to blob
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
      const audioFile = new File([audioBlob], 'recording.mp3', { type: 'audio/mpeg' });
      console.log('✅ Audio file created:', audioFile.size, 'bytes');

      if (audioFile.size === 0) {
        throw new Error('Audio file is empty (0 bytes)');
      }

      // Step 2: Transcribe and enhance
      console.log('🤖 Step 2: Transcribing and enhancing...');
      const { agentService } = await import('@/services/agent.service');
      const enhancedText = await agentService.transcribeAndEnhance(audioFile, 'voice recording');
      console.log('✅ Transcription completed, length:', enhancedText.length);

      // Step 3: Get user info
      console.log('👤 Step 3: Getting user info...');
      const user = authService.getUser();
      if (!user) {
        throw new Error('User not authenticated');
      }
      console.log('✅ User:', user.id);

      // Step 4: Save to notes
      console.log('📝 Step 4: Saving to notes...');
      const newNote = {
        title: noteTitle,
        content: enhancedText,
        tags: ['voice-recording', 'transcription'],
        color: '#E0F2FE',
        is_favorite: false,
      };
      await noteService.createNote(user.id, newNote);
      console.log('✅ Note created successfully in database');

      // Step 5: Insert to OpenSearch RAG
      console.log('🔍 Step 5: Inserting to RAG...');
      const now = new Date();
      const currentDate = now.toISOString().split('T')[0];
      await agentService.insertDocument(user.id, enhancedText, {
        type: 'voice_recording',
        date: currentDate,
        timestamp: now.toISOString(),
        source: 'audio_transcription',
      });
      console.log('✅ Document inserted to RAG');

      // Success - update UI
      console.log('🎉 Workflow completed successfully!');
      setProcessingNotes(prev => {
        const newSet = new Set(prev);
        newSet.delete(noteTitle);
        return newSet;
      });
      
      // Refresh notes list
      await loadNotes();
      
    } catch (error) {
      console.error('❌ Failed to process recording:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      alert(`Recording processing failed:\n${errorMessage}`);
      
      // Remove loading note
      setProcessingNotes(prev => {
        const newSet = new Set(prev);
        newSet.delete(noteTitle);
        return newSet;
      });
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

  const filteredNotes = notes;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-neutral-900">
        <p className="text-neutral-600 dark:text-neutral-400">Loading notes...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-900 dark:to-neutral-950">
      {/* Header */}
      <div className="px-8 py-6 border-b border-neutral-200/50 dark:border-neutral-700/50 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold text-neutral-900 dark:text-white">
            My Notes
          </h1>
        </div>
      </div>

      {/* Notes Grid */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-7xl mx-auto">
          {error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          
          {filteredNotes.length === 0 && processingNotes.size === 0 ? (
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
              {/* Processing notes (loading state) */}
              {Array.from(processingNotes).map((noteTitle) => (
                <LoadingNoteCard key={noteTitle} title={noteTitle} />
              ))}
              
              {/* Actual notes */}
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
  );
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
      style={{ 
        backgroundColor,
        color: isDark ? "#1F2937" : undefined
      }}
    >
      {/* Favorite Star */}
      {note.is_favorite && (
        <div className="absolute top-3 right-3">
          <Star className="w-4 h-4 fill-current text-yellow-500" />
        </div>
      )}

      {/* Title */}
      <h3 className="text-lg font-semibold mb-3 pr-6 line-clamp-2" style={{ color: isDark ? "#1F2937" : undefined }}>
        {note.title}
      </h3>

      {/* Content Preview */}
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

      {/* Tags */}
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

      {/* Footer */}
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
            className={`w-4 h-4 ${
              note.is_favorite ? "fill-current text-yellow-500" : ""
            }`}
            style={{ color: isDark && !note.is_favorite ? "#4B5563" : undefined }}
          />
        </button>
      </div>
    </div>
  );
}
