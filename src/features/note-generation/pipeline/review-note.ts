import { detailedChat } from "@/features/note-generation/api/ai";
import { assessGeneratedNote } from "@/features/note-generation/lib/note-quality";
import { reviewSystemPrompt } from "@/features/note-generation/lib/prompts";

// max_tokens only hurts when the model loops until it exhausts the budget
// (which has happened — that's why collapseRepeatedLines exists). Scale the
// budget to the input so a pathological loop on a short take can't burn the
// full 8192 tokens of generation time.
function maxTokensFor(input: string): number {
  return Math.min(8192, Math.max(1024, Math.ceil(input.length / 2)));
}

// Second "thinking" pass: an editor model fact-checks the draft against the
// transcript so unsupported claims and residual loops never reach the note.
// Best-effort — any failure or suspicious output falls back to the draft.
export async function reviewNote(transcript: string, draft: string, langName: string): Promise<string> {
  try {
    const result = await detailedChat(
      [
        { role: "system", content: reviewSystemPrompt(langName) },
        { role: "user", content: `TRANSCRIPT:\n${transcript}\n\nDRAFT:\n${draft}` },
      ],
      0,
      maxTokensFor(transcript + draft),
    );

    if (result.is_truncated) return draft;
    const reviewed = result.content;

    const trimmed = reviewed.trim();
    if (!trimmed || trimmed.length < draft.length * 0.3) return draft;
    if (assessGeneratedNote(transcript, trimmed, {
      isTruncated: false,
      requireUsefulTitle: /^#\s+.+$/m.test(draft),
    }).length > 0) return draft;
    return trimmed;
  } catch {
    return draft;
  }
}
