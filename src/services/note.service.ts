import { invoke } from "@tauri-apps/api/core";
import type { Note, CreateNoteRequest } from "@/types/note.types";

export const noteService = {
  async getNotes(userId: string): Promise<Note[]> {
    try {
      return await invoke<Note[]>("get_notes", { userId });
    } catch (error) {
      throw toError(error, "Failed to load notes");
    }
  },

  async getNote(noteId: number, userId: string): Promise<Note> {
    try {
      return await invoke<Note>("get_note", { noteId, userId });
    } catch (error) {
      throw toError(error, "Failed to load note");
    }
  },

  async createNote(userId: string, request: CreateNoteRequest): Promise<Note> {
    try {
      return await invoke<Note>("create_note", { userId, request });
    } catch (error) {
      throw toError(error, "Failed to create note");
    }
  },

  async updateNote(
    noteId: number,
    userId: string,
    changes: { title?: string; content?: string; tags?: string[]; color?: string },
  ): Promise<Note> {
    try {
      return await invoke<Note>("update_note", {
        userId,
        request: { id: noteId, ...changes },
      });
    } catch (error) {
      throw toError(error, "Failed to update note");
    }
  },

  async deleteNote(noteId: number, userId: string): Promise<{ message: string }> {
    try {
      return await invoke<{ message: string }>("delete_note", { noteId, userId });
    } catch (error) {
      throw toError(error, "Failed to delete note");
    }
  },

  async toggleFavorite(noteId: number, userId: string): Promise<Note> {
    try {
      return await invoke<Note>("toggle_favorite", { noteId, userId });
    } catch (error) {
      throw toError(error, "Failed to update note");
    }
  },
};

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error.trim()) return new Error(error);
  return new Error(fallback);
}
