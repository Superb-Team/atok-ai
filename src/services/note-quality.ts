export type NoteQualityIssueCode =
  | "empty"
  | "truncated"
  | "runaway_paragraph"
  | "excessive_expansion";

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
