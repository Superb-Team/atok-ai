import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecordingNoteContext,
  deriveRecordingNoteTitle,
  inferRecordingNoteContext,
  isUsefulGroundedTitle,
  replaceDocumentTitle,
  readDocumentTitle,
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
  assert.equal(
    isUsefulGroundedTitle(
      "Format Data Segmen Kabel: GeoJSON standar dengan koordinat A-B mencakup",
      "Format data segmen kabel menggunakan GeoJSON standar dengan koordinat A-B.",
    ),
    false,
  );
  assert.equal(isUsefulGroundedTitle("Pembahasan Sales", transcript), false);
  assert.equal(isUsefulGroundedTitle("Evaluasi Sales dan Content Engine", transcript), true);
});

test("rejects a body sentence that happens to share words with the transcript", () => {
  const noisyTranscript = "Rapat membahas progres sales. Tidak ada keputusan untuk bagian ini.";

  assert.equal(
    isUsefulGroundedTitle(
      "Ringkasan otomatis tidak tersedia untuk rekaman ini. Catatan lengkap per bagian ada di bawah.",
      noisyTranscript,
    ),
    false,
  );
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

test("does not turn a section sub-heading into the note title", () => {
  const note = [
    "## Pembahasan Terperinci",
    "",
    "### Pertanyaan Pertama: Pendekatan Masuk ke Proyek yang Sudah Berjalan",
    "",
    "- Koordinasi dulu dengan tim programmer untuk minta arahan.",
  ].join("\n");
  const interview =
    "Ketika kamu masuk ke sebuah proyek yang sudah berjalan, apa pendekatan pertama untuk koordinasi dengan tim programmer.";

  assert.equal(
    deriveRecordingNoteTitle(note, interview, "Recording - 22:04:33", context, "id"),
    "Catatan Rekaman — 20 Juli 2026",
  );
});

test("rejects an ordinal section label as a grounded title", () => {
  const interview =
    "Pembahasan soal pendekatan masuk ke proyek dan strategi deployment yang sudah berjalan.";

  assert.equal(isUsefulGroundedTitle("Pertanyaan Pertama: Pendekatan Masuk ke Proyek", interview), false);
  assert.equal(isUsefulGroundedTitle("Bagian 2 - Strategi Deployment", interview), false);
});


test("document titles ignore quoted, nested and code-fenced H1 examples", () => {
  const code = "## Discussion\n\n```markdown\n# Sales Engine and Content Engine\n```\n\n> # Quoted title\n\n- # Nested title";
  assert.equal(readDocumentTitle(code), "");
  assert.equal(replaceDocumentTitle(code, "Actual title"), "# Actual title\n\n" + code);
  assert.equal(deriveRecordingNoteTitle(code, transcript, "Recording - 22:04:33", context, "id"),
    "Catatan Rekaman — 20 Juli 2026");
});

test("document title replacement changes only the real H1 and preserves code bytes", () => {
  const code = "```markdown\n# Original code title\n```\n\n";
  const source = code + "# **Sales Engine** and Content Engine ###\n\nBody.";
  assert.equal(readDocumentTitle(source), "Sales Engine and Content Engine");
  assert.equal(replaceDocumentTitle(source, "Actual title"), code + "# Actual title\n\nBody.");
});

test("document title replacement supports setext H1 and preserves leading indented code", () => {
  assert.equal(readDocumentTitle("Sales Engine and Content Engine\n=============================="), "Sales Engine and Content Engine");
  assert.equal(replaceDocumentTitle("Sales Engine and Content Engine\n==============================\n\nBody", "Actual title"),
    "# Actual title\n\nBody");
  const code = "    # Literal code title\n    9. Literal numbered code\n";
  assert.equal(replaceDocumentTitle(code, "Actual title"), "# Actual title\n\n" + code);
});
