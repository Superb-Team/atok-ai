import assert from "node:assert/strict";
import test from "node:test";
import { moveTaskAndBuildPositionUpdates } from "./task-position-updates.ts";
import type { Task } from "../types.ts";

function boardTask(id: number): { id: number; dbTask: Task } {
  const title = `Task ${id}`;
  return {
    id,
    dbTask: {
      id,
      title,
      status: "today",
      position: id,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

test("persists task positions from the reordered column state", () => {
  const columns = [
    {
      id: "today",
      title: "Today",
      color: "blue",
      tasks: [boardTask(1), boardTask(2), boardTask(3)],
    },
  ];

  const result = moveTaskAndBuildPositionUpdates(columns, "today", 0, 2);

  assert.deepEqual(result.columns[0].tasks.map((task) => task.id), [2, 3, 1]);
  assert.deepEqual(result.updates, [
    { id: 2, position: 0, status: "today" },
    { id: 3, position: 1, status: "today" },
    { id: 1, position: 2, status: "today" },
  ]);
  assert.deepEqual(columns[0].tasks.map((task) => task.id), [1, 2, 3]);
});
