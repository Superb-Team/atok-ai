import { detailedChat, type ChatCompletionResult } from "@/features/note-generation/api/ai";
import type { LongFormBudget } from "@/features/note-generation/lib/long-form-budget";
import { assessGeneratedNote, hasBlockingDefect } from "@/features/note-generation/lib/note-quality";
import { sectionNotesSystemPrompt } from "@/features/note-generation/lib/prompts";

function summarizeSection(
  section: string,
  index: number,
  total: number,
  langName: string,
  hasMarkers: boolean,
  maxTokens: number,
): Promise<ChatCompletionResult> {
  return detailedChat(
    [
      { role: "system", content: sectionNotesSystemPrompt(index, total, langName, hasMarkers) },
      { role: "user", content: section },
    ],
    0.2,
    maxTokens,
  );
}

export async function processSectionReliably(
  section: string,
  index: number,
  total: number,
  langName: string,
  hasMarkers: boolean,
  budget: LongFormBudget,
): Promise<{ markdown: string; isDegraded: boolean }> {
  try {
    const result = await summarizeSection(
      section,
      index,
      total,
      langName,
      hasMarkers,
      budget.sectionOutputTokens,
    );
    const qualityIssues = assessGeneratedNote(section, result.content, {
      isTruncated: result.is_truncated,
    });
    // Judged against a narrow slice, so only structural defects degrade a section.
    return { markdown: result.content, isDegraded: hasBlockingDefect(qualityIssues) };
  } catch {
    return { markdown: section, isDegraded: true };
  }
}
