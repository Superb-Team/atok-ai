import { invoke } from "@tauri-apps/api/core";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import { noteAssetService, type RecordingAsset } from "@/services/note-asset.service";

// ISO-639-1 → human name, used to pin the enhanced note to the recording's language.
const LANGUAGE_NAMES: Record<string, string> = {
  id: "Bahasa Indonesia",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  es: "Spanish",
  ar: "Arabic",
};

// ~6000 chars ≈ 10+ minutes of speech. Below this a clean draft skips the
// second review LLM pass entirely (it would double the post-stop wait).
const REVIEW_TRANSCRIPT_THRESHOLD = 6000;

// max_tokens only hurts when the model loops until it exhausts the budget
// (which has happened — that's why collapseRepeatedLines exists). Scale the
// budget to the input so a pathological loop on a short take can't burn the
// full 8192 tokens of generation time.
function maxTokensFor(input: string): number {
  return Math.min(8192, Math.max(1024, Math.ceil(input.length / 2)));
}

// Above this a single-shot enhance degrades on both axes: the model
// over-summarizes the middle of the transcript ("lost in the middle") and the
// output can silently hit the token cap. Long transcripts are split into
// sections, summarized in parallel, then merged.
const MAP_REDUCE_THRESHOLD = 16000;
const SECTION_TARGET_CHARS = 10000;
// Parallel enough to cut wall time, low enough not to trip DeepInfra rate
// limits (same spirit as WHISPER_MAX_CONCURRENT on the backend).
const SECTION_MAX_CONCURRENT = 3;

// Split at line boundaries first ([[ATOK_ASSET_N]] markers sit on their own
// lines) and sentence ends within oversized lines, so no sentence or marker is
// ever cut in half.
function splitTranscriptIntoSections(text: string): string[] {
  if (text.length <= SECTION_TARGET_CHARS) return [text];
  const units = text.split("\n").flatMap((line) => {
    if (line.length <= SECTION_TARGET_CHARS) return [line];
    return line.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [line];
  });

  const sections: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current && current.length + unit.length + 1 > SECTION_TARGET_CHARS) {
      sections.push(current.trim());
      current = unit;
    } else {
      current = current ? `${current}\n${unit}` : unit;
    }
  }
  if (current.trim()) sections.push(current.trim());
  return sections;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Map step: detailed notes for one section of a long recording. Deliberately
// NO title/summary/conclusions — the merge pass owns the final structure.
function summarizeSection(
  section: string,
  index: number,
  total: number,
  langName: string,
  hasMarkers: boolean,
): Promise<string> {
  const markerRule = hasMarkers
    ? "\n- Keep every [[ATOK_ASSET_N]] marker exactly once, on its own line, at its current position — never rewrite, translate, renumber, or drop a marker"
    : "";
  return invoke<string>("ai_chat", {
    messages: [
      {
        role: "system",
        content: `You are an expert meeting-notes writer. You receive PART ${index + 1} of ${total} of one long recording's transcript. Write detailed notes for THIS PART ONLY — they will be merged with the other parts later.

RULES:
- ONLY use information actually in this part — never invent speakers, names, numbers, or content
- Capture EVERY clear point; preserve concrete specifics: numbers, dates, quantities, names, technical/product terms
- Write in ${langName}
- Ignore transcription-noise filler such as "thank you", "terima kasih", "like and subscribe" — that is leftover noise, not real content
- Never repeat the same bullet; never add meta commentary about transcript quality${markerRule}
- Output: markdown bullets grouped under short sub-headings. NO document title, NO summary, NO conclusions — raw material only.`,
      },
      { role: "user", content: section },
    ],
    temperature: 0.2,
    maxTokens: maxTokensFor(section),
  });
}

