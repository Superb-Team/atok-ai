import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildLosslessStructuredFallback } from "./lossless-note-fallback.ts";

const transcript = `Dendy menjelaskan dashboard sudah terhubung dengan database. Integrasi data scraping belum selesai diuji.

Dendy akan memperbaiki session login malam ini. Target integrasi dashboard adalah dua hari.

Tim diminta membuat unit test untuk setiap endpoint. Sampai jumpa minggu depan.`;

describe("buildLosslessStructuredFallback", () => {
  it("preserves the complete transcript inside a structured Indonesian note", () => {
    const note = buildLosslessStructuredFallback("Recording - 19:40:52", transcript, "id");

    assert.match(note, /^# Recording - 19:40:52/m);
    assert.match(note, /^## Ringkasan Ekstraktif$/m);
    assert.match(note, /^## Poin Utama$/m);
    assert.match(note, /^## Tindak Lanjut yang Disebutkan$/m);
    assert.match(note, /^## Transcript Lengkap$/m);
    assert.ok(note.endsWith(transcript));
  });

  it("only uses source sentences for generated bullets", () => {
    const note = buildLosslessStructuredFallback("Recording", transcript, "id");
    const bullets = note.split("\n").filter((line) => line.startsWith("- "));

    assert.ok(bullets.length > 0);
    for (const bullet of bullets) {
      assert.ok(transcript.includes(bullet.slice(2)), `Unsupported bullet: ${bullet}`);
    }
  });

  it("bounds extracted sections while retaining an arbitrarily long source", () => {
    const longTranscript = Array.from(
      { length: 100 },
      (_, index) => `Poin rapat nomor ${index + 1} akan diperiksa besok.`,
    ).join(" ");
    const note = buildLosslessStructuredFallback("Rapat", longTranscript, "id");
    const beforeTranscript = note.split("## Transcript Lengkap")[0];
    const bullets = beforeTranscript.split("\n").filter((line) => line.startsWith("- "));

    assert.ok(bullets.length <= 18);
    assert.ok(note.endsWith(longTranscript));
  });
});
