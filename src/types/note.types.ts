export interface Note {
  id: number;
  title: string;
  content?: string;
  tags?: string[];
  is_favorite: boolean;
  is_archived: boolean;
  color?: string;
  reminder_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateNoteRequest {
  title: string;
  content?: string;
  tags?: string[];
  color?: string;
}

export interface UpdateNoteRequest {
  id: number;
  title?: string;
  content?: string;
  tags?: string[];
  is_favorite?: boolean;
  is_archived?: boolean;
  color?: string;
}
