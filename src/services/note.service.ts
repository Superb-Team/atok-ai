import { invoke } from "@tauri-apps/api/core";
import type { Note, CreateNoteRequest, UpdateNoteRequest } from "@/types/note.types";

export const noteService = {
  async getNotes(userId: string): Promise<Note[]> {
    return await invoke<Note[]>("get_notes", { userId });
  },

  async getNote(noteId: number, userId: string): Promise<Note> {
    return await invoke<Note>("get_note", { noteId, userId });
  },

  async createNote(userId: string, request: CreateNoteRequest): Promise<Note> {
    return await invoke<Note>("create_note", { userId, request });
  },

  async updateNote(userId: string, request: UpdateNoteRequest): Promise<Note> {
    return await invoke<Note>("update_note", { userId, request });
  },

  async deleteNote(noteId: number, userId: string): Promise<{ message: string }> {
    return await invoke<{ message: string }>("delete_note", { noteId, userId });
  },

  async toggleFavorite(noteId: number, userId: string): Promise<Note> {
    return await invoke<Note>("toggle_favorite", { noteId, userId });
  },
};
