import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNoteFormatMessages,
  buildNoteFormatRepairMessages,
  formatNoteWithAi,
  resolveRepairResult,
  splitImmutableTranscript,
  stripLeadingDocumentTitle,
  validateFormattedNote,
} from "./note-format.service.ts";

test("removes a duplicate document title before formatting", () => {
  const title = "Pengembangan Sistem — 11 Agustus 2026";
  const content = `# ${title}\n\n## Ringkasan\n\nAPI belum selesai.`;

  assert.equal(
    stripLeadingDocumentTitle(content, title),
    "## Ringkasan\n\nAPI belum selesai.",
  );
});

test("keeps a distinct leading heading as note content", () => {
  const content = "# Topik Tambahan\n\nIsi pembahasan.";

  assert.equal(stripLeadingDocumentTitle(content, "Judul Catatan"), content);
});

test("format prompt preserves facts and treats the title as immutable", () => {
  const messages = buildNoteFormatMessages({
    title: "Rapat TikTok",
    content: "API belum selesai. [[ATOK_ASSET_1]]\nTarget: 2 hari.",
    language: "Bahasa Indonesia",
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /preserve every factual statement/i);
  assert.match(messages[0].content, /without an H1 title/i);
  assert.match(messages[1].content, /Rapat TikTok/);
  assert.match(messages[1].content, /\[\[ATOK_ASSET_1\]\]/);
  assert.match(messages[1].content, /Target: 2 hari/);
});

test("format prompt defaults to the note's original language", () => {
  const messages = buildNoteFormatMessages({ title: "Note", content: "Isi" });
  assert.match(messages[0].content, /same language as the note/i);
});

test("rejects formatting that drops factual anchors or asset markers", () => {
  const source = "API v2 supports 25 items. [[ATOK_ASSET_1]]";
  assert.match(
    validateFormattedNote(source, "API supports items.") ?? "",
    /removed too much|factual anchor/i,
  );
  assert.match(
    validateFormattedNote(source, "API v2 supports 25 items.") ?? "",
    /asset markers/i,
  );
});

test("accepts a faithful Markdown-only reformat", () => {
  const source = "API v2 supports 25 items. [[ATOK_ASSET_1]]\nNext step tomorrow.";
  assert.equal(
    validateFormattedNote(source, "## Summary\n\nAPI v2 supports 25 items.\n\n[[ATOK_ASSET_1]]\n\nNext step tomorrow."),
    null,
  );
});

test("does not turn a trailing hyphen into a separate acronym anchor", () => {
  const source = "URL-nya belum bisa dipakai untuk callback.";
  assert.equal(
    validateFormattedNote(source, "URL belum bisa dipakai untuk callback."),
    null,
  );
});

test("compares factual anchors as tokens instead of substrings", () => {
  assert.match(
    validateFormattedNote(
      "Release 2 is ready for the production meeting tomorrow.",
      "Release 20 is ready for the production meeting tomorrow.",
    ) ?? "",
    /factual anchor '2'/i,
  );
});

test("preserves links even when they contain no numeric or acronym anchor", () => {
  const source = "Open https://example.com/meeting-notes after the call.";
  assert.match(
    validateFormattedNote(source, "Open https://example.com/archive after the call.") ?? "",
    /changed links/i,
  );
  assert.equal(
    validateFormattedNote(source, "Open [the notes](https://example.com/meeting-notes) after the call."),
    null,
  );
});

test("reports unsafe formatting instead of silently accepting it", () => {
  const source = "URL-nya belum bisa dipakai. [[ATOK_ASSET_1]]";
  const unsafe = "Belum bisa dipakai.";
  assert.match(validateFormattedNote(source, unsafe) ?? "", /removed too much|factual anchor/i);
});

test("keeps the original note when formatting drops a factual anchor", () => {
  const source = "Cron berjalan setiap 15 menit agar jadwal tetap akurat.";
  const candidate = "Cron berjalan agar jadwal tetap akurat.";

  assert.equal(resolveRepairResult(source, source, candidate), source);
});

test("uses a safe formatting candidate", () => {
  const source = "Cron berjalan setiap 15 menit agar jadwal tetap akurat.";
  const candidate = "## Penjadwalan\n\nCron berjalan setiap 15 menit agar jadwal tetap akurat.";

  assert.equal(resolveRepairResult(source, source, candidate), candidate);
});

test("does not hide a formatting provider failure behind a local fallback", async () => {
  const transcript = "URL-nya belum bisa dipakai untuk callback. Kalimat ini harus tetap utuh.";
  const fallback = [
    "# Rapat",
    "> Pemformatan AI tidak tersedia. Bagian di bawah dibuat secara ekstraktif.",
    "",
    "## Ringkasan Ekstraktif",
    "",
    "Ini cuma ada Dandy sama Bintang. Jadi ini tahlilan.",
    "",
    "## Poin Utama",
    "",
    "- Oke, jadi ini udah coba-coba ya.",
    "",
    "## Transcript Lengkap",
    "",
    transcript,
  ].join("\n");

  await assert.rejects(
    formatNoteWithAi({ title: "Rapat", content: fallback }),
    /AI formatting unavailable/i,
  );
});

test("separates the complete transcript from the AI formatting payload", () => {
  const source = [
    "## Ringkasan",
    "",
    "URL-nya dibahas dalam rapat.",
    "",
    "## Transcript Lengkap",
    "",
    "URL-nya belum bisa dipakai untuk callback. [[ATOK_ASSET_1]]",
  ].join("\n");

  assert.deepEqual(splitImmutableTranscript(source), {
    editablePrefix: "## Ringkasan\n\nURL-nya dibahas dalam rapat.",
    immutableTranscript: "## Transcript Lengkap\n\nURL-nya belum bisa dipakai untuk callback. [[ATOK_ASSET_1]]",
  });
});

test("does not split a normal sentence that mentions the transcript heading", () => {
  assert.equal(
    splitImmutableTranscript("Pembicara menyebut ## Transcript Lengkap sebagai contoh."),
    null,
  );
});

test("accepts a repaired formatter output after the first output drops an anchor", () => {
  const source = [
    "### Contoh Format Output",
    "- Anggaran pemasaran diusulkan sebesar Rp 500 juta.",
    "- Keputusan final belum diambil.",
  ].join("\n");
  const firstAttempt = "### Contoh Format Output\n- Keputusan final belum diambil.";
  const retry = "### Contoh Format Output\n\n- Anggaran pemasaran diusulkan sebesar Rp 500 juta.\n- Keputusan final belum diambil.";

  assert.match(validateFormattedNote(source, firstAttempt) ?? "", /factual anchor '500'/i);
  assert.equal(validateFormattedNote(source, retry), null);
});

test("repair prompt explicitly protects the anchors omitted by the first attempt", () => {
  const messages = buildNoteFormatRepairMessages(
    {
      title: "Rapat",
      content: "Contoh anggaran: Rp 500 juta.",
    },
    ["500"],
  );

  assert.match(messages[0].content, /formatting only/i);
  assert.match(messages[0].content, /500/);
  assert.match(messages[1].content, /Rp 500 juta/);
});
