import assert from "node:assert/strict";
import test from "node:test";

import { assessGeneratedNote, shouldUseLosslessFallback } from "./note-quality.ts";

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

test("detects same-line repetition loops without phrase matching", () => {
  const note = `# Rapat

## Action Items
- Dandi memperbaiki login agar sistem aman terpercaya scalable maintainable correlated correlated correlated correlated... *(Stop generating filler)* -> ulangi lagi.`;

  const issues = assessGeneratedNote(source, note, { isTruncated: false });

  assert.ok(issues.some((issue) => issue.code === "repetition_loop"));
});

test("keeps source-grounded repeated speech instead of treating it as a model loop", () => {
  const source = "Tadi kita bahas ngapain-ngapain-ngapain. Jam jam jam, lalu lanjut ke login.";
  const note = "# Catatan\n\n## Pembahasan\n\n- Tadi kita bahas ngapain-ngapain-ngapain.\n- Jam jam jam, lalu lanjut ke login.";

  assert.equal(
    assessGeneratedNote(source, note, { isTruncated: false })
      .some((issue) => issue.code === "repetition_loop"),
    false,
  );
});

test("rejects invented, missing, or renumbered screenshot markers", () => {
  const invented = assessGeneratedNote(source, "# Rapat\n\n[[ATOK_ASSET_1]]", {
    isTruncated: false,
  });
  const missing = assessGeneratedNote(`${source}\n[[ATOK_ASSET_2]]`, "# Rapat", {
    isTruncated: false,
  });

  assert.ok(invented.some((issue) => issue.code === "marker_mismatch"));
  assert.ok(missing.some((issue) => issue.code === "marker_mismatch"));
});

test("rejects invented numeric and acronym anchors", () => {
  const meeting = "APT menetapkan zona 50 meter dan data JSON.";
  const note = "# Rapat\n\nAPT menetapkan zona 75 meter dan mengirim SMS.";

  const issues = assessGeneratedNote(meeting, note, { isTruncated: false });

  assert.ok(issues.some((issue) =>
    issue.code === "unsupported_anchor" && issue.detail.includes("75") && issue.detail.includes("SMS")
  ));
});

test("does not treat Markdown structure as a new factual anchor", () => {
  const meeting = "APT membahas integrasi dashboard dan API.";
  const note = "# Rapat\n\n## PART 1\n\n1. APT membahas integrasi dashboard dan API.";

  assert.equal(
    assessGeneratedNote(meeting, note, { isTruncated: false })
      .some((issue) => issue.code === "unsupported_anchor"),
    false,
  );
});

test("does not flag URL-nya as an invented URL anchor", () => {
  const issues = assessGeneratedNote(
    "URL-nya belum bisa dipakai untuk callback.",
    "URL belum bisa dipakai untuk callback.",
    { isTruncated: false },
  );

  assert.equal(issues.some((issue) => issue.code === "unsupported_anchor"), false);
});

test("reports fabricated anchors without turning them into a runtime kill switch", () => {
  const note = `### Contoh Format Output

- Anggaran pemasaran diusulkan sebesar Rp 500 juta.

Silakan tempelkan teks PART 3 dari transkrip Anda.`;
  const issues = assessGeneratedNote(source, note, { isTruncated: false });

  assert.ok(issues.some((issue) => issue.code === "unsupported_anchor" && issue.detail.includes("500")));
  assert.equal(shouldUseLosslessFallback(issues), false);
});

test("uses lossless fallback only for objective structural failures", () => {
  assert.equal(shouldUseLosslessFallback([{ code: "empty", detail: "empty" }]), true);
  assert.equal(shouldUseLosslessFallback([{ code: "truncated", detail: "truncated" }]), true);
  assert.equal(shouldUseLosslessFallback([{ code: "marker_mismatch", detail: "marker" }]), true);
  assert.equal(shouldUseLosslessFallback([{ code: "runaway_paragraph", detail: "too long" }]), false);
  assert.equal(shouldUseLosslessFallback([{ code: "unsupported_anchor", detail: "heuristic" }]), false);
  assert.equal(shouldUseLosslessFallback([{ code: "repetition_loop", detail: "heuristic" }]), false);
  assert.equal(shouldUseLosslessFallback([]), false);
});
