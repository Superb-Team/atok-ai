export type NoteQualityIssueCode =
  | "empty"
  | "truncated"
  | "runaway_paragraph"
  | "excessive_expansion"
  | "generation_artifact"
  | "repetition_loop"
  | "marker_mismatch";

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

  if (/\b(?:stop|continue) generating\b|\bas an ai\b|\*\(stop generating filler\)\*|\s->\s/iu.test(trimmed)) {
    issues.push({
      code: "generation_artifact",
      detail: "Generated note contains model-control commentary or continuation artifacts",
    });
  }
  if (/\b([\p{L}\p{N}_-]{3,})\b(?:[\s,;:*-]+\1\b){2,}/iu.test(trimmed)) {
    issues.push({
      code: "repetition_loop",
      detail: "Generated note repeats the same token at least three times consecutively",
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
