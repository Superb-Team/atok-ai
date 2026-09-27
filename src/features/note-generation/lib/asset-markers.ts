import type { RecordingAsset } from "../../notes/api/note-asset.service.ts";

// Place each screenshot marker at the word position proportional to when it was
// taken. Approximate by design (speech density varies), but lands the image in
// the right part of the conversation; the LLM keeps it on section boundaries.
export function insertAssetMarkers(
  transcript: string,
  assets: RecordingAsset[],
  durationMs: number,
): string {
  const words = transcript.split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationMs <= 0) {
    const markers = assets.map((_, i) => `[[ATOK_ASSET_${i + 1}]]`).join("\n");
    return `${transcript}\n\n${markers}`.trim();
  }

  const pieces: string[] = [];
  let cursor = 0;
  assets.forEach((asset, i) => {
    const ratio = Math.min(Math.max(asset.elapsed_ms / durationMs, 0), 1);
    const index = Math.min(Math.round(ratio * words.length), words.length);
    pieces.push(words.slice(cursor, index).join(" "));
    pieces.push(`\n\n[[ATOK_ASSET_${i + 1}]]\n\n`);
    cursor = Math.max(cursor, index);
  });
  pieces.push(words.slice(cursor).join(" "));
  return pieces.join(" ").replace(/[ \t]+\n/g, "\n").trim();
}

// Swap markers for image embeds; markers the LLM dropped are appended under a
// trailing "## Screenshots" section so no capture is ever lost.
export function applyAssetMarkers(text: string, assets: RecordingAsset[]): string {
  const used = new Set<number>();
  let result = text.replace(/\[\[ATOK_ASSET_(\d+)\]\]/g, (match, num: string) => {
    const idx = Number(num) - 1;
    const asset = assets[idx];
    if (!asset || used.has(idx)) return used.has(idx) ? "" : match;
    used.add(idx);
    return `![Screenshot ${formatElapsed(asset.elapsed_ms)}](${asset.path})`;
  });

  const missing = assets.filter((_, i) => !used.has(i));
  if (missing.length > 0) {
    const lines = missing
      .map((a) => `![Screenshot ${formatElapsed(a.elapsed_ms)}](${a.path})`)
      .join("\n\n");
    result = `${result.trimEnd()}\n\n## Screenshots\n\n${lines}\n`;
  }
  return result;
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}
