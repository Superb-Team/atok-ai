import { detailedChat } from "@/features/note-generation/api/ai";
import { mapWithConcurrency } from "@/features/note-generation/lib/concurrency";
import {
  SECTION_MAX_CONCURRENT,
  type LongFormBudget,
} from "@/features/note-generation/lib/long-form-budget";
import {
  estimateTokenUpperBound,
  packByTokenBudget,
  splitTranscriptByTokenBudget,
  stripPlaceholderSections,
} from "@/features/note-generation/lib/long-form-processing";
import { assessGeneratedNote } from "@/features/note-generation/lib/note-quality";
import { globalReduceMessages } from "@/features/note-generation/lib/prompts";
import {
  parseStructuredGlobalNote,
  renderStructuredGlobalNote,
  STRUCTURED_GLOBAL_NOTE_RESPONSE_FORMAT,
} from "@/features/note-generation/lib/structured-global-note";
import type { RecordingNoteContext } from "@/features/recording/lib/recording-note-metadata";

export async function synthesizeGlobalNote(
  sectionNotes: string[],
  langName: string,
  language: string,
  context: RecordingNoteContext,
  budget: LongFormBudget,
): Promise<string> {
  const qualityCheckedChat = async (
    content: string,
    final: boolean,
  ): Promise<string> => {
    let lastIssues = "unknown";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await detailedChat(
          globalReduceMessages(content, langName, language, context, final),
          0.1,
          budget.globalOutputTokens,
          final ? STRUCTURED_GLOBAL_NOTE_RESPONSE_FORMAT : undefined,
        );
        const candidate = final
          ? renderStructuredGlobalNote(
              parseStructuredGlobalNote(result.content, content, language),
              language,
            )
          : result.content;
        const issues = assessGeneratedNote(content, candidate, {
          isTruncated: result.is_truncated,
          requireUsefulTitle: final,
        });
        if (issues.length === 0) return candidate;
        lastIssues = issues.map((issue) => issue.code).join(", ");
      } catch (error) {
        lastIssues = `invalid_structured_output: ${String(error)}`;
      }
      console.warn(JSON.stringify({
        event: "global_note_quality_retry",
        attempt,
        issues: lastIssues,
      }));
    }
    throw new Error(`Global reduction failed quality checks after retries: ${lastIssues}`);
  };

  let level = sectionNotes.flatMap((note, index) =>
    splitTranscriptByTokenBudget(`PART ${index + 1}\n${note}`, budget.maxReduceTokens)
      .map((section) => section.text),
  );

  if (estimateTokenUpperBound(level.join("\n\n")) <= budget.maxReduceTokens) {
    return stripPlaceholderSections(
      await qualityCheckedChat(level.join("\n\n"), true),
    );
  }

  for (let depth = 0; level.length > 1 && depth < 8; depth += 1) {
    const batches = packByTokenBudget(level, budget.maxReduceTokens);
    const nextLevel = await mapWithConcurrency(batches, SECTION_MAX_CONCURRENT, async (batch) => {
      return qualityCheckedChat(batch.join("\n\n"), false);
    });
    if (batches.length > 1 && nextLevel.length >= level.length) {
      throw new Error("Global reduction did not converge within its token budget");
    }
    level = nextLevel;
    if (batches.length === 1) break;
  }

  if (level.length > 1) {
    throw new Error("Global reduction exceeded maximum depth");
  }

  const source = level.join("\n\n");
  // The final front matter has already passed provider-side JSON Schema and
  // local evidence/shape validation. A free-form editor pass here could turn
  // the deterministic action table back into malformed prose, so only the
  // validated renderer is allowed to produce the final Markdown structure.
  return stripPlaceholderSections(await qualityCheckedChat(source, true));
}