// Reduce step: merge the per-section notes into the final note, same structure
// as the single-shot enhance so downstream (deriveNoteTitle, markers) is
// identical for both paths.
function mergeSectionNotes(
  sectionNotes: string,
  assetContext: string,
  screenshotRules: string,
  langName: string,
  hasAssets: boolean,
): Promise<string> {
  const userContent = hasAssets
    ? `Screenshot contexts (what was on screen at each marker):\n${assetContext}\n\nSection notes:\n${sectionNotes}`
    : sectionNotes;
  return invoke<string>("ai_chat", {
    messages: [
      {
        role: "system",
        content: `You are an expert meeting-notes editor. You receive sequential SECTION NOTES from ONE long recording. Merge them into a single clean, well-structured, COMPREHENSIVE note.

RULES:
- ONLY use information in the section notes — never invent content
- This is a merge, NOT a shorter summary: preserve the detail and concrete specifics from every part
- Deduplicate across parts — the same point/decision may appear in several parts; state each exactly once
- Write the ENTIRE note (headings included) in ${langName}. Do not translate to another language.
- Never append meta commentary, disclaimers, or notes about quality${screenshotRules}

FORMAT (omit any section with no real content — never write empty sections or filler):
# [Main Topic]

## Summary
[4-6 sentence overview of what was discussed and why]

## Key Points
- [the main points, one per bullet]

## Details
[Thorough walkthrough grouped by sub-topic, in the order things were discussed; keep the specifics]

## Decisions
- [decisions actually made, if any]

## Action Items
- [stated follow-ups — who / what / when, if any]`,
      },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    maxTokens: maxTokensFor(userContent),
  });
}

export interface AudioProcessingResult {
  noteTitle: string;
  enhancedText: string;
  success: boolean;
  error?: string;
}

export async function processAudioRecording(
  audioPath: string,
  noteTitle: string,
  language?: string,
): Promise<AudioProcessingResult> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const mark = (stage: string, since: number) => {
    timings[stage] = Math.round(performance.now() - since);
  };
  try {
    // `??` not `||`: an explicit "" means AUTO-detect and must survive; only a
    // missing language (legacy handoff) falls back to Indonesian.
    const lang = language ?? "id";
    const langName = LANGUAGE_NAMES[lang] || "the same language as the transcript";

    // Screenshots + vision descriptions only need audioPath, so run them
    // concurrently with Whisper instead of after it. Best-effort: any failure
    // resolves to null and the note simply has no assets.
    const assetsPromise = (async () => {
      const started = performance.now();
      const taken = await noteAssetService.takeRecordingAssets(audioPath);
      const descriptions = await Promise.all(
        taken.assets.map((a) =>
          invoke<string>("describe_image", { imagePath: a.path, language: langName })
            .catch(() => ""),
        ),
      );
      return { taken, descriptions, elapsed: Math.round(performance.now() - started) };
    })().catch((assetErr) => {
      console.error("Failed to load recording assets:", assetErr);
      return null;
    });

    // Step 1: Transcribe via Whisper (language pinned so quiet chunks don't drift)
    const tTranscribe = performance.now();
    let transcript: string;
    try {
      transcript = await invoke<string>("transcribe_audio", { audioPath, language: lang });
    } catch (transcribeError) {
      const user = authService.getUser();
      await saveNote(
        noteTitle,
        `[Voice recording - transcription failed]\n\nAudio: ${audioPath}\nError: ${transcribeError}`,
        ["voice-recording"],
        user?.id,
      );
      return {
        noteTitle,
        enhancedText: "",
        success: false,
        error: String(transcribeError),
      };
    }
    mark("transcribe", tTranscribe);

    // Step 1.5: anchor the screenshots into the transcript as short markers so
    // the note can reference what was on screen.
    let assets: RecordingAsset[] = [];
    let markedTranscript = transcript;
    let assetContext = "";
    const assetResult = await assetsPromise;
    if (assetResult) {
      timings["assets+vision"] = assetResult.elapsed;
      assets = assetResult.taken.assets;
      if (assets.length > 0) {
        markedTranscript = insertAssetMarkers(transcript, assets, assetResult.taken.duration_ms);
        assetContext = assets
          .map((a, i) =>
            `[[ATOK_ASSET_${i + 1}]] (screen at ${formatElapsed(a.elapsed_ms)})${assetResult.descriptions[i] ? `: ${assetResult.descriptions[i]}` : ""}`,
          )
          .join("\n");
      }
    }

    const screenshotRules = assets.length > 0
      ? `
- The transcript contains markers like [[ATOK_ASSET_1]]: screenshots taken at that exact moment. Keep EVERY marker exactly once, on its own line, at the matching position in your note — never collect markers into one section at the end. Never rewrite, translate, renumber, or drop a marker.
- Use the provided "Screenshot contexts" to enrich the note (slide titles, numbers, diagrams), but only where the transcript supports it.`
      : "";

    const userContent = assets.length > 0
      ? `Screenshot contexts (what was on screen at each marker):\n${assetContext}\n\nTranscript:\n${markedTranscript}`
      : transcript;

    // Step 2: Enhance transcript via AI chat. Long recordings go through
    // map-reduce: one giant single-shot call over-summarizes the middle of the
    // transcript AND takes minutes; per-section calls run in parallel and each
    // stays far under the output token cap.
    const usedMapReduce = markedTranscript.length > MAP_REDUCE_THRESHOLD;
    const tEnhance = performance.now();
    let enhancedText: string;
    let reviewSource = markedTranscript;
    try {
      if (usedMapReduce) {
        const sections = splitTranscriptIntoSections(markedTranscript);
        console.log(`[audio-processor] map-reduce enhance: ${sections.length} sections`);
        const sectionNotes = await mapWithConcurrency(sections, SECTION_MAX_CONCURRENT, (section, i) =>
          summarizeSection(section, i, sections.length, langName, assets.length > 0)
            // A failed section falls back to its raw transcript text so the
            // merge pass still sees that part of the meeting.
            .catch(() => section),
        );
        reviewSource = sectionNotes
          .map((note, i) => `--- PART ${i + 1} ---\n${note}`)
          .join("\n\n");
        enhancedText = await mergeSectionNotes(reviewSource, assetContext, screenshotRules, langName, assets.length > 0);
      } else {
        enhancedText = await invoke<string>("ai_chat", {
        messages: [
          {
            role: "system",
            content: `You are an expert meeting-notes writer. Turn this voice-recording transcript into a clean, well-structured, and COMPREHENSIVE note.

RULES:
- ONLY use information actually in the transcript — never invent speakers, names, numbers, or content
- The transcript may be noisy/garbled in places: skip unintelligible parts, but capture EVERY clear point — do not over-summarize away real detail
- Preserve concrete specifics: numbers, dates, quantities, names, technical/product terms
- Do NOT list "Speaker (unnamed)" — just write the content
- Write the ENTIRE note (headings included) in ${langName}. Do not translate to another language.
- Ignore transcription-noise filler such as "thank you", "terima kasih", "like and subscribe" — that is leftover noise, not real content
- Never repeat the same bullet point or sentence. Each Key Point / Decision / Action Item must appear exactly once — if you notice you're about to restate something already written, stop that section instead
- Decisions and Action Items: max 15 items each, one line per item, ONLY things explicitly stated in the transcript. If you notice you are producing a repeating pattern of similar lines, STOP that section immediately
- Never append meta commentary, disclaimers, or notes about transcript quality or what you excluded — silently skip noise${screenshotRules}

FORMAT (omit any section with no real content — never write empty sections or filler):
# [Main Topic]

## Summary
[3-5 sentence overview of what was discussed and why]

## Key Points
- [the main points, one per bullet]

## Details
[Thorough, organized walkthrough grouped by sub-topic; keep the specifics. Use sub-headings when there are distinct themes.]

## Decisions
- [decisions actually made, if any]

## Action Items
- [stated follow-ups — who / what / when, if any]

If the transcript is mostly noise or unintelligible, say so briefly and extract only the clear parts.`,
          },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        maxTokens: maxTokensFor(userContent),
        });
      }
    } catch {
      enhancedText = markedTranscript;
    }
    mark("enhance", tEnhance);

    const collapsed = collapseRepeatedLines(enhancedText);
    const loopSuspected = collapsed !== enhancedText;
    enhancedText = collapsed;

    // The review pass costs a full second non-streamed LLM round-trip, so only
    // run it where it earns its keep: the draft showed looping, or the
    // transcript is long enough that fact-check errors are likely. Short clean
    // takes skip it — the deterministic backstops below still always run.
    // The map-reduce path skips the length trigger entirely (its merge pass
    // already dedups/edits, and reviewing against the full transcript would
    // reintroduce the giant serial call map-reduce exists to avoid); if a loop
    // IS suspected there, the review runs against the bounded section notes.
    const tReview = performance.now();
    if (loopSuspected || (!usedMapReduce && markedTranscript.length > REVIEW_TRANSCRIPT_THRESHOLD)) {
      enhancedText = await reviewNote(reviewSource, enhancedText, langName);
      enhancedText = collapseRepeatedLines(enhancedText);
      mark("review", tReview);
    }
    enhancedText = stripMetaCommentary(enhancedText);
    if (assets.length > 0) {
      enhancedText = applyAssetMarkers(enhancedText, assets);
    }

    // Step 3: Save note
    const tSave = performance.now();
    const user = authService.getUser();
    if (!user) throw new Error("User not authenticated");

    const finalTitle = deriveNoteTitle(enhancedText, transcript, noteTitle);

    await saveNote(
      finalTitle,
      enhancedText,
      ["voice-recording", "transcription"],
      user.id,
    );

    // Step 4: Insert to RAG (optional, non-fatal)
    try {
      await invoke<boolean>("agent_insert_document", {
        userId: user.id,
        text: enhancedText,
        metadata: {
          type: "voice_recording",
          date: new Date().toISOString().split("T")[0],
          source: "whisper_transcription",
        },
      });
    } catch {
      // RAG insertion is optional — don't fail the workflow
    }
    mark("save+rag", tSave);
    mark("total", t0);
    console.log(`[audio-processor] timings(ms): ${JSON.stringify(timings)}`);

    return { noteTitle, enhancedText, success: true };
  } catch (error) {
    return {
      noteTitle,
      enhancedText: "",
      success: false,
      error: String(error),
    };
  }
}

async function saveNote(
  title: string,
  content: string,
  tags: string[],
  userId?: string,
) {
  if (!userId) {
    const user = authService.getUser();
    if (!user) throw new Error("User not authenticated");
    userId = user.id;
  }
  await noteService.createNote(userId, {
    title,
    content,
    tags,
    color: "#E0F2FE",
  });
}

// Place each screenshot marker at the word position proportional to when it was
// taken. Approximate by design (speech density varies), but lands the image in
// the right part of the conversation; the LLM keeps it on section boundaries.
export function insertAssetMarkers(
  transcript: string,
  assets: RecordingAsset[],
  durationMs: number,
): string {
  const words = transcript.split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationMs <= 0) {
    const markers = assets.map((_, i) => `[[ATOK_ASSET_${i + 1}]]`).join("\n");
    return `${transcript}\n\n${markers}`.trim();
  }

  const pieces: string[] = [];
  let cursor = 0;
  assets.forEach((asset, i) => {
    const ratio = Math.min(Math.max(asset.elapsed_ms / durationMs, 0), 1);
    const index = Math.min(Math.round(ratio * words.length), words.length);
    pieces.push(words.slice(cursor, index).join(" "));
    pieces.push(`\n\n[[ATOK_ASSET_${i + 1}]]\n\n`);
    cursor = Math.max(cursor, index);
  });
  pieces.push(words.slice(cursor).join(" "));
  return pieces.join(" ").replace(/[ \t]+\n/g, "\n").trim();
}

