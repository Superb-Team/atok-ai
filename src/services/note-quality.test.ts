import assert from "node:assert/strict";
import test from "node:test";

import { assessGeneratedNote } from "./note-quality.ts";

const source = `Rapat membahas pembagian tim engineering dan operasional.
Dendy akan memperbaiki integrasi dashboard dalam dua hari.
Tim sepakat menggunakan satu database PostgreSQL.`;

test("accepts a concise structured note grounded in the transcript", () => {
  const note = `# Pembagian Tim

## Ringkasan
Rapat membahas pembagian tim engineering dan operasional.

## Action Items
- Dendy memperbaiki integrasi dashboard dalam dua hari.`;

  assert.deepEqual(assessGeneratedNote(source, note, { isTruncated: false }), []);
});
test("rejects a truncated completion", () => {
  const issues = assessGeneratedNote(source, "# Catatan\n\nIsi belum selesai", {
    isTruncated: true,
  });

  assert.ok(issues.some((issue) => issue.code === "truncated"));
});

test("rejects the observed single-paragraph runaway word cascade", () => {
  const cascadeWords = [
    "server", "stage", "environment", "migration", "monitoring", "payment",
    "tracking", "framework", "documented", "verified", "authenticated",
    "authorized", "activated", "operational", "protected", "integrated",
    "combined", "classified", "archived", "transported", "accelerated",
    "expanded", "supported", "completed", "terminated", "suspended",
    "retrieved", "illustrated", "represented", "questioned", "remembered",
  ];
  const runaway = Array.from({ length: 20 }, (_, index) =>
    cascadeWords.map((word) => `${word}${index}`).join(" "),
  ).join(" ");
  const note = `# Rapat\n\n## Operasional\n\n${runaway}`;

  const issues = assessGeneratedNote(source, note, { isTruncated: false });

  assert.ok(issues.some((issue) => issue.code === "runaway_paragraph"));
  assert.ok(issues.some((issue) => issue.code === "excessive_expansion"));
});
