import type { RecordingNoteContext } from "../../recording/lib/recording-note-metadata.ts";

// ISO-639-1 → human name, used to pin the enhanced note to the recording's language.
export const LANGUAGE_NAMES: Record<string, string> = {
  id: "Bahasa Indonesia",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  es: "Spanish",
  ar: "Arabic",
};

export function noteSectionLabels(language: string) {
  if (language === "id") {
    return {
      summary: "Ringkasan",
      keyPoints: "Poin Utama",
      details: "Pembahasan",
      considerations: "Konteks & Pertimbangan",
      decisions: "Keputusan",
      actions: "Tindak Lanjut",
    };
  }
  return {
    summary: "Summary",
    keyPoints: "Key Points",
    details: "Discussion",
    considerations: "Context & Considerations",
    decisions: "Decisions",
    actions: "Action Items",
  };
}

export type NoteSectionLabels = ReturnType<typeof noteSectionLabels>;

export function recordingContextInstruction(context: RecordingNoteContext): string {
  return `Recording started at ${context.recordedAt} in timezone ${context.timezone}. Never treat this as spoken transcript content and do not put the date in the generated H1; the application appends the localized date deterministically.`;
}

// Map step: detailed notes for one section of a long recording. Deliberately
// NO title/summary/conclusions — the merge pass owns the final structure.
export function sectionNotesSystemPrompt(
  index: number,
  total: number,
  langName: string,
  hasMarkers: boolean,
): string {
  const markerRule = hasMarkers
    ? "\n- Keep every [[ATOK_ASSET_N]] marker exactly once, on its own line, at its current position — never rewrite, translate, renumber, or drop a marker"
    : "";
  return `You are an expert meeting-notes writer. You receive PART ${index + 1} of ${total} of one long recording's transcript. Write detailed notes for THIS PART ONLY — they will be merged with the other parts later.

RULES:
- ONLY use information actually in this part — never invent speakers, names, numbers, or content
- Capture EVERY clear point; preserve concrete specifics: numbers, dates, quantities, names, technical/product terms
- Preserve epistemic status exactly: distinguish reported progress from verified results, proposals from decisions, estimates from deadlines, and suspected causes from confirmed causes
- If someone says "should", "probably", "not checked", "dummy", "plan", "maybe", or an equivalent qualifier, keep that uncertainty; never upgrade it into a completed or confirmed fact
- Never infer an action owner from conversational proximity. Attribute an action only when the part explicitly identifies who owns it; otherwise label it unassigned
- When the speakers explicitly explain rationale, trade-offs, constraints, risks, or why an option was preferred, preserve that as context/consideration. Never infer hidden reasoning or motives.
- Do not speculate about the meaning of isolated or unclear words. Omit them instead of inventing a possible visual, positional, or situational context
- Write in ${langName}
- Ignore transcription-noise filler such as "thank you", "terima kasih", "like and subscribe" — that is leftover noise, not real content
- Never repeat the same bullet; never add meta commentary about transcript quality${markerRule}
- Output: markdown bullets grouped under short sub-headings. NO document title, NO summary, NO conclusions — raw material only.`;
}

export function globalReduceMessages(
  content: string,
  langName: string,
  language: string,
  context: RecordingNoteContext,
  final: boolean,
) {
  const instruction = final
    ? `Extract compact front matter for one meeting note in ${langName} as the JSON object required by the response schema.

Rules:
- title must be concrete, topic-specific, grounded in the source, and must not contain Markdown
- title states the meeting's main objective and represents 2-3 dominant themes, not one incidental detail
- title must be a complete phrase and must not end in a connector such as "and", "with", "mencakup", or "terkait"
- title_evidence contains 2-3 different exact, contiguous source spans supporting the dominant themes named by the title
- summary contains 3-5 concise sentences
- key_points and decisions contain atomic, non-duplicated, single-line strings
- action_items contains at most 15 atomic actions; never combine separate tasks, status, risks, discussion, or decisions into one action
- action must be concise and imperative
- evidence must be one exact, contiguous source substring that explicitly supports the action, owner, and deadline
- never infer an owner from conversational proximity; use "${language === "id" ? "Belum ditugaskan" : "Unassigned"}" unless the evidence explicitly names the owner
- use "${language === "id" ? "Tidak ditentukan" : "Not specified"}" unless the evidence explicitly states a committed deadline
- estimates such as "should finish this week", proposals, hopes, or availability are not deadlines
- omit unsupported decisions and actions instead of guessing
- preserve uncertainty exactly and never turn reported or unverified progress into confirmed results
- output JSON only; do not output Markdown or commentary

${recordingContextInstruction(context)}`
    : `Extract compact global facts from these sequential meeting-section notes in ${langName}. Return only concise markdown bullets grouped as Topics, Decisions, and Action Items. Preserve names, dates, numbers, owners, deadlines, and every uncertainty qualifier. Never turn a proposal, expectation, unverified report, estimate, or suspected cause into a decision or confirmed result. Never invent and do not reproduce detailed prose.`;
  return [
    { role: "system", content: instruction },
    { role: "user", content },
  ];
}

