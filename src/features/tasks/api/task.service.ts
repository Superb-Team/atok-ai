import { invokeCommand } from "@/lib/ipc";
import type { Task, CreateTaskRequest, TaskPositionUpdate } from "@/features/tasks/types";

export const taskService = {
  async getTasks(userId: string): Promise<Task[]> {
    return await invokeCommand<Task[]>("get_tasks", { userId });
  },

  async createTask(userId: string, request: CreateTaskRequest): Promise<Task> {
    return await invokeCommand<Task>("create_task", { userId, request });
  },

  async toggleTaskCompletion(taskId: number, userId: string): Promise<Task> {
    return await invokeCommand<Task>("toggle_task_completion", { taskId, userId });
  },

  async updateTaskPositions(userId: string, updates: TaskPositionUpdate[]): Promise<{ message: string }> {
    return await invokeCommand<{ message: string }>("update_task_positions", { userId, updates });
  },

  async clearColumnTasks(userId: string, status: string): Promise<{ message: string }> {
    return await invokeCommand<{ message: string }>("clear_column_tasks", { userId, status });
  },
};
