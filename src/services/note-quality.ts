import { isUsefulGroundedTitle } from "./recording-note-metadata.ts";

export type NoteQualityIssueCode =
  | "empty"
  | "truncated"
  | "runaway_paragraph"
  | "excessive_expansion"
  | "generation_artifact"
  | "repetition_loop"
  | "marker_mismatch"
  | "weak_title"
  | "malformed_action_items"
  | "oversized_action_item"
  | "too_many_action_items";

export interface NoteQualityIssue {
  code: NoteQualityIssueCode;
  detail: string;
}
interface CompletionState {
  isTruncated: boolean;
  requireUsefulTitle?: boolean;
}

function wordsIn(value: string): string[] {
  return value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function assetMarkersIn(value: string): string[] {
  return (value.match(/\[\[ATOK_ASSET_\d+\]\]/g) ?? []).sort();
}

function actionSectionLines(markdown: string): string[] | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) =>
    /^##\s+(?:Action Items|Tindak Lanjut)\s*$/iu.test(line.trim()));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^##\s+/u.test(lines[end].trim())) end += 1;
  return lines.slice(start + 1, end).map((line) => line.trim()).filter(Boolean);
}

function tableCells(line: string): string[] {
  const withoutEdges = line.replace(/^\s*\|/u, "").replace(/\|\s*$/u, "");
  return withoutEdges
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.replace(/\\\|/gu, "|").trim());
}

function assessActionItems(markdown: string): NoteQualityIssue[] {
  const lines = actionSectionLines(markdown);
  if (lines === null || lines.length === 0) return [];
  const tableMode = lines.some((line) => line.includes("|"));

  if (tableMode) {
    if (lines.length < 3 || lines.some((line) => !line.includes("|"))) {
      return [{
        code: "malformed_action_items",
        detail: "Action-item table contains prose outside its rows or is missing its header",
      }];
    }
    const rows = lines.map(tableCells);
    if (
      rows.some((cells) => cells.length !== 3) ||
      !rows[1].every((cell) => /^:?-{3,}:?$/u.test(cell))
    ) {
      return [{
        code: "malformed_action_items",
        detail: "Action-item table must contain exactly three columns",
      }];
    }
    const items = rows.slice(2);
    if (items.length > 15) {
      return [{
        code: "too_many_action_items",
        detail: `Action-item table contains ${items.length} rows; maximum is 15`,
      }];
    }
    for (const [index, cells] of items.entries()) {
      const [action, owner, deadline] = cells;
      if (!action || !owner || !deadline) {
        return [{
          code: "malformed_action_items",
          detail: `Action-item row ${index + 1} contains an empty cell`,
        }];
      }
      if (action.length > 240 || owner.length > 80 || deadline.length > 80) {
        return [{
          code: "oversized_action_item",
          detail: `Action-item row ${index + 1} exceeds its deterministic cell limit`,
        }];
      }
    }
    return [];
  }

  if (lines.some((line) => !/^(?:[-*+]|\d+[.)])\s+\S/u.test(line))) {
    return [{
      code: "malformed_action_items",
      detail: "Action items must be a Markdown table or one atomic bullet per line",
    }];
  }
  if (lines.length > 15) {
    return [{
      code: "too_many_action_items",
      detail: `Action-item list contains ${lines.length} items; maximum is 15`,
    }];
  }
  const oversizedIndex = lines.findIndex((line) => line.length > 320);
  return oversizedIndex >= 0
    ? [{
        code: "oversized_action_item",
        detail: `Action-item bullet ${oversizedIndex + 1} exceeds 320 characters`,
      }]
    : [];
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
  if (completion.requireUsefulTitle) {
    const title = trimmed.match(/^#\s+(.+)$/m)?.[1] ?? "";
    if (!isUsefulGroundedTitle(title, source)) {
      issues.push({
        code: "weak_title",
        detail: "Generated note title is generic, incomplete, or insufficiently grounded",
      });
    }
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
  issues.push(...assessActionItems(trimmed));

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
