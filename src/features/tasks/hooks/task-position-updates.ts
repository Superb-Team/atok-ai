import { arrayMove } from "@dnd-kit/sortable";
import type { TaskPositionUpdate } from "../types.ts";

interface PositionTask {
  id: number;
}

interface PositionColumn {
  id: string;
  tasks: PositionTask[];
}

export function moveTaskAndBuildPositionUpdates<T extends PositionColumn>(
  columns: T[],
  columnId: string,
  activeIndex: number,
  overIndex: number,
): { columns: T[]; updates: TaskPositionUpdate[] } {
  const nextColumns = columns.map((column) =>
    column.id === columnId
      ? { ...column, tasks: arrayMove(column.tasks, activeIndex, overIndex) }
      : column,
  );
  return { columns: nextColumns, updates: buildTaskPositionUpdates(nextColumns) };
}

export function buildTaskPositionUpdates(columns: PositionColumn[]): TaskPositionUpdate[] {
  const updates: TaskPositionUpdate[] = [];
  columns.forEach((column) => {
    column.tasks.forEach((task, index) => {
      updates.push({ id: task.id, position: index, status: column.id });
    });
  });
  return updates;
}
