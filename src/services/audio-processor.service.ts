import { invoke } from "@tauri-apps/api/core";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import { noteAssetService, type RecordingAsset } from "@/services/note-asset.service";
import {
  composeLongFormNote,
  estimateTokenUpperBound,
  fingerprintText,
  packByTokenBudget,
  splitTranscriptByTokenBudget,
  type ProcessedSection,
} from "@/services/long-form-processing";
import { assessGeneratedNote } from "@/services/note-quality";
import { recordingProcessingGuard } from "@/services/recording-processing-guard";
import { shouldReviewGeneratedNote } from "@/services/processing-review-policy";

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

// max_tokens only hurts when the model loops until it exhausts the budget
// (which has happened — that's why collapseRepeatedLines exists). Scale the
// budget to the input so a pathological loop on a short take can't burn the
// full 8192 tokens of generation time.
function maxTokensFor(input: string): number {
  return Math.min(8192, Math.max(1024, Math.ceil(input.length / 2)));
}

// Parallel enough to cut wall time, low enough not to trip DeepInfra rate
// limits (same spirit as WHISPER_MAX_CONCURRENT on the backend).
const SECTION_MAX_CONCURRENT = 3;
const FALLBACK_CONTEXT_TOKENS = 32_768;
const FALLBACK_OUTPUT_TOKENS = 8_192;
const MAX_SECTION_SOURCE_TOKENS = 24_000;
const SECTION_OUTPUT_TOKENS = 4_096;
const GLOBAL_OUTPUT_TOKENS = 2_048;

interface ModelLimits {
  model: string;
  context_tokens: number;
  max_output_tokens: number;
  source: string;
}

interface ChatCompletionResult {
  request_id: string;
  content: string;
  finish_reason: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  continuation_count: number;
  is_truncated: boolean;
}

interface LongFormBudget {
  maxSourceTokens: number;
  maxReduceTokens: number;
  sectionOutputTokens: number;
  globalOutputTokens: number;
}

type ProcessingStatus = "transcribing" | "extracting" | "synthesizing" | "saving" | "complete" | "partial" | "failed";

interface ManifestSection {
  id: string;
  index: number;
  sourceHash: string;
  markdown: string;
  markers: string[];
  isDegraded: boolean;
  status: "complete" | "failed";
}

