import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStructuredGlobalNote,
  renderStructuredGlobalNote,
} from "./structured-global-note.ts";

const source = `Faris diminta membuat template unit test.
Dandy akan finalisasi unit test setelah Faris selesai.
Tim memperkirakan pekerjaan bisa selesai minggu ini, tetapi tidak memberikan komitmen tenggat.
Perlu investigasi penyebab error Review Q.`;

test("parses grounded structured front matter and renders a bounded action table", () => {
  const raw = JSON.stringify({
    title: "Koordinasi Unit Test Faris dan Dandy",
    title_evidence: [
      "Faris diminta membuat template unit test.",
      "Dandy akan finalisasi unit test setelah Faris selesai.",
    ],
    summary: "Tim membahas unit test dan kendala Review Q.",
    key_points: ["Pekerjaan unit test dibagi antara Faris dan Dandy."],
    decisions: [],
    action_items: [
      {
        action: "Buat template unit test",
        owner: "Faris",
        deadline: "Tidak ditentukan",
        evidence: "Faris diminta membuat template unit test.",
      },
      {
        action: "Investigasi penyebab error Review Q",
        owner: "Belum ditugaskan",
        deadline: "Tidak ditentukan",
        evidence: "Perlu investigasi penyebab error Review Q.",
      },
    ],
  });

  const parsed = parseStructuredGlobalNote(raw, source, "id");
  const markdown = renderStructuredGlobalNote(parsed, "id");

  assert.match(markdown, /^# Koordinasi Unit Test Faris dan Dandy$/m);
  assert.match(markdown, /^\| Tindakan \| Pemilik \| Tenggat Waktu \|$/m);
  assert.match(markdown, /^\| Buat template unit test \| Faris \| Tidak ditentukan \|$/m);
  assert.doesNotMatch(markdown, /evidence/iu);
});

test("rejects an owner that is not explicit in the supporting evidence", () => {
  const raw = JSON.stringify({
    title: "Koordinasi Unit Test Faris dan Dandy",
    title_evidence: [
      "Faris diminta membuat template unit test.",
      "Dandy akan finalisasi unit test setelah Faris selesai.",
    ],
    summary: "Tim membahas unit test.",
    key_points: [],
    decisions: [],
    action_items: [{
      action: "Investigasi penyebab error Review Q",
      owner: "Faris",
      deadline: "Tidak ditentukan",
      evidence: "Perlu investigasi penyebab error Review Q.",
    }],
  });

  assert.throws(
    () => parseStructuredGlobalNote(raw, source, "id"),
    /owner is not present in its evidence/,
  );
});

test("rejects estimates promoted into deadlines", () => {
  const raw = JSON.stringify({
    title: "Koordinasi Unit Test Faris dan Dandy",
    title_evidence: [
      "Faris diminta membuat template unit test.",
      "Dandy akan finalisasi unit test setelah Faris selesai.",
    ],
    summary: "Tim membahas unit test.",
    key_points: [],
    decisions: [],
    action_items: [{
      action: "Selesaikan unit test",
      owner: "Belum ditugaskan",
      deadline: "Jumat",
      evidence: "Tim memperkirakan pekerjaan bisa selesai minggu ini, tetapi tidak memberikan komitmen tenggat.",
    }],
  });

  assert.throws(
    () => parseStructuredGlobalNote(raw, source, "id"),
    /deadline is not present in its evidence/,
  );
});

test("rejects runaway action cells even when JSON parsing succeeds", () => {
  const raw = JSON.stringify({
    title: "Koordinasi Unit Test Faris dan Dandy",
    title_evidence: [
      "Faris diminta membuat template unit test.",
      "Dandy akan finalisasi unit test setelah Faris selesai.",
    ],
    summary: "Tim membahas unit test.",
    key_points: [],
    decisions: [],
    action_items: [{
      action: "kata ".repeat(100),
      owner: "Belum ditugaskan",
      deadline: "Tidak ditentukan",
      evidence: "Perlu investigasi penyebab error Review Q.",
    }],
  });

  assert.throws(
    () => parseStructuredGlobalNote(raw, source, "id"),
    /invalid length/,
  );
});

test("rejects Markdown embedded in the structured title", () => {
  const raw = JSON.stringify({
    title: "# Koordinasi Unit Test Faris dan Dandy",
    title_evidence: [
      "Faris diminta membuat template unit test.",
      "Dandy akan finalisasi unit test setelah Faris selesai.",
    ],
    summary: "Tim membahas unit test.",
    key_points: [],
    decisions: [],
    action_items: [],
  });

  assert.throws(
    () => parseStructuredGlobalNote(raw, source, "id"),
    /title must be plain text/,
  );
});

test("rejects the observed incomplete title ending in a connector", () => {
  const raw = JSON.stringify({
    title: "Format Data Segmen Kabel dengan koordinat A-B mencakup",
    title_evidence: [
      "Faris diminta membuat template unit test.",
      "Dandy akan finalisasi unit test setelah Faris selesai.",
    ],
    summary: "Tim membahas unit test.",
    key_points: [],
    decisions: [],
    action_items: [],
  });

  assert.throws(
    () => parseStructuredGlobalNote(raw, source, "id"),
    /title_evidence.*does not support|title.*grounded|title.*incomplete/iu,
  );
});