// Swap markers for image embeds; markers the LLM dropped are appended under a
// trailing "## Screenshots" section so no capture is ever lost.
export function applyAssetMarkers(text: string, assets: RecordingAsset[]): string {
  const used = new Set<number>();
  let result = text.replace(/\[\[ATOK_ASSET_(\d+)\]\]/g, (match, num: string) => {
    const idx = Number(num) - 1;
    const asset = assets[idx];
    if (!asset || used.has(idx)) return used.has(idx) ? "" : match;
    used.add(idx);
    return `![Screenshot ${formatElapsed(asset.elapsed_ms)}](${asset.path})`;
  });

  const missing = assets.filter((_, i) => !used.has(i));
  if (missing.length > 0) {
    const lines = missing
      .map((a) => `![Screenshot ${formatElapsed(a.elapsed_ms)}](${a.path})`)
      .join("\n\n");
    result = `${result.trimEnd()}\n\n## Screenshots\n\n${lines}\n`;
  }
  return result;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// Backstop for the model looping near the token budget: any content line seen
// more than twice in the WHOLE document is dropped, so repetition cycles of any
// length can't survive. Headings, blanks, and asset markers/embeds are exempt.
function collapseRepeatedLines(text: string): string {
  const MAX_REPEATS = 2;
  const counts = new Map<string, number>();
  const kept: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const exempt =
      trimmed === "" ||
      /^#{1,6}\s/.test(trimmed) ||
      trimmed.startsWith("![") ||
      trimmed.includes("[[ATOK_ASSET");
    if (exempt) {
      kept.push(line);
      continue;
    }

    const norm = trimmed.toLowerCase();
    const seen = (counts.get(norm) ?? 0) + 1;
    counts.set(norm, seen);
    if (seen <= MAX_REPEATS) kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

// Models sometimes close the note with a parenthesized editorial remark about
// transcript quality ("(Catatan: ...)"). That is meta-commentary, not content —
// drop such trailing paragraphs deterministically.
function stripMetaCommentary(text: string): string {
  const paragraphs = text.trimEnd().split(/\n{2,}/);
  while (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1].trim();
    const isMeta = /^\(\s*(catatan|note|nb)\b/i.test(last) && last.endsWith(")");
    if (!isMeta) break;
    paragraphs.pop();
  }
  return paragraphs.join("\n\n");
}

// Second "thinking" pass: an editor model fact-checks the draft against the
// transcript so unsupported claims and residual loops never reach the note.
// Best-effort — any failure or suspicious output falls back to the draft.
async function reviewNote(transcript: string, draft: string, langName: string): Promise<string> {
  try {
    const reviewed = await invoke<string>("ai_chat", {
      messages: [
        {
          role: "system",
          content: `You are a meticulous fact-checking editor for meeting notes.
You receive a TRANSCRIPT and a DRAFT note. Return the corrected note and nothing else.

RULES:
- Remove every claim, name, number, or action item NOT supported by the transcript
- Remove duplicated or looping bullets — each point appears exactly once
- Keep every [[ATOK_ASSET_N]] marker exactly once, at its current position
- Keep the section structure and keep the note in ${langName}
- Do not add new content, commentary, or explanations of your edits
- Return ONLY the note itself — no closing remarks, no parenthetical notes about transcript quality or exclusions`,
        },
        { role: "user", content: `TRANSCRIPT:\n${transcript}\n\nDRAFT:\n${draft}` },
      ],
      temperature: 0,
      maxTokens: maxTokensFor(transcript + draft),
    });

    const trimmed = reviewed.trim();
    if (!trimmed || trimmed.length < draft.length * 0.3) return draft;
    return trimmed;
  } catch {
    return draft;
  }
}

export function generateNoteTitle(): string {
  const now = new Date();
  const timestamp = now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `Recording - ${timestamp}`;
}

function deriveNoteTitle(enhancedText: string, transcript: string, fallbackTitle: string): string {
  const heading = enhancedText.match(/^#\s+(.+)$/m)?.[1];
  const firstMeaningfulLine = enhancedText
    .split("\n")
    .map((line) => cleanTitleCandidate(line))
    .find((line) => isUsefulTitle(line));
  const transcriptCandidate = cleanTitleCandidate(transcript).slice(0, 80);

  const title = [heading, firstMeaningfulLine, transcriptCandidate]
    .map((candidate) => cleanTitleCandidate(candidate ?? ""))
    .find((candidate) => isUsefulTitle(candidate));

  return title ? capRunawayTitle(title) : fallbackTitle;
}

// firstMeaningfulLine has no upper bound — if the transcript failed to enhance
// and came back as one unbroken line, that entire line (easily thousands of
// chars) would otherwise become the title. This only ever engages on that
// pathological case; real AI-generated headings are always well under this.
const MAX_TITLE_LENGTH = 120;

function capRunawayTitle(value: string): string {
  if (value.length <= MAX_TITLE_LENGTH) return value;
  const truncated = value.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated).trim();
}

function cleanTitleCandidate(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulTitle(value: string): boolean {
  if (value.length < 6) return false;
  const lower = value.toLowerCase();
  return ![
    "summary",
    "key points",
    "details",
    "transcript",
    "main topic",
  ].includes(lower);
}

