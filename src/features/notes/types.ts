export interface Note {
  id: number;
  title: string;
  content?: string;
  tags?: string[];
  is_favorite: boolean;
  is_archived: boolean;
  color?: string;
  reminder_at?: string;
  recorded_at?: string;
  recording_timezone?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateNoteRequest {
  title: string;
  content?: string;
  tags?: string[];
  color?: string;
  recorded_at?: string;
  recording_timezone?: string;
}

export interface UpdateNoteRequest {
  title?: string;
  content?: string;
  tags?: string[];
  color?: string;
  expected_updated_at?: string;
}
