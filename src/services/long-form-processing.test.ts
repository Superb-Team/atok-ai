import assert from "node:assert/strict";
import test from "node:test";

import {
  composeLongFormNote,
  estimateTokenUpperBound,
  fingerprintText,
  packByTokenBudget,
  operationalSourceTokenBudget,
  sectionSourceFingerprint,
  splitTranscriptByTokenBudget,
  stripPlaceholderSections,
  type ProcessedSection,
} from "./long-form-processing.ts";

test("operational section budget stays bounded below a model context window", () => {
  assert.equal(operationalSourceTokenBudget(240_000), 6_000);
  assert.equal(operationalSourceTokenBudget(4_000), 4_000);
});

test("token estimate is conservative for ASCII and multibyte text", () => {
  assert.ok(estimateTokenUpperBound("hello world") >= 11);
  assert.ok(estimateTokenUpperBound("你好 dunia 🌏") >= new TextEncoder().encode("你好 dunia 🌏").length);
});

test("text fingerprint is stable and changes with source content", () => {
  assert.equal(fingerprintText("same transcript"), fingerprintText("same transcript"));
  assert.notEqual(fingerprintText("same transcript"), fingerprintText("different transcript"));
});

test("section cache is invalidated when the configured model changes", () => {
  const source = "Transcript rapat yang sama.";
  assert.notEqual(
    sectionSourceFingerprint("deepseek-ai/DeepSeek-V4-Flash", "id", source),
    sectionSourceFingerprint("XiaomiMiMo/MiMo-V2.5", "id", source),
  );
});

test("splitter preserves all source text and keeps every marker atomic", () => {
  const source = [
    "Pembukaan rapat membahas target kuartal pertama.",
    "[[ATOK_ASSET_1]]",
    "Keputusan pertama adalah mempertahankan jadwal. ".repeat(30),
    "[[ATOK_ASSET_2]]",
    "Penutup rapat dan tindak lanjut.",
  ].join("\n\n");

  const sections = splitTranscriptByTokenBudget(source, 240);

  assert.ok(sections.length > 2);
  assert.equal(sections.map((section) => section.text).join(""), source);
  assert.deepEqual(sections.flatMap((section) => section.markers), [
    "[[ATOK_ASSET_1]]",
    "[[ATOK_ASSET_2]]",
  ]);
  assert.ok(sections.every((section) => section.estimatedTokens <= 240));
});

test("splitter bounds a one-million-character transcript without data loss", () => {
  const source = "Agenda panjang. Keputusan harus tetap tercatat. ".repeat(21_000);
  const sections = splitTranscriptByTokenBudget(source, 8_000);

  assert.ok(source.length >= 1_000_000);
  assert.ok(sections.length > 100);
  assert.equal(sections.map((section) => section.text).join(""), source);
  assert.ok(sections.every((section) => section.estimatedTokens <= 8_000));
});

test("batch packer never creates an over-budget reduce batch", () => {
  const values = Array.from({ length: 100 }, (_, index) => `section-${index} ${"detail ".repeat(20)}`);
  const batches = packByTokenBudget(values, 700);

  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), values);
  assert.ok(batches.every((batch) => estimateTokenUpperBound(batch.join("\n\n")) <= 700));
});

test("composer preserves every detail without exposing internal section numbers", () => {
  const sections: ProcessedSection[] = [
    {
      id: "section-0001",
      index: 0,
      markdown: "## Progres Sales Engine\n\nPoin pertama.\n\n[[ATOK_ASSET_1]]",
      markers: ["[[ATOK_ASSET_1]]"],
      isDegraded: false,
    },
    {
      id: "section-0002",
      index: 1,
      markdown: "## Strategi Konten\n\nPoin kedua.\n\n[[ATOK_ASSET_2]]",
      markers: ["[[ATOK_ASSET_2]]"],
      isDegraded: true,
    },
  ];

  const note = composeLongFormNote("# Rapat\n\n## Ringkasan\nRingkasan.", sections, "id");

  assert.equal(note.match(/Poin pertama\./g)?.length, 1);
  assert.equal(note.match(/Poin kedua\./g)?.length, 1);
  assert.ok(note.indexOf("[[ATOK_ASSET_1]]") < note.indexOf("[[ATOK_ASSET_2]]"));
  assert.match(note, /^## Pembahasan Terperinci$/m);
  assert.match(note, /^### Progres Sales Engine$/m);
  assert.match(note, /^### Strategi Konten$/m);
  assert.doesNotMatch(note, /(?:Section|Bagian)\s+\d+/i);
  assert.match(note, /transkrip mentah dipertahankan/i);
});

test("placeholder decision sections are omitted instead of published", () => {
  const note = `# Rapat\n\n## Summary\nIsi.\n\n## Decisions\n*(Tidak ada keputusan final yang dikonfirmasi.)*\n\n## Action Items\n- Tindak lanjut.`;

  assert.equal(
    stripPlaceholderSections(note),
    "# Rapat\n\n## Summary\nIsi.\n\n## Action Items\n- Tindak lanjut.",
  );
});

test("placeholder action-item sections are omitted instead of published", () => {
  const note = `# Rapat\n\n## Ringkasan\nIsi.\n\n## Tindak Lanjut\n(No explicit action items with owners/deadlines recorded in notes)\n\n## Pembahasan\nDetail.`;

  assert.equal(
    stripPlaceholderSections(note),
    "# Rapat\n\n## Ringkasan\nIsi.\n\n## Pembahasan\nDetail.",
  );
});
