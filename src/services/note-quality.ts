import { factualAnchorsIn } from "./factual-anchors.ts";

export type NoteQualityIssueCode =
  | "empty"
  | "truncated"
  | "runaway_paragraph"
  | "excessive_expansion"
  | "repetition_loop"
  | "marker_mismatch"
  | "unsupported_anchor";

export interface NoteQualityIssue {
  code: NoteQualityIssueCode;
  detail: string;
}
interface CompletionState {
  isTruncated: boolean;
}

function wordsIn(value: string): string[] {
  return value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function assetMarkersIn(value: string): string[] {
  return (value.match(/\[\[ATOK_ASSET_\d+\]\]/g) ?? []).sort();
}

interface RepeatedTokenRun {
  token: string;
  count: number;
}

function repeatedTokenRuns(value: string): RepeatedTokenRun[] {
  const pattern = /\b([\p{L}\p{N}_]{3,})\b(?:[\s,;:.*+\-]+\1\b){2,}/giu;
  return Array.from(value.matchAll(pattern), (match) => {
    const token = match[1].toLocaleLowerCase();
    const count = (match[0].match(/[\p{L}\p{N}_]+/gu) ?? [])
      .filter((candidate) => candidate.toLocaleLowerCase() === token)
      .length;
    return { token, count };
  });
}

export function assessGeneratedNote(
  source: string,
  generated: string,
  completion: CompletionState,
): NoteQualityIssue[] {
  const issues: NoteQualityIssue[] = [];
  const trimmed = generated.trim();
  if (!trimmed) {
    issues.push({ code: "empty", detail: "Generated note is empty" });
    return issues;
  }
  if (completion.isTruncated) {
    issues.push({ code: "truncated", detail: "Provider ended the response at its token limit" });
  }

  const sourceRuns = repeatedTokenRuns(source);
  const generatedRun = repeatedTokenRuns(trimmed).find((run) =>
    !sourceRuns.some((sourceRun) => sourceRun.token === run.token && sourceRun.count >= run.count),
  );
  if (generatedRun) {
    issues.push({
      code: "repetition_loop",
      detail: `Generated note repeats '${generatedRun.token}' at least three times consecutively without the same source pattern`,
    });
  }
  const sourceMarkers = assetMarkersIn(source);
  const generatedMarkers = assetMarkersIn(generated);
  if (
    sourceMarkers.length !== generatedMarkers.length ||
    sourceMarkers.some((marker, index) => marker !== generatedMarkers[index])
  ) {
    issues.push({
      code: "marker_mismatch",
      detail: "Generated note added, removed, duplicated, or renumbered a screenshot marker",
    });
  }

  const sourceAnchors = new Set(factualAnchorsIn(source));
  const unsupportedAnchors = factualAnchorsIn(generated)
    .filter((anchor) => !sourceAnchors.has(anchor));
  if (unsupportedAnchors.length > 0) {
    issues.push({
      code: "unsupported_anchor",
      detail: `Generated note introduced numbers or acronyms absent from the transcript: ${unsupportedAnchors.slice(0, 8).join(", ")}`,
    });
  }

  const paragraphs = trimmed.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    if (/^#{1,6}\s/.test(paragraph.trim())) continue;
    const words = wordsIn(paragraph);
    const sentenceBoundaries = paragraph.match(/[.!?](?:\s|$)/g)?.length ?? 0;
    if (words.length >= 300 && sentenceBoundaries * 100 < words.length) {
      issues.push({
        code: "runaway_paragraph",
        detail: `Paragraph contains ${words.length} words with only ${sentenceBoundaries} sentence boundaries`,
      });
      break;
    }
  }

  const sourceWords = Math.max(wordsIn(source).length, 1);
  const generatedWords = wordsIn(generated).length;
  if (generatedWords >= 300 && generatedWords > sourceWords * 3) {
    issues.push({
      code: "excessive_expansion",
      detail: `Generated note expands ${sourceWords} source words into ${generatedWords} words`,
    });
  }

  return issues;
}

export function shouldUseLosslessFallback(issues: NoteQualityIssue[]): boolean {
  return issues.some(({ code }) =>
    code === "empty" || code === "truncated" || code === "marker_mismatch"
  );
}