export function screenshotPromptRules(hasAssets: boolean): string {
  return hasAssets
      ? `
- The transcript contains markers like [[ATOK_ASSET_1]]: screenshots taken at that exact moment. Keep EVERY marker exactly once, on its own line, at the matching position in your note — never collect markers into one section at the end. Never rewrite, translate, renumber, or drop a marker.
- Use the provided "Screenshot contexts" to enrich the note (slide titles, numbers, diagrams), but only where the transcript supports it.`
    : "";
}

export function singlePassSystemPrompt(
  resolvedContext: RecordingNoteContext,
  langName: string,
  labels: NoteSectionLabels,
  screenshotRules: string,
): string {
  return `You are an expert meeting-notes writer. Turn this voice-recording transcript into a clean, well-structured, and COMPREHENSIVE note.

RECORDING METADATA:
${recordingContextInstruction(resolvedContext)}

RULES:
- ONLY use information actually in the transcript — never invent speakers, names, numbers, or content
- The transcript may be noisy/garbled in places: skip unintelligible parts, but capture EVERY clear point — do not over-summarize away real detail
- Preserve concrete specifics: numbers, dates, quantities, names, technical/product terms
- Do NOT list "Speaker (unnamed)" — just write the content
- Write the ENTIRE note (headings included) in ${langName}. Do not translate to another language.
- Ignore transcription-noise filler such as "thank you", "terima kasih", "like and subscribe" — that is leftover noise, not real content
- Never repeat the same bullet point or sentence. Each Key Point / Decision / Action Item must appear exactly once — if you notice you're about to restate something already written, stop that section instead
- Decisions and Action Items: max 15 items each, one line per item, ONLY things explicitly stated in the transcript. If you notice you are producing a repeating pattern of similar lines, STOP that section immediately
- If the transcript explicitly explains rationale, trade-offs, constraints, risks, or why an option was preferred, capture it once under "${labels.considerations}". Never invent hidden reasoning, motives, or causal links.
- Never append meta commentary, disclaimers, or notes about transcript quality or what you excluded — silently skip noise
- The first line must be a concise H1 describing the actual main topic. Never use generic titles or placeholders such as [Main Topic], [Tanggal], or [Date].
- Use the exact H2 headings "${labels.summary}", "${labels.keyPoints}", "${labels.details}", "${labels.considerations}", "${labels.decisions}", and "${labels.actions}" where they have real content.
- Under "${labels.details}", group the discussion beneath descriptive H3 sub-headings based on actual topics, projects, or people. Never use numbered labels such as "Section 1" or "Part 1".
- Omit sections with no real content. Never write empty sections or text saying that no items were found.${screenshotRules}

Do not create a "Transcript Lengkap" or "Complete Transcript" section. The canonical transcript is stored separately by the recorder.

The summary should be 3-5 sentences. Keep key points concise, but make the discussion comprehensive enough that every clear fact, status, concern, proposal, number, owner, deadline, and explicitly stated rationale remains represented exactly once.

If parts of the transcript are unintelligible, silently skip them and write the note from the clear parts only. Never state, imply, or apologize for the quality of the audio, the recording, or the transcript.`;
}

export function reviewSystemPrompt(langName: string): string {
  return `You are a meticulous fact-checking editor for meeting notes.
You receive a TRANSCRIPT and a DRAFT note. Return the corrected note and nothing else.

RULES:
- Remove every claim, name, number, or action item NOT supported by the transcript
- Preserve epistemic status: reported or unverified progress must not become confirmed; proposals must not become decisions; estimates must not become deadlines; suspected causes must not become confirmed causes
- Keep a Decisions section only for decisions or agreements explicitly present in the source
- Never infer an action owner from surrounding dialogue. Keep the owner unassigned unless the source explicitly identifies that person
- Remove duplicated or looping bullets — each point appears exactly once
- Keep every [[ATOK_ASSET_N]] marker exactly once, at its current position
- Keep the section structure and keep the note in ${langName}
- Do not add new content, commentary, or explanations of your edits
- Return ONLY the note itself — no closing remarks, no parenthetical notes about transcript quality or exclusions`;
}
