import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecordingNoteContext,
  deriveRecordingNoteTitle,
  inferRecordingNoteContext,
  isUsefulGroundedTitle,
  replaceDocumentTitle,
} from "./recording-note-metadata.ts";

const transcript = "Rapat membahas progres Sales Engine dan Content Engine bersama Dendy dan Bintang.";
const context = {
  recordedAt: "2026-07-20T13:30:00.000Z",
  timezone: "Asia/Jakarta",
};

test("creates stable recording metadata at recording start", () => {
  const value = createRecordingNoteContext(new Date("2026-07-20T13:30:00.000Z"));

  assert.equal(value.recordedAt, "2026-07-20T13:30:00.000Z");
  assert.ok(value.timezone.length > 0);
});

test("recovers legacy recording time from the cross-platform filename", () => {
  assert.deepEqual(
    inferRecordingNoteContext("/tmp/recording-2026-07-20T13-30-00-123Z.mp3"),
    { recordedAt: "2026-07-20T13:30:00.123Z", timezone: "UTC" },
  );
});

test("rejects generic and placeholder titles", () => {
  assert.equal(isUsefulGroundedTitle("Progress Meeting – [Tanggal]", transcript), false);
  assert.equal(isUsefulGroundedTitle("Meeting Notes", transcript), false);
  assert.equal(isUsefulGroundedTitle("Evaluasi Sales dan Content Engine", transcript), true);
});

test("rejects conversational questions and sentence fragments as note titles", () => {
  const noisyTranscript = "Berapa sih dia mau atur untuk pakiran itu dari data yang masih sedikit. Lalu pembicaraan berlanjut.";

  assert.equal(
    isUsefulGroundedTitle("Berapa sih dia mau atur untuk pakiran itu dari data yang masih sedikit.", noisyTranscript),
    false,
  );
});

test("uses a grounded topic and appends the actual local recording date", () => {
  const title = deriveRecordingNoteTitle(
    "# Evaluasi Sales dan Content Engine\n\n## Ringkasan\nIsi.",
    transcript,
    "Recording - 20:30:00",
    context,
    "id",
  );

  assert.equal(title, "Evaluasi Sales dan Content Engine — 20 Juli 2026");
});

test("does not duplicate a date returned by the model", () => {
  const title = deriveRecordingNoteTitle(
    "# Evaluasi Sales dan Content Engine — 20 Juli 2026",
    transcript,
    "Recording",
    context,
    "id",
  );

  assert.equal(title, "Evaluasi Sales dan Content Engine — 20 Juli 2026");
});

test("uses a safe generic title when no AI title source is available", () => {
  const title = deriveRecordingNoteTitle(
    "",
    "Oh, gue putus-putus, Kak. Tes, halo.",
    "Recording - 22:04:00",
    context,
    "id",
  );

  assert.equal(title, "Catatan Rekaman — 20 Juli 2026");
});

test("replaces a model title so the stored title and document stay consistent", () => {
  assert.equal(
    replaceDocumentTitle("# Progress Meeting – [Tanggal]\n\n## Ringkasan\nIsi.", "Evaluasi Tim — 20 Juli 2026"),
    "# Evaluasi Tim — 20 Juli 2026\n\n## Ringkasan\nIsi.",
  );
});
