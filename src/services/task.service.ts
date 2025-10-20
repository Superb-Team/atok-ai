import { invoke } from "@tauri-apps/api/core";
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskPositionUpdate } from "@/types/task.types";

export const taskService = {
  async getTasks(userId: string): Promise<Task[]> {
    return await invoke<Task[]>("get_tasks", { userId });
  },

  async createTask(userId: string, request: CreateTaskRequest): Promise<Task> {
    return await invoke<Task>("create_task", { userId, request });
  },

  async updateTask(userId: string, request: UpdateTaskRequest): Promise<Task> {
    return await invoke<Task>("update_task", { userId, request });
  },

  async deleteTask(taskId: number, userId: string): Promise<{ message: string }> {
    return await invoke<{ message: string }>("delete_task", { taskId, userId });
  },

  async toggleTaskCompletion(taskId: number, userId: string): Promise<Task> {
    return await invoke<Task>("toggle_task_completion", { taskId, userId });
  },

  async updateTaskPositions(userId: string, updates: TaskPositionUpdate[]): Promise<{ message: string }> {
    return await invoke<{ message: string }>("update_task_positions", { userId, updates });
  },

  async clearColumnTasks(userId: string, status: string): Promise<{ message: string }> {
    return await invoke<{ message: string }>("clear_column_tasks", { userId, status });
  },
};