interface ProcessingManifest {
  schemaVersion: 1;
  jobId: string;
  audioPath: string;
  noteTitle: string;
  language: string;
  status: ProcessingStatus;
  transcript?: string;
  sections: ManifestSection[];
  savedNoteId?: number;
  failureNoteId?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

async function loadProcessingManifest(audioPath: string): Promise<ProcessingManifest | null> {
  const manifest = await invoke<ProcessingManifest | null>("load_processing_manifest", { audioPath })
    .catch(() => null);
  return manifest?.schemaVersion === 1 && manifest.audioPath === audioPath ? manifest : null;
}

async function saveProcessingManifest(manifest: ProcessingManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await invoke("save_processing_manifest", { audioPath: manifest.audioPath, manifest });
}

async function resolveLongFormBudget(): Promise<LongFormBudget> {
  const limits = await invoke<ModelLimits>("get_ai_model_limits").catch(() => ({
    model: "unknown",
    context_tokens: FALLBACK_CONTEXT_TOKENS,
    max_output_tokens: FALLBACK_OUTPUT_TOKENS,
    source: "frontend-fallback",
  }));
  const context = Math.max(4_096, limits.context_tokens);
  const sectionOutputTokens = Math.max(
    512,
    Math.min(SECTION_OUTPUT_TOKENS, limits.max_output_tokens, Math.floor(context / 4)),
  );
  const globalOutputTokens = Math.max(
    512,
    Math.min(GLOBAL_OUTPUT_TOKENS, limits.max_output_tokens, Math.floor(context / 4)),
  );
  const safety = Math.max(512, Math.floor(context * 0.1));
  const promptReserve = Math.max(1_024, Math.min(8_000, Math.floor(context * 0.2)));
  // The backend may continue a length-limited answer twice. Reserve all three
  // possible output windows so a continuation cannot push the request beyond
  // the advertised context size.
  const sectionAvailable = Math.max(
    512,
    context - (sectionOutputTokens * 3) - safety - promptReserve,
  );
  const reduceAvailable = Math.max(
    512,
    context - (globalOutputTokens * 3) - safety - promptReserve,
  );

  return {
    maxSourceTokens: Math.min(MAX_SECTION_SOURCE_TOKENS, sectionAvailable),
    maxReduceTokens: Math.min(20_000, reduceAvailable),
    sectionOutputTokens,
    globalOutputTokens,
  };
}

function detailedChat(
  messages: Array<{ role: string; content: string }>,
  temperature: number,
  maxTokens: number,
): Promise<ChatCompletionResult> {
  return invoke<ChatCompletionResult>("ai_chat_detailed", { messages, temperature, maxTokens });
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
  maxTokens: number,
): Promise<ChatCompletionResult> {
  const markerRule = hasMarkers
    ? "\n- Keep every [[ATOK_ASSET_N]] marker exactly once, on its own line, at its current position — never rewrite, translate, renumber, or drop a marker"
    : "";
  return detailedChat(
    [
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
    0.2,
    maxTokens,
  );
}

async function processSectionReliably(
  section: string,
  index: number,
  total: number,
  langName: string,
  hasMarkers: boolean,
  budget: LongFormBudget,
  depth = 0,
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
    if (qualityIssues.length === 0) {
      return { markdown: result.content, isDegraded: false };
    }

    if (depth < 4 && estimateTokenUpperBound(section) > 1_024) {
      const childBudget = Math.max(512, Math.floor(estimateTokenUpperBound(section) / 2));
      const children = splitTranscriptByTokenBudget(section, childBudget);
      if (children.length > 1) {
        const processed = await mapWithConcurrency(children, 2, (child, childIndex) =>
          processSectionReliably(
            child.text,
            childIndex,
            children.length,
            langName,
            child.markers.length > 0,
            budget,
            depth + 1,
          ),
        );
        return {
          markdown: processed.map((child) => child.markdown).join("\n\n"),
          isDegraded: processed.some((child) => child.isDegraded),
        };
      }
    }

    return { markdown: result.content || section, isDegraded: true };
  } catch {
    return { markdown: section, isDegraded: true };
  }
}

function globalReduceMessages(content: string, langName: string, final: boolean) {
  const instruction = final
    ? `Create the compact global front matter for one meeting note in ${langName}. Return ONLY markdown with: # title, ## Summary, ## Key Points, ## Decisions, and ## Action Items. Omit empty sections. Preserve concrete facts, deduplicate, never invent, and do not reproduce detailed section notes.`
    : `Extract compact global facts from these sequential meeting-section notes in ${langName}. Return only concise markdown bullets grouped as Topics, Decisions, and Action Items. Preserve names, dates, numbers, owners, and deadlines. Never invent and do not reproduce detailed prose.`;
  return [
    { role: "system", content: instruction },
    { role: "user", content },
  ];
}

async function synthesizeGlobalNote(
  sectionNotes: string[],
  langName: string,
  budget: LongFormBudget,
): Promise<string> {
  let level = sectionNotes.flatMap((note, index) =>
    splitTranscriptByTokenBudget(`PART ${index + 1}\n${note}`, budget.maxReduceTokens)
      .map((section) => section.text),
  );

  for (let depth = 0; level.length > 1 && depth < 8; depth += 1) {
    const batches = packByTokenBudget(level, budget.maxReduceTokens);
    const nextLevel = await mapWithConcurrency(batches, SECTION_MAX_CONCURRENT, async (batch) => {
      const result = await detailedChat(
        globalReduceMessages(batch.join("\n\n"), langName, false),
        0.1,
        budget.globalOutputTokens,
      );
      const issues = assessGeneratedNote(batch.join("\n\n"), result.content, {
        isTruncated: result.is_truncated,
      });
      if (issues.length > 0) {
        throw new Error(`Intermediate global reduction failed quality checks: ${issues.map((issue) => issue.code).join(", ")}`);
      }
      return result.content;
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
  const final = await detailedChat(
    globalReduceMessages(source, langName, true),
    0.1,
    budget.globalOutputTokens,
  );
  const finalIssues = assessGeneratedNote(source, final.content, {
    isTruncated: final.is_truncated,
  });
  if (finalIssues.length > 0) {
    throw new Error(`Global synthesis failed quality checks: ${finalIssues.map((issue) => issue.code).join(", ")}`);
  }
  return final.content;
}

export interface AudioProcessingResult {
  noteTitle: string;
  enhancedText: string;
  success: boolean;
  error?: string;
}

export function processAudioRecording(
  audioPath: string,
  noteTitle: string,
  language?: string,
): Promise<AudioProcessingResult> {
  return recordingProcessingGuard.run(audioPath, async () => {
    const runId = globalThis.crypto.randomUUID();
    const claimed = await invoke<boolean>("claim_processing_job", { audioPath, runId });
    if (!claimed) {
      return { noteTitle, enhancedText: "", success: true };
    }
    try {
      return await processAudioRecordingOnce(audioPath, noteTitle, language);
    } finally {
      await invoke("release_processing_job", { audioPath, runId }).catch(() => {});
    }
  });
}

async function processAudioRecordingOnce(
  audioPath: string,
  noteTitle: string,
  language?: string,
): Promise<AudioProcessingResult> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const mark = (stage: string, since: number) => {
    timings[stage] = Math.round(performance.now() - since);
  };
  let manifest: ProcessingManifest | null = null;
  try {
    // `??` not `||`: an explicit "" means AUTO-detect and must survive; only a
    // missing language (legacy handoff) falls back to Indonesian.
    const lang = language ?? "id";
    const langName = LANGUAGE_NAMES[lang] || "the same language as the transcript";
    manifest = await loadProcessingManifest(audioPath);
    if (!manifest) {
      const now = new Date().toISOString();
      manifest = {
        schemaVersion: 1,
        jobId: `job-${globalThis.crypto.randomUUID()}`,
        audioPath,
        noteTitle,
        language: lang,
        status: "transcribing",
        sections: [],
        createdAt: now,
        updatedAt: now,
      };
      await saveProcessingManifest(manifest);
    } else {
      manifest.noteTitle = noteTitle;
      manifest.language = lang;
    }

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
      transcript = manifest.transcript?.trim()
        ? manifest.transcript
        : await invoke<string>("transcribe_audio", { audioPath, language: lang });
      if (!transcript.trim()) {
        throw new Error("Transcription returned no usable text");
      }
      manifest.transcript = transcript;
      manifest.status = "extracting";
      manifest.error = undefined;
      await saveProcessingManifest(manifest);
    } catch (transcribeError) {
      manifest.status = "failed";
      manifest.error = String(transcribeError);
      await saveProcessingManifest(manifest).catch(() => {});
      const user = authService.getUser();
      if (!manifest.failureNoteId) {
        const failureNote = await saveNote(
          noteTitle,
          `[Voice recording - transcription failed]\n\nAudio: ${audioPath}\nError: ${transcribeError}`,
          ["voice-recording"],
          user?.id,
        );
        manifest.failureNoteId = failureNote.id;
        await saveProcessingManifest(manifest).catch(() => {});
      }
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

    // Step 2: every request is planned against a conservative token budget.
    // Long-form detail is assembled from bounded section outputs; only compact
    // global front matter goes through a hierarchical reduce.
    const budget = await resolveLongFormBudget();
    let usedMapReduce = estimateTokenUpperBound(userContent) > budget.maxSourceTokens;
    let processingDegraded = false;
    let processingError: string | undefined;
    const tEnhance = performance.now();
    let enhancedText: string;
    let reviewSource = markedTranscript;
    try {
      if (usedMapReduce) {
        const sections = splitTranscriptByTokenBudget(markedTranscript, budget.maxSourceTokens);
        console.log(`[audio-processor] map-reduce enhance: ${sections.length} sections`);
        manifest.status = "extracting";
        await saveProcessingManifest(manifest);
        let persistQueue = Promise.resolve();
        const processedSections = await mapWithConcurrency(sections, SECTION_MAX_CONCURRENT, async (section, i) => {
          const sourceHash = fingerprintText(`${lang}\0${section.text}`);
          const cached = manifest!.sections.find(
            (item) => item.id === section.id && item.sourceHash === sourceHash && item.status === "complete",
          );
          if (cached) {
            return {
              id: cached.id,
              index: cached.index,
              markdown: cached.markdown,
              markers: cached.markers,
              isDegraded: cached.isDegraded,
            } satisfies ProcessedSection;
          }

          const processed = await processSectionReliably(section.text, i, sections.length, langName, section.markers.length > 0, budget);
          const result = {
            id: section.id,
            index: section.index,
            markdown: collapseRepeatedLines(processed.markdown),
            markers: section.markers,
            isDegraded: processed.isDegraded,
          } satisfies ProcessedSection;
          const artifact: ManifestSection = {
            ...result,
            sourceHash,
            status: processed.isDegraded ? "failed" : "complete",
          };
          manifest!.sections = manifest!.sections.filter((item) => item.id !== artifact.id);
          manifest!.sections.push(artifact);
          const snapshot = structuredClone(manifest!);
          persistQueue = persistQueue.then(() => saveProcessingManifest(snapshot));
          await persistQueue;
          return result;
        });
        const sectionNotes = processedSections.map((section) => section.markdown);
        reviewSource = sectionNotes
          .map((note, i) => `--- PART ${i + 1} ---\n${note}`)
          .join("\n\n");
        let globalNote: string;
        manifest.status = "synthesizing";
        await saveProcessingManifest(manifest);
        try {
          const synthesisInputs = assetContext
            ? [...sectionNotes, `SCREENSHOT CONTEXT (supporting evidence only)\n${assetContext}`]
            : sectionNotes;
          globalNote = await synthesizeGlobalNote(synthesisInputs, langName, budget);
        } catch (globalError) {
          processingDegraded = true;
          processingError = `Global synthesis failed: ${String(globalError)}`;
          globalNote = `# ${noteTitle}\n\n## Summary\n\nLong recording processed into ${sections.length} detailed sections. Global synthesis could not be completed; all section content is preserved below.`;
        }
        enhancedText = composeLongFormNote(globalNote, processedSections);
      } else {
        const single = await detailedChat(
          [
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
          0.2,
          budget.sectionOutputTokens,
        );
        const singleIssues = assessGeneratedNote(markedTranscript, single.content, {
          isTruncated: single.is_truncated,
        });
        if (singleIssues.length > 0) {
          const recovered = await processSectionReliably(
            markedTranscript,
            0,
            1,
            langName,
            assets.length > 0,
            budget,
          );
          enhancedText = composeLongFormNote(
            `# ${noteTitle}\n\n## Summary\n\nThe detailed note is preserved below.`,
            [{
              id: "section-0001",
              index: 0,
              markdown: recovered.markdown,
              markers: markedTranscript.match(/\[\[ATOK_ASSET_\d+\]\]/g) ?? [],
              isDegraded: recovered.isDegraded,
            }],
          );
          processingDegraded = processingDegraded || recovered.isDegraded;
          if (recovered.isDegraded) {
            processingError = "Single-pass output was truncated and recursive recovery was incomplete";
          }
          usedMapReduce = true;
        } else {
          enhancedText = single.content;
        }
      }
    } catch (enhancementError) {
      processingDegraded = true;
      processingError = `Note enhancement failed: ${String(enhancementError)}`;
      enhancedText = `# ${noteTitle}\n\n> Note enhancement could not be completed. The complete raw transcript is preserved below.\n\n## Raw Transcript\n\n${markedTranscript}`;
    }
    mark("enhance", tEnhance);

    const collapsed = usedMapReduce ? enhancedText : collapseRepeatedLines(enhancedText);
    const loopSuspected = !usedMapReduce && collapsed !== enhancedText;
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
    if (shouldReviewGeneratedNote({
      processingDegraded,
      loopSuspected,
      usedMapReduce,
      transcriptLength: markedTranscript.length,
    })) {
      enhancedText = await reviewNote(reviewSource, enhancedText, langName);
      enhancedText = collapseRepeatedLines(enhancedText);
      mark("review", tReview);
    }
    enhancedText = stripMetaCommentary(enhancedText);
    if (assets.length > 0) {
      enhancedText = applyAssetMarkers(enhancedText, assets);
    }

    const finalQualityIssues = assessGeneratedNote(markedTranscript, enhancedText, {
      isTruncated: false,
    });
    if (finalQualityIssues.length > 0) {
      processingDegraded = true;
      processingError = `Generated note rejected by quality checks: ${finalQualityIssues.map((issue) => issue.code).join(", ")}`;
      enhancedText = `# ${noteTitle}\n\n> AI-generated formatting was rejected because it appeared incomplete or unreliable. The source transcript is preserved below for review.\n\n## Raw Transcript\n\n${markedTranscript}`;
    }

    // Step 3: Save note
    const tSave = performance.now();
    const user = authService.getUser();
    if (!user) throw new Error("User not authenticated");

    const finalTitle = deriveNoteTitle(enhancedText, transcript, noteTitle);
    const hasFailedSection = manifest.sections.some((section) => section.status === "failed");
    const needsReview = processingDegraded || hasFailedSection;

    manifest.status = "saving";
    await saveProcessingManifest(manifest);
    if (!manifest.savedNoteId) {
      const savedNote = await saveNote(
        finalTitle,
        enhancedText,
        ["voice-recording", "transcription", ...(needsReview ? ["needs-review"] : [])],
        user.id,
        manifest.jobId,
      );
      manifest.savedNoteId = savedNote.id;
      // Persist the note id before optional indexing so a crash cannot create a
      // duplicate note when this job resumes.
      await saveProcessingManifest(manifest);
    }

    // Step 4: Insert to RAG (optional, non-fatal)
    if (!needsReview) {
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
    }
    mark("save+rag", tSave);
    mark("total", t0);
    manifest.status = needsReview ? "partial" : "complete";
    manifest.error = manifest.status === "partial"
      ? processingError ?? "One or more transcript sections used a lossless fallback"
      : undefined;
    await saveProcessingManifest(manifest);
    console.log(`[audio-processor] timings(ms): ${JSON.stringify(timings)}`);

    return { noteTitle, enhancedText, success: true };
  } catch (error) {
    if (manifest) {
      manifest.status = "failed";
      manifest.error = String(error);
      await saveProcessingManifest(manifest).catch(() => {});
    }
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
  jobId?: string,
) {
  if (!userId) {
    const user = authService.getUser();
    if (!user) throw new Error("User not authenticated");
    userId = user.id;
  }
  const request = {
    title,
    content,
    tags,
    color: "#E0F2FE",
  };
  return jobId
    ? noteService.createRecordingNote(userId, jobId, request)
    : noteService.createNote(userId, request);
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
    const result = await detailedChat(
      [
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
      0,
      maxTokensFor(transcript + draft),
    );

    if (result.is_truncated) return draft;
    const reviewed = result.content;

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
