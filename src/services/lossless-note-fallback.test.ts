import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildLosslessStructuredFallback,
  isExtractiveFallbackNote,
} from "./lossless-note-fallback.ts";

const transcript = `Dendy menjelaskan dashboard sudah terhubung dengan database. Integrasi data scraping belum selesai diuji.

Dendy akan memperbaiki session login malam ini. Target integrasi dashboard adalah dua hari.

Tim diminta membuat unit test untuk setiap endpoint. Sampai jumpa minggu depan.`;

describe("buildLosslessStructuredFallback", () => {
  it("creates a structured Indonesian note without embedding the transcript", () => {
    const note = buildLosslessStructuredFallback("Recording - 19:40:52", transcript, "id");

    assert.match(note, /^# Recording - 19:40:52/m);
    assert.match(note, /^## Ringkasan Ekstraktif$/m);
    assert.match(note, /^## Poin Utama$/m);
    assert.match(note, /^## Tindak Lanjut yang Disebutkan$/m);
    assert.doesNotMatch(note, /^## Transcript Lengkap$/m);
  });

  it("only uses source sentences for generated bullets", () => {
    const note = buildLosslessStructuredFallback("Recording", transcript, "id");
    const bullets = note.split("\n").filter((line) => line.startsWith("- "));

    assert.ok(bullets.length > 0);
    for (const bullet of bullets) {
      assert.ok(transcript.includes(bullet.slice(2)), `Unsupported bullet: ${bullet}`);
    }
  });

  it("bounds extracted sections for an arbitrarily long source", () => {
    const longTranscript = Array.from(
      { length: 100 },
      (_, index) => `Poin rapat nomor ${index + 1} akan diperiksa besok.`,
    ).join(" ");
    const note = buildLosslessStructuredFallback("Rapat", longTranscript, "id");
    const bullets = note.split("\n").filter((line) => line.startsWith("- "));

    assert.ok(bullets.length <= 18);
    assert.doesNotMatch(note, /^## Transcript Lengkap$/m);
  });
});

describe("isExtractiveFallbackNote", () => {
  it("recognizes the Indonesian fallback warning as durable degraded state", () => {
    const note = buildLosslessStructuredFallback("Rapat", transcript, "id");

    assert.equal(isExtractiveFallbackNote(note), true);
  });

  it("recognizes the English fallback warning without matching ordinary notes", () => {
    assert.equal(
      isExtractiveFallbackNote(
        "> AI formatting was unavailable. The sections below are extractive.\n\n## Summary\n\nFacts",
      ),
      true,
    );
    assert.equal(isExtractiveFallbackNote("## Summary\n\nFacts"), false);
  });
});
