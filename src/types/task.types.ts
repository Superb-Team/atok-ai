export interface Task {
  id: number;
  title: string;
  description?: string;
  status: 'backlog' | 'this_week' | 'today' | 'done';
  priority?: string;
  duration_minutes?: number;
  tags?: string[];
  due_date?: string;
  completed_at?: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  status: string;
  priority?: string;
  duration_minutes?: number;
  tags?: string[];
  due_date?: string;
}

export interface UpdateTaskRequest {
  id: number;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  duration_minutes?: number;
  tags?: string[];
  due_date?: string;
  position?: number;
}

export interface TaskPositionUpdate {
  id: number;
  position: number;
  status: string;
}
