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
  return Math.min(6_000, providerBudget);
}

export function stripPlaceholderSections(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (/^##\s+(?:Decisions|Keputusan)\s*$/iu.test(lines[index].trim())) {
      let end = index + 1;
      while (end < lines.length && !/^##\s+/u.test(lines[end].trim())) end += 1;
      const body = lines.slice(index + 1, end).join(" ").replace(/[*_()]/g, " ").trim();
      if (/^(?:tidak ada|no)\b.*\b(?:keputusan|decisions?)\b/iu.test(body)) {
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

  const flush = () => {
    if (!current) return;
    const index = sections.length;
    const startChar = cursor;
    cursor += current.length;
    sections.push({
      id: `section-${String(index + 1).padStart(4, "0")}`,
      index,
      text: current,
      startChar,
      endChar: cursor,
      estimatedTokens: estimateTokenUpperBound(current),
      markers: markersIn(current),
    });
    current = "";
    currentTokens = 0;
  };

  for (const rawUnit of units) {
    for (const unit of splitOversizedUnit(rawUnit, maxSourceTokens)) {
      const unitTokens = estimateTokenUpperBound(unit);
      if (current && currentTokens + unitTokens > maxSourceTokens) {
        flush();
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

function indentSectionHeadings(markdown: string): string {
  return markdown.replace(/^(#{1,6})\s+/gm, (_match, hashes: string) => {
    const depth = Math.min(hashes.length + 2, 6);
    return `${"#".repeat(depth)} `;
  });
}

export function composeLongFormNote(
  globalMarkdown: string,
  sections: ProcessedSection[],
): string {
  const ordered = [...sections].sort((a, b) => a.index - b.index);
  const details = ordered.map((section) => {
    const warning = section.isDegraded
      ? `\n\n> Section ${section.index + 1} could not be fully enhanced; raw transcript preserved for completeness.`
      : "";
    return `### Section ${section.index + 1}\n\n${indentSectionHeadings(section.markdown).trim()}${warning}`;
  });

  return [globalMarkdown.trim(), "## Detailed Notes", ...details]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
