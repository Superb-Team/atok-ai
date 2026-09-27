const NUMBER_PATTERN = /(?<![\p{L}\p{N}_])\d+(?:[.,]\d+)*(?:%|m|km)?(?![\p{L}\p{N}_])/gu;
const ACRONYM_PATTERN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\b/g;
const LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()[\]{}]+/giu;
const STRUCTURAL_ACRONYMS = new Set([
  "ACTION",
  "ACTIONS",
  "CHAPTER",
  "CONSIDERATIONS",
  "CONTEXT",
  "DECISION",
  "DECISIONS",
  "DETAIL",
  "DETAILS",
  "FORMAT",
  "H1",
  "H2",
  "H3",
  "ITEM",
  "KEY",
  "NOTE",
  "OUTPUT",
  "PART",
  "POINT",
  "POINTS",
  "SECTION",
  "SUMMARY",
  "TOPIC",
  "TOPICS",
  "TRANSCRIPT",
]);

function isStructuralNumber(value: string, index: number, length: number): boolean {
  const lineStart = value.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = value.indexOf("\n", index + length);
  const before = value.slice(lineStart, index);
  const after = value.slice(index + length, lineEnd === -1 ? value.length : lineEnd);
  if (/^\s*(?:[-*+]\s*)?$/.test(before) && /^[.)]\s/.test(after)) return true;
  return /^\s*(?:#{1,6}\s*)?(?:part|section|chapter|item)\s*$/iu.test(before)
    && /^[\s:.)-]*$/u.test(after);
}

function numericAnchorsIn(value: string): string[] {
  return Array.from(value.matchAll(NUMBER_PATTERN))
    .filter((match) => !isStructuralNumber(value, match.index ?? 0, match[0].length))
    .map((match) => match[0]);
}

function normalizeLink(value: string): string {
  return value.replace(/[.,!?;:]+$/u, "");
}

/** Extract tokens that a formatting pass must preserve exactly. */
export function factualAnchorsIn(value: string): string[] {
  const numbers = numericAnchorsIn(value);
  const acronyms = (value.match(ACRONYM_PATTERN) ?? [])
    .filter((anchor) => anchor.replace(/-/g, "").length >= 2)
    .filter((anchor) => !STRUCTURAL_ACRONYMS.has(anchor));

  return [...new Set([...numbers, ...acronyms])];
}

export function missingFactualAnchors(source: string, candidate: string): string[] {
  const candidateAnchors = new Set(factualAnchorsIn(candidate));
  return factualAnchorsIn(source).filter((anchor) => !candidateAnchors.has(anchor));
}

/** Extract links whose spelling must survive a formatting-only pass. */
export function linksIn(value: string): string[] {
  return [...new Set((value.match(LINK_PATTERN) ?? []).map(normalizeLink))];
}
