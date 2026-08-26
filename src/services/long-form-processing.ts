const ASSET_MARKER_PATTERN = /\[\[ATOK_ASSET_\d+\]\]/g;
const LEXICAL_UNIT_PATTERN = /\[\[ATOK_ASSET_\d+\]\]|[^\S\r\n]+|[\r\n]+|[^\s]+/gu;

export interface TranscriptSection {
  id: string;
  index: number;
  text: string;
  startChar: number;
  endChar: number;
  estimatedTokens: number;
  markers: string[];
}

export interface ProcessedSection {
  id: string;
  index: number;
  markdown: string;
  markers: string[];
  isDegraded: boolean;
}

// Context capacity is not an operational request-size target. Smaller sections
// finish faster, checkpoint independently, and bound the amount retried after
// a provider failure. The estimate used here is conservative UTF-8 bytes.
export function operationalSourceTokenBudget(providerBudget: number): number {
  return Math.min(18_000, providerBudget);
}

export function isUsableSectionBackedDraft(sections: readonly ProcessedSection[]): boolean {
  return sections.length > 0 && sections.every(
    (section) => !section.isDegraded && section.markdown.trim().length > 0,
  );
}

export function stripPlaceholderSections(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (/^##\s+(?:Decisions|Keputusan|Action Items|Tindak Lanjut)\s*$/iu.test(lines[index].trim())) {
      let end = index + 1;
      while (end < lines.length && !/^##\s+/u.test(lines[end].trim())) end += 1;
      const body = lines.slice(index + 1, end).join(" ").replace(/[*_()]/g, " ").trim();
      if (
        !body
        || /^(?:tidak ada|belum ada|no|none)\b.*\b(?:keputusan|decisions?|tindak lanjut|action items?|follow-?ups?)\b/iu.test(body)
        || /^(?:no explicit action items?|nothing to follow up)\b/iu.test(body)
      ) {
        while (output.length > 0 && output[output.length - 1].trim() === "") output.pop();
        index = end;
        continue;
      }
    }
    output.push(lines[index]);
    index += 1;
  }
  return output
    .join("\n")
    .replace(/([^\n])\n(##\s+)/g, "$1\n\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A tokenizer token cannot encode more information than the UTF-8 bytes that
// represent its text. Counting bytes is deliberately conservative across Latin,
// CJK, Arabic, emoji, code, and mixed-language transcripts. Request-level
// message overhead is reserved separately by the caller.
export function estimateTokenUpperBound(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${hash.toString(16).padStart(8, "0")}`;
}

export function sectionSourceFingerprint(model: string, language: string, source: string): string {
  return fingerprintText(`${model}\0${language}\0${source}`);
}

function markersIn(text: string): string[] {
  return text.match(ASSET_MARKER_PATTERN) ?? [];
}

function splitOversizedUnit(unit: string, budget: number): string[] {
  if (estimateTokenUpperBound(unit) <= budget) return [unit];
  if (/^\[\[ATOK_ASSET_\d+\]\]$/.test(unit)) {
    throw new Error(`Token budget ${budget} is too small for asset marker ${unit}`);
  }

  const pieces: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of unit) {
    const characterBytes = estimateTokenUpperBound(character);
    if (current && currentBytes + characterBytes > budget) {
      pieces.push(current);
      current = character;
      currentBytes = characterBytes;
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function preferredSemanticBoundary(text: string): number {
  const minimum = Math.floor(text.length * 0.5);
  let best = 0;
  const boundaryPattern = /(?:\r?\n){2,}|[.!?]["')\]]*(?:[ \t]+|\r?\n+)/gu;
  for (const match of text.matchAll(boundaryPattern)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= minimum) best = end;
  }
  return best;
}

export function splitTranscriptByTokenBudget(
  transcript: string,
  maxSourceTokens: number,
): TranscriptSection[] {
  if (!Number.isInteger(maxSourceTokens) || maxSourceTokens < 32) {
    throw new Error("maxSourceTokens must be an integer of at least 32");
  }
  if (!transcript) return [];

  const units = transcript.match(LEXICAL_UNIT_PATTERN) ?? [transcript];
  const sections: TranscriptSection[] = [];
  let current = "";
  let currentTokens = 0;
  let cursor = 0;

  const flush = (end = current.length) => {
    if (!current) return;
    const text = current.slice(0, end);
    const index = sections.length;
    const startChar = cursor;
    cursor += text.length;
    sections.push({
      id: `section-${String(index + 1).padStart(4, "0")}`,
      index,
      text,
      startChar,
      endChar: cursor,
      estimatedTokens: estimateTokenUpperBound(text),
      markers: markersIn(text),
    });
    current = current.slice(end);
    currentTokens = estimateTokenUpperBound(current);
  };

  for (const rawUnit of units) {
    for (const unit of splitOversizedUnit(rawUnit, maxSourceTokens)) {
      const unitTokens = estimateTokenUpperBound(unit);
      if (current && currentTokens + unitTokens > maxSourceTokens) {
        const semanticBoundary = preferredSemanticBoundary(current);
        flush(semanticBoundary || current.length);
        if (current && currentTokens + unitTokens > maxSourceTokens) flush();
      }
      current += unit;
      currentTokens += unitTokens;
    }
  }
  flush();

  if (sections.map((section) => section.text).join("") !== transcript) {
    throw new Error("Transcript section planner lost source text");
  }
  return sections;
}

export function packByTokenBudget(values: string[], maxTokens: number): string[][] {
  if (!Number.isInteger(maxTokens) || maxTokens < 32) {
    throw new Error("maxTokens must be an integer of at least 32");
  }

  const batches: string[][] = [];
  let current: string[] = [];

  for (const value of values) {
    if (estimateTokenUpperBound(value) > maxTokens) {
      throw new Error("A reduce item exceeds the configured token budget");
    }
    const candidate = [...current, value];
    if (current.length > 0 && estimateTokenUpperBound(candidate.join("\n\n")) > maxTokens) {
      batches.push(current);
      current = [value];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function normalizeTopicHeadings(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+(?:Section|Part|Bagian)\s+\d+\s*$/gimu, "")
    .replace(/^#{1,6}\s+(.+)$/gm, "### $1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function composeLongFormNote(
  globalMarkdown: string,
  sections: ProcessedSection[],
  language = "en",
): string {
  const ordered = [...sections].sort((a, b) => a.index - b.index);
  const details = ordered.map((section) => {
    const warning = section.isDegraded
      ? `\n\n> ${language === "id"
        ? "Bagian ini membutuhkan pemeriksaan; bandingkan dengan transcript lengkap sebelum menyimpan."
        : "This section needs review; compare it with the complete transcript before saving."}`
      : "";
    return `${normalizeTopicHeadings(section.markdown)}${warning}`.trim();
  });
  const detailsHeading = language === "id" ? "## Pembahasan Terperinci" : "## Detailed Discussion";

  return [globalMarkdown.trim(), detailsHeading, ...details]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
