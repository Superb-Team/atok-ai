import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveNoteImprovementRoute,
  selectRecordingJobForNote,
} from "./recording-job-selection.ts";

test("selects the newest canonical recording source for a note", () => {
  const jobs = [
    { savedNoteId: 7, transcript: "versi lama", updatedAt: "2026-08-20T10:00:00Z", audioPath: "old.mp3" },
    { savedNoteId: 7, transcript: "versi baru", updatedAt: "2026-08-21T10:00:00Z", audioPath: "new.mp3" },
    { savedNoteId: 8, transcript: "catatan lain", updatedAt: "2026-08-22T10:00:00Z", audioPath: "other.mp3" },
  ];

  assert.equal(selectRecordingJobForNote(jobs, 7)?.audioPath, "new.mp3");
});

test("does not route a note without a canonical transcript into recording regeneration", () => {
  const jobs = [
    { savedNoteId: 7, transcript: "", updatedAt: "2026-08-21T10:00:00Z" },
    { savedNoteId: 7, updatedAt: "2026-08-22T10:00:00Z" },
  ];

  assert.equal(selectRecordingJobForNote(jobs, 7), undefined);
});

test("never sends a recording note without canonical transcript to the note formatter", () => {
  assert.deepEqual(resolveNoteImprovementRoute([], 7, true), {
    kind: "missing_recording_source",
  });
});

test("allows note-only formatting for an ordinary note", () => {
  assert.deepEqual(resolveNoteImprovementRoute([], 7, false), { kind: "note" });
});
