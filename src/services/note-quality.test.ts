import assert from "node:assert/strict";
import test from "node:test";

import { assessGeneratedNote, hasBlockingDefect, shouldUseLosslessFallback } from "./note-quality.ts";

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

test("rejects editor self-commentary and same-line repetition loops", () => {
  const note = `# Rapat

## Action Items
- Dandi memperbaiki login agar sistem aman terpercaya scalable maintainable correlated correlated correlated correlated... *(Stop generating filler)* -> ulangi lagi.`;

  const issues = assessGeneratedNote(source, note, { isTruncated: false });

  assert.ok(issues.some((issue) => issue.code === "generation_artifact"));
  assert.ok(issues.some((issue) => issue.code === "repetition_loop"));
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

test("accepts a bounded three-column action-item table", () => {
  const note = `# Pembagian Tim

## Tindak Lanjut

| Tindakan | Pemilik | Tenggat Waktu |
| --- | --- | --- |
| Perbaiki integrasi dashboard | Dendy | Dua hari |
| Dokumentasikan hasil pengujian | Belum ditugaskan | Tidak ditentukan |`;

  assert.deepEqual(assessGeneratedNote(source, note, { isTruncated: false }), []);
});

test("rejects the observed runaway action-item table row", () => {
  const cascade = Array.from(
    { length: 90 },
    () => "lanjutkan implementasi integrasi kalender dan evaluasi risiko teknis",
  ).join(" ");
  const note = `# Pengembangan Engine

## Tindak Lanjut

| Tindakan | Pemilik | Tenggat Waktu |
| --- | --- | --- |
| ${cascade} | Belum ditugaskan | Tidak ditentukan |`;

  const issues = assessGeneratedNote(source, note, { isTruncated: false });

  assert.ok(issues.some((issue) => issue.code === "oversized_action_item"));
});

test("rejects action-item tables with missing owner or deadline cells", () => {
  const note = `# Pengembangan Engine

## Tindak Lanjut

| Tindakan | Pemilik | Tenggat Waktu |
| --- | --- | --- |
| Investigasi Review Q | | |`;

  const issues = assessGeneratedNote(source, note, { isTruncated: false });

  assert.ok(issues.some((issue) => issue.code === "malformed_action_items"));
});

test("rejects an incomplete or weak final title", () => {
  const titleSource = "Format data segmen kabel menggunakan GeoJSON standar dengan koordinat A-B.";
  const note = `# Format Data Segmen Kabel: GeoJSON standar dengan koordinat A-B mencakup

## Ringkasan
Format data menggunakan GeoJSON.`;

  const issues = assessGeneratedNote(titleSource, note, {
    isTruncated: false,
    requireUsefulTitle: true,
  });

  assert.ok(issues.some((issue) => issue.code === "weak_title"));
});

test("hasBlockingDefect separates structural failures from soft heuristics", () => {
  for (const code of ["empty", "truncated", "marker_mismatch", "repetition_loop", "runaway_paragraph", "generation_artifact", "malformed_action_items"] as const) {
    assert.equal(hasBlockingDefect([{ code, detail: code }]), true);
  }
  for (const code of ["excessive_expansion", "weak_title", "oversized_action_item", "too_many_action_items"] as const) {
    assert.equal(hasBlockingDefect([{ code, detail: code }]), false);
  }
  assert.equal(hasBlockingDefect([]), false);
});

test("shouldUseLosslessFallback triggers only on an unsalvageable draft", () => {
  assert.equal(shouldUseLosslessFallback([{ code: "empty", detail: "" }]), true);
  assert.equal(shouldUseLosslessFallback([{ code: "truncated", detail: "" }]), true);
  assert.equal(shouldUseLosslessFallback([{ code: "marker_mismatch", detail: "" }]), true);
  assert.equal(shouldUseLosslessFallback([{ code: "repetition_loop", detail: "" }]), false);
  assert.equal(shouldUseLosslessFallback([{ code: "malformed_action_items", detail: "" }]), false);
  assert.equal(shouldUseLosslessFallback([]), false);
});

test("detects a same-line repetition loop absent from the source", () => {
  const note = "# Rapat\n\n## Pembahasan\n\n- sistem aman terpercaya scalable maintainable correlated correlated correlated correlated.";

  assert.ok(
    assessGeneratedNote(source, note, { isTruncated: false })
      .some((issue) => issue.code === "repetition_loop"),
  );
});

test("keeps source-grounded repeated speech instead of treating it as a model loop", () => {
  const grounded = "Tadi kita bahas ngapain-ngapain-ngapain. Jam jam jam, lalu lanjut ke login.";
  const note = "# Catatan\n\n## Pembahasan\n\n- Tadi kita bahas ngapain-ngapain-ngapain.\n- Jam jam jam, lalu lanjut ke login.";

  assert.equal(
    assessGeneratedNote(grounded, note, { isTruncated: false })
      .some((issue) => issue.code === "repetition_loop"),
    false,
  );
});
