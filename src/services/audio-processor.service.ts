import { invoke } from "@tauri-apps/api/core";
import { NoteConflictError, noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";
import type { Note } from "@/types/note.types";
import { noteAssetService, type RecordingAsset } from "@/services/note-asset.service";
import {
  composeLongFormNote,
  estimateTokenUpperBound,
  isUsableSectionBackedDraft,
  operationalSourceTokenBudget,
  packByTokenBudget,
  splitTranscriptByTokenBudget,
  stripPlaceholderSections,
  sectionSourceFingerprint,
  type ProcessedSection,
} from "@/services/long-form-processing";
import { assessGeneratedNote, shouldUseLosslessFallback } from "@/services/note-quality";
import { recordingProcessingGuard } from "@/services/recording-processing-guard";
import {
  buildLosslessStructuredFallback,
  isExtractiveFallbackNote,
} from "@/services/lossless-note-fallback";
import { stripTranscriptSection } from "@/services/canonical-transcript";
import {
  CURRENT_AI_PIPELINE_VERSION,
  CURRENT_TRANSCRIPTION_PIPELINE_VERSION,
  shouldRepairWithStructuredFallback,
  shouldPublishRecordingToRag,
  shouldOpenAiDraftPreview,
  shouldReviewGeneratedNote,
  shouldRefreshTranscript,
  shouldUpgradeExtractiveFallback,
} from "@/services/processing-review-policy";
import {
  deriveRecordingNoteTitle,
  inferRecordingNoteContext,
  replaceDocumentTitle,
  type RecordingNoteContext,
} from "@/services/recording-note-metadata";
import { appendTranscriptReviewSections } from "@/services/transcript-review-sections";

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

function noteSectionLabels(language: string) {
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

function recordingContextInstruction(context: RecordingNoteContext): string {
  return `Recording started at ${context.recordedAt} in timezone ${context.timezone}. Never treat this as spoken transcript content and do not put the date in the generated H1; the application appends the localized date deterministically.`;
}

// max_tokens only hurts when the model loops until it exhausts the budget
// (which has happened — that's why collapseRepeatedLines exists). Scale the
// budget to the input so a pathological loop on a short take can't burn the
// full 8192 tokens of generation time.
function maxTokensFor(input: string): number {
  return Math.min(8192, Math.max(1024, Math.ceil(input.length / 2)));
}

// Parallel enough to cut wall time, low enough not to trip DeepInfra rate
// limits (same spirit as WHISPER_MAX_CONCURRENT on the backend).
const SECTION_MAX_CONCURRENT = 2;
const FALLBACK_CONTEXT_TOKENS = 32_768;
const FALLBACK_OUTPUT_TOKENS = 8_192;
const MAX_SECTION_SOURCE_TOKENS = 24_000;
const SECTION_OUTPUT_TOKENS = 1_536;
const GLOBAL_OUTPUT_TOKENS = 1_536;

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
  estimated_cost: number;
  continuation_count: number;
  is_truncated: boolean;
}

interface LongFormBudget {
  model: string;
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
  generation: number;
  jobId: string;
  audioPath: string;
  noteTitle: string;
  language: string;
  recordedAt?: string;
  timezone?: string;
  status: ProcessingStatus;
  transcript?: string;
  transcriptionPipelineVersion?: number;
  transcriptRevisionId?: string;
  transcriptReviewIssues?: string[];
  enhancementStageKey?: string;
  sections: ManifestSection[];
  savedNoteId?: number;
  savedNoteUpdatedAt?: string;
  failureNoteId?: number;
  enhancementMode?: "ai" | "hybrid" | "extractive-fallback";
  fallbackVersion?: number;
  repairingFallback?: boolean;
  aiPipelineVersion?: number;
  upgradingAi?: boolean;
  timingsMs?: Record<string, number>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface TranscriptIntegrityReport {
  revisionId: string;
  transcriptSha256?: string;
  requiresReview: boolean;
  issues: Array<{ code: string; detail: string }>;
}

async function loadProcessingManifest(audioPath: string): Promise<ProcessingManifest | null> {
  const manifest = await invoke<ProcessingManifest | null>("load_processing_manifest", { audioPath })
    .catch(() => null);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.audioPath !== audioPath) return null;
  // Legacy v1 manifests predate compare-and-swap generations.
  manifest.generation ??= 0;
  return manifest;
}

async function saveProcessingManifest(manifest: ProcessingManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  const saved = await invoke<ProcessingManifest>("save_processing_manifest", {
    audioPath: manifest.audioPath,
    manifest,
  });
  manifest.generation = saved.generation;
  manifest.updatedAt = saved.updatedAt;
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
    model: limits.model,
    maxSourceTokens: operationalSourceTokenBudget(
      Math.min(MAX_SECTION_SOURCE_TOKENS, sectionAvailable),
    ),
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
- Preserve epistemic status exactly: distinguish reported progress from verified results, proposals from decisions, estimates from deadlines, and suspected causes from confirmed causes
- If someone says "should", "probably", "not checked", "dummy", "plan", "maybe", or an equivalent qualifier, keep that uncertainty; never upgrade it into a completed or confirmed fact
- Never infer an action owner from conversational proximity. Attribute an action only when the part explicitly identifies who owns it; otherwise label it unassigned
- When the speakers explicitly explain rationale, trade-offs, constraints, risks, or why an option was preferred, preserve that as context/consideration. Never infer hidden reasoning or motives.
- Do not speculate about the meaning of isolated or unclear words. Omit them instead of inventing a possible visual, positional, or situational context
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

    return { markdown: result.content, isDegraded: true };
  } catch {
    return { markdown: section, isDegraded: true };
  }
}

function globalReduceMessages(
  content: string,
  langName: string,
  language: string,
  context: RecordingNoteContext,
  final: boolean,
) {
  const labels = noteSectionLabels(language);
  const instruction = final
    ? `Create compact front matter for one meeting note in ${langName}. The first line must be one concrete, topic-specific H1 grounded in the source. Never use generic titles or template placeholders. Use H2 headings named "${labels.summary}", "${labels.keyPoints}", "${labels.considerations}", "${labels.decisions}", and "${labels.actions}". Use "${labels.considerations}" only when the source explicitly explains rationale, trade-offs, constraints, risks, or why an option was preferred; never infer hidden reasoning or motives. Omit empty sections completely; never emit placeholders such as "no decisions". Preserve concrete facts and uncertainty, deduplicate, never invent, and do not reproduce detailed section notes. Never turn a proposal, expectation, unverified report, estimate, or suspected cause into a decision or confirmed result. Put something under "${labels.decisions}" only when the source explicitly records agreement or a decision. ${recordingContextInstruction(context)}`
    : `Extract compact global facts from these sequential meeting-section notes in ${langName}. Return only concise markdown bullets grouped as Topics, Context/Considerations, Decisions, and Action Items. Preserve names, dates, numbers, owners, deadlines, and every uncertainty qualifier. Include a consideration only when the source explicitly explains rationale, trade-offs, constraints, risks, or why an option was preferred. Never infer hidden reasoning. Never turn a proposal, expectation, unverified report, estimate, or suspected cause into a decision or confirmed result. Never invent and do not reproduce detailed prose.`;
  return [
    { role: "system", content: instruction },
    { role: "user", content },
  ];
}

async function synthesizeGlobalNote(
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
    const result = await detailedChat(
      globalReduceMessages(content, langName, language, context, final),
      0.1,
      budget.globalOutputTokens,
    );
    const issues = assessGeneratedNote(content, result.content, {
      isTruncated: result.is_truncated,
    });
    if (issues.length === 0) return result.content;
    throw new Error(`Global reduction failed quality checks: ${issues.map((issue) => issue.code).join(", ")}`);
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
  return stripPlaceholderSections(await qualityCheckedChat(source, true));
}

export interface AudioProcessingResult {
  noteTitle: string;
  enhancedText: string;
  success: boolean;
  canonicalTranscript?: string;
  transcriptRevisionId?: string;
  warnings?: string[];
  outcome?: "note_created" | "draft_preview" | "no_speech" | "already_processing";
  message?: string;
  error?: string;
}

export interface AudioProcessingOptions {
  /** Re-run AI enhancement even when the manifest already reached the current version. */
  forceAiUpgrade?: boolean;
  /** Generate and validate content without saving the note or mutating the manifest. */
  previewOnly?: boolean;
}

export function processAudioRecording(
  audioPath: string,
  noteTitle: string,
  language?: string,
  context?: RecordingNoteContext,
  options: AudioProcessingOptions = {},
): Promise<AudioProcessingResult> {
  return recordingProcessingGuard.run(audioPath, async () => {
    const runId = globalThis.crypto.randomUUID();
    const claimed = await invoke<boolean>("claim_processing_job", { audioPath, runId });
    if (!claimed) {
      return { noteTitle, enhancedText: "", success: true, outcome: "already_processing" };
    }
    try {
      return await processAudioRecordingOnce(audioPath, noteTitle, language, context, options);
    } finally {
      await invoke("release_processing_job", { audioPath, runId }).catch(() => {});
    }
  }, { joinExisting: options.previewOnly !== true });
}

async function processAudioRecordingOnce(
  audioPath: string,
  noteTitle: string,
  language?: string,
  context?: RecordingNoteContext,
  options: AudioProcessingOptions = {},
): Promise<AudioProcessingResult> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const mark = (stage: string, since: number) => {
    timings[stage] = Math.round(performance.now() - since);
  };
  let manifest: ProcessingManifest | null = null;
  let repairWithStructuredFallback = false;
  let upgradeExtractiveFallback = false;
  let repairReason: string | undefined;
  const previewOnly = options.previewOnly === true;
  const forceAiUpgrade = options.forceAiUpgrade === true;
  const persistManifest = async () => {
    if (manifest && !previewOnly) await saveProcessingManifest(manifest);
  };
  const persistManifestBestEffort = async () => {
    if (manifest && !previewOnly) await saveProcessingManifest(manifest).catch(() => {});
  };
  try {
    // `??` not `||`: an explicit "" means AUTO-detect and must survive; only a
    // missing language (legacy handoff) falls back to Indonesian.
    const lang = language ?? "id";
    const langName = LANGUAGE_NAMES[lang] || "the same language as the transcript";
    manifest = await loadProcessingManifest(audioPath);
    const resolvedContext = context
      ?? (manifest?.recordedAt && manifest.timezone
        ? { recordedAt: manifest.recordedAt, timezone: manifest.timezone }
        : undefined)
      ?? inferRecordingNoteContext(audioPath)
      ?? {
        recordedAt: manifest?.createdAt ?? new Date().toISOString(),
        timezone: "UTC",
      };
    if (!manifest) {
      const now = new Date().toISOString();
      manifest = {
        schemaVersion: 1,
        generation: 0,
        jobId: `job-${globalThis.crypto.randomUUID()}`,
        audioPath,
        noteTitle,
        language: lang,
        recordedAt: resolvedContext.recordedAt,
        timezone: resolvedContext.timezone,
        status: "transcribing",
        sections: [],
        createdAt: now,
        updatedAt: now,
      };
      await persistManifest();
    } else {
      manifest.noteTitle = noteTitle;
      manifest.language = lang;
      manifest.recordedAt = resolvedContext.recordedAt;
      manifest.timezone = resolvedContext.timezone;
      if (forceAiUpgrade) {
        repairWithStructuredFallback = false;
        upgradeExtractiveFallback = true;
        manifest.repairingFallback = undefined;
        manifest.upgradingAi = true;
        manifest.error = undefined;
        // A forced upgrade must not reuse extractive or older model output.
        manifest.sections = [];
        await persistManifest();
      } else {
        repairWithStructuredFallback = shouldRepairWithStructuredFallback(
          manifest.status,
          manifest.savedNoteId,
          manifest.fallbackVersion,
          manifest.repairingFallback,
        );
        if (repairWithStructuredFallback) {
          repairReason = manifest.error;
          manifest.repairingFallback = true;
          await persistManifest();
        } else {
          upgradeExtractiveFallback = shouldUpgradeExtractiveFallback(
            manifest.status,
            manifest.enhancementMode,
            manifest.aiPipelineVersion,
          );
          if (upgradeExtractiveFallback) {
            manifest.upgradingAi = true;
            // Cached section output belongs to an older prompt/model policy.
            manifest.sections = [];
            await persistManifest();
          }
        }
      }
    }

    const refreshTranscript = shouldRefreshTranscript(manifest.transcriptionPipelineVersion);
    if (refreshTranscript) {
      // Transcript changes invalidate every derived section. The sidecar is the
      // durable source; cached note sections must never mix with a new run.
      manifest.transcript = undefined;
      manifest.transcriptRevisionId = undefined;
      manifest.transcriptReviewIssues = undefined;
      manifest.enhancementStageKey = undefined;
      manifest.sections = [];
      await persistManifest();
    }

    // Screenshots + vision descriptions only need audioPath, so run them
    // concurrently with Whisper instead of after it. Best-effort: any failure
    // resolves to null and the note simply has no assets.
    const assetsPromise = (async () => {
      const started = performance.now();
      const taken = await noteAssetService.takeRecordingAssets(audioPath);
      const descriptions = await mapWithConcurrency(taken.assets, 2, async (a) => {
        try {
          return repairWithStructuredFallback
            ? ""
            : await invoke<string>("describe_image", { imagePath: a.path, language: langName });
        } catch {
          return "";
        }
      });
      return { taken, descriptions, elapsed: Math.round(performance.now() - started) };
    })().catch((assetErr) => {
      console.error("Failed to load recording assets:", assetErr);
      return null;
    });

    // Step 1: Transcribe via Whisper (language pinned so quiet chunks don't drift)
    const tTranscribe = performance.now();
    let transcript: string;
    let transcriptRequiresReview = false;
    let transcriptReviewIssues: string[] = [];
    try {
      transcript = !refreshTranscript && manifest.transcript?.trim()
        ? manifest.transcript
        : await invoke<string>("transcribe_audio", {
          audioPath,
          language: lang,
          forceRefresh: refreshTranscript,
        });
      if (!transcript.trim()) {
        // Silence/background noise is a successful transcription outcome, not
        // an infrastructure failure. Keep the recording, finish the manifest,
        // and skip note generation so no empty or scary "failure note" appears.
        await assetsPromise;
        manifest.transcript = "";
        manifest.transcriptionPipelineVersion = CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
        manifest.status = "complete";
        manifest.error = undefined;
        manifest.timingsMs = {
          ...timings,
          transcribe: Math.round(performance.now() - tTranscribe),
          total: Math.round(performance.now() - t0),
        };
        await persistManifest();
        return {
          noteTitle,
          enhancedText: "",
          success: true,
          outcome: "no_speech",
          message: lang === "id"
            ? "Rekaman tersimpan, tetapi tidak ada percakapan yang terdeteksi. Periksa microphone yang dipilih lalu coba lagi."
            : "The recording was saved, but no speech was detected. Check the selected microphone and try again.",
        };
      }
      manifest.transcript = transcript;
      manifest.transcriptionPipelineVersion = CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
      const integrity = await invoke<TranscriptIntegrityReport>("evaluate_transcript_integrity", {
        audioPath,
        transcript,
      }).catch((error) => ({
        revisionId: "unavailable",
        requiresReview: true,
        issues: [{
          code: "integrity_evaluation_failed",
          detail: `Transcript integrity evaluation failed: ${String(error)}`,
        }],
      }));
      transcriptRequiresReview = integrity.requiresReview;
      transcriptReviewIssues = integrity.issues.map((issue) => `${issue.code}: ${issue.detail}`);
      manifest.transcriptRevisionId = integrity.revisionId;
      manifest.transcriptReviewIssues = transcriptReviewIssues;
      const enhancementStageKey = `note:${CURRENT_AI_PIPELINE_VERSION}:${lang}:${integrity.revisionId}`;
      if (manifest.enhancementStageKey && manifest.enhancementStageKey !== enhancementStageKey) {
        manifest.sections = [];
      }
      manifest.enhancementStageKey = enhancementStageKey;
      manifest.status = repairWithStructuredFallback ? "partial" : "extracting";
      if (!repairWithStructuredFallback) manifest.error = undefined;
      await persistManifest();
    } catch (transcribeError) {
      manifest.status = "failed";
      manifest.error = String(transcribeError);
      await persistManifestBestEffort();
      const user = authService.getUser();
      console.error(JSON.stringify({
        event: "recording_transcription_failed",
        jobId: manifest.jobId,
        reason: "provider_or_capture_error",
        error: String(transcribeError),
      }));
      if (!previewOnly && !manifest.failureNoteId) {
        const failureContent = lang === "id"
          ? `# ${noteTitle}\n\n## Pemrosesan rekaman tertunda\n\nRekaman sudah tersimpan, tetapi transkripsinya belum selesai. Audio dan status pemrosesan tetap dipertahankan agar dapat dicoba lagi.`
          : `# ${noteTitle}\n\n## Recording processing pending\n\nThe recording was saved, but transcription did not finish. The audio and processing state were retained so it can be retried.`;
        const failureNote = await saveNote(
          noteTitle,
          failureContent,
          ["voice-recording", "transcription", "needs-review"],
          user?.id,
        );
        manifest.failureNoteId = failureNote.id;
        await persistManifestBestEffort();
      }
      return {
        noteTitle,
        enhancedText: "",
        success: false,
        error: previewOnly
          ? "The recording transcript could not be verified; the original note was kept."
          : String(transcribeError),
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
    const budget = repairWithStructuredFallback ? {
      model: "deterministic-fallback",
      maxSourceTokens: MAX_SECTION_SOURCE_TOKENS,
      maxReduceTokens: 20_000,
      sectionOutputTokens: SECTION_OUTPUT_TOKENS,
      globalOutputTokens: GLOBAL_OUTPUT_TOKENS,
    } : await resolveLongFormBudget();
    let usedMapReduce = !repairWithStructuredFallback &&
      estimateTokenUpperBound(userContent) > budget.maxSourceTokens;
    let processingDegraded = false;
    let usedStructuredFallback = false;
    let processingError: string | undefined;
    const tEnhance = performance.now();
    let enhancedText: string;
    let reviewSource = markedTranscript;
    const labels = noteSectionLabels(lang);
    try {
      if (repairWithStructuredFallback) {
        processingDegraded = true;
        usedStructuredFallback = true;
        processingError = repairReason ?? "Previous AI enhancement did not complete";
        enhancedText = buildLosslessStructuredFallback(noteTitle, markedTranscript, lang);
      } else if (usedMapReduce) {
        const sections = splitTranscriptByTokenBudget(markedTranscript, budget.maxSourceTokens);
        console.log(`[audio-processor] map-reduce enhance: ${sections.length} sections`);
        manifest.status = "extracting";
        await persistManifest();
        let persistQueue = Promise.resolve();
        const processedSections = await mapWithConcurrency(sections, SECTION_MAX_CONCURRENT, async (section, i) => {
          const sourceHash = sectionSourceFingerprint(
            `${CURRENT_AI_PIPELINE_VERSION}:${budget.model}`,
            lang,
            section.text,
          );
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
          // Save the latest shared manifest at queue execution time. Persisting
          // snapshots created by concurrent workers would make generation CAS
          // reject valid section progress as stale.
          persistQueue = persistQueue.then(() => persistManifest());
          await persistQueue;
          return result;
        });
        const sectionNotes = processedSections.map((section) => section.markdown);
        reviewSource = sectionNotes
          .map((note, i) => `--- PART ${i + 1} ---\n${note}`)
          .join("\n\n");
        let globalNote: string;
        manifest.status = "synthesizing";
        await persistManifest();
        try {
          const synthesisInputs = assetContext
            ? [...sectionNotes, `SCREENSHOT CONTEXT (supporting evidence only)\n${assetContext}`]
            : sectionNotes;
          globalNote = await synthesizeGlobalNote(
            synthesisInputs,
            langName,
            lang,
            resolvedContext,
            budget,
          );
        } catch (globalError) {
          const sectionBackedDraft = isUsableSectionBackedDraft(processedSections);
          processingDegraded = !sectionBackedDraft;
          processingError = sectionBackedDraft
            ? undefined
            : `Global synthesis failed: ${String(globalError)}`;
          globalNote = `# ${noteTitle}`;
          console.warn(JSON.stringify({
            event: "recording_global_synthesis_fallback",
            jobId: manifest.jobId,
            sectionBackedDraft,
            reason: String(globalError),
          }));
        }
        enhancedText = composeLongFormNote(globalNote, processedSections, lang);
      } else {
        const single = await detailedChat(
          [
            {
            role: "system",
            content: `You are an expert meeting-notes writer. Turn this voice-recording transcript into a clean, well-structured, and COMPREHENSIVE note.

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
            `# ${noteTitle}\n\n## ${labels.summary}\n\n${lang === "id" ? "Detail catatan dipertahankan di bawah." : "The detailed note is preserved below."}`,
            [{
              id: "section-0001",
              index: 0,
              markdown: recovered.markdown,
              markers: markedTranscript.match(/\[\[ATOK_ASSET_\d+\]\]/g) ?? [],
              isDegraded: recovered.isDegraded,
            }],
            lang,
          );
          processingDegraded = processingDegraded || recovered.isDegraded;
          if (recovered.isDegraded) {
            processingError = "Single-pass output did not pass deterministic quality checks";
          }
          usedMapReduce = true;
        } else {
          enhancedText = single.content;
        }
      }
    } catch (enhancementError) {
      processingDegraded = true;
      usedStructuredFallback = true;
      processingError = `Note enhancement failed: ${String(enhancementError)}`;
      enhancedText = buildLosslessStructuredFallback(noteTitle, markedTranscript, lang);
      console.warn(JSON.stringify({
        event: "recording_enhancement_fallback",
        jobId: manifest.jobId,
        stage: "enhance",
        reason: "provider_error",
      }));
    }
    mark("enhance", tEnhance);

    const collapsed = usedMapReduce ? enhancedText : collapseRepeatedLines(enhancedText);
    const loopSuspected = !usedMapReduce && collapsed !== enhancedText;
    enhancedText = collapsed;

    // A second provider pass is reserved for an actual repetition loop.
    // Length alone is not a reason to double the request count; deterministic
    // source and structure checks still run for every draft below.
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
    enhancedText = stripPlaceholderSections(stripMetaCommentary(enhancedText));

    // A provider can return a previous degraded artifact as ordinary text
    // without throwing. Treat that as degraded too; otherwise preview mode
    // could present the old extractive note as a successful AI draft.
    if (isExtractiveFallbackNote(enhancedText)) {
      processingDegraded = true;
      usedStructuredFallback = true;
      processingError = "AI returned an extractive fallback artifact";
      enhancedText = buildLosslessStructuredFallback(noteTitle, markedTranscript, lang);
    }

    const finalQualityIssues = assessGeneratedNote(markedTranscript, enhancedText, {
      isTruncated: false,
    });
    if (finalQualityIssues.length > 0) {
      processingDegraded = true;
      processingError = `Generated note rejected by quality checks: ${finalQualityIssues.map((issue) => issue.code).join(", ")}`;
      if (!previewOnly && shouldUseLosslessFallback(finalQualityIssues)) {
        usedStructuredFallback = true;
        enhancedText = buildLosslessStructuredFallback(noteTitle, markedTranscript, lang);
      }
    }

    if (transcriptRequiresReview && transcriptReviewIssues.length > 0) {
      enhancedText = appendTranscriptReviewSections(enhancedText, transcriptReviewIssues, lang);
    }

    // Keep semantic markers in the quality-gate input. Convert them to local
    // image embeds only after validation, otherwise the gate sees every embed
    // as a missing marker and forces a needless extractive fallback.
    if (assets.length > 0) {
      enhancedText = applyAssetMarkers(enhancedText, assets);
    }

    // Derive the title from the structured draft only.
    const finalTitle = deriveRecordingNoteTitle(
      // A deterministic/extractive fallback is not a title source. Its first
      // sentence is often a greeting or a fragment, which previously became
      // titles such as “Oh, gue putus-putus, Kak.”.
      usedStructuredFallback ? "" : enhancedText,
      transcript,
      noteTitle,
      resolvedContext,
      lang,
    );
    enhancedText = stripTranscriptSection(enhancedText);
    enhancedText = replaceDocumentTitle(enhancedText, finalTitle);
    const hasFailedSection = manifest.sections.some((section) => section.status === "failed");
    const needsReview = processingDegraded || hasFailedSection || transcriptRequiresReview;

    if (previewOnly) {
      const previewWarnings = [
        ...finalQualityIssues.map((issue) => `${issue.code}: ${issue.detail}`),
        ...(hasFailedSection ? ["Satu atau lebih bagian memakai transcript sumber karena hasil AI bagian tersebut tidak lolos validasi."] : []),
        ...transcriptReviewIssues,
      ];
      if (!shouldOpenAiDraftPreview(enhancedText.trim().length > 0, usedStructuredFallback)) {
        const reason = usedStructuredFallback
          ? `AI provider gagal menghasilkan draft yang dapat direview${processingError ? `: ${processingError}` : "."}`
          : "AI menghasilkan draft kosong.";
        return {
          noteTitle: finalTitle,
          enhancedText: "",
          success: false,
          error: reason,
        };
      }
      return {
        noteTitle: finalTitle,
        enhancedText,
        success: true,
        canonicalTranscript: transcript,
        transcriptRevisionId: manifest.transcriptRevisionId,
        warnings: previewWarnings,
        outcome: "draft_preview",
        message: "AI draft passed transcript and quality checks; review it before saving.",
      };
    }

    // Step 3: Save note
    const tSave = performance.now();
    const user = authService.getUser();
    if (!user) throw new Error("User not authenticated");

    manifest.status = "saving";
    await persistManifest();
    let noteWasManuallyEdited = false;
    if (!manifest.savedNoteId) {
      const savedNote = await saveNote(
        finalTitle,
        enhancedText,
        ["voice-recording", "transcription", ...(needsReview ? ["needs-review"] : [])],
        user.id,
        manifest.jobId,
        resolvedContext,
      );
      manifest.savedNoteId = savedNote.id;
      manifest.savedNoteUpdatedAt = savedNote.updated_at;
      // Persist the note id before optional indexing so a crash cannot create a
      // duplicate note when this job resumes.
      await persistManifest();
    } else if (manifest.savedNoteUpdatedAt) {
      try {
        const savedNote = await noteService.updateNote(manifest.savedNoteId, user.id, {
          title: finalTitle,
          content: enhancedText,
          tags: ["voice-recording", "transcription", ...(needsReview ? ["needs-review"] : [])],
          expected_updated_at: manifest.savedNoteUpdatedAt,
        });
        manifest.savedNoteUpdatedAt = savedNote.updated_at;
      } catch (error) {
        if (!(error instanceof NoteConflictError)) throw error;
        noteWasManuallyEdited = true;
        console.warn(JSON.stringify({
          event: "recording_note_manual_edit_preserved",
          jobId: manifest.jobId,
          noteId: manifest.savedNoteId,
        }));
      }
    } else {
      // Older manifests do not contain the version that was originally saved.
      // Updating them blindly could erase a user's later manual edits.
      noteWasManuallyEdited = true;
      console.warn(JSON.stringify({
        event: "recording_note_legacy_version_unknown",
        jobId: manifest.jobId,
        noteId: manifest.savedNoteId,
      }));
    }

    // Step 4: Insert to RAG (optional, non-fatal)
    if (shouldPublishRecordingToRag({
      processingDegraded,
      hasFailedSection,
      transcriptRequiresReview,
      noteWasManuallyEdited,
    })) {
      try {
        await invoke<boolean>("agent_insert_document", {
          userId: user.id,
          text: enhancedText,
          metadata: {
            type: "voice_recording",
            date: resolvedContext.recordedAt.split("T")[0],
            recorded_at: resolvedContext.recordedAt,
            timezone: resolvedContext.timezone,
            source: "whisper_transcription",
            note_id: manifest.savedNoteId,
            note_updated_at: manifest.savedNoteUpdatedAt,
          },
        });
      } catch {
        // RAG insertion is optional — don't fail the workflow
      }
    }
    mark("save+rag", tSave);
    mark("total", t0);
    manifest.enhancementMode = usedStructuredFallback
      ? "extractive-fallback"
      : processingDegraded ? "hybrid" : "ai";
    if (usedStructuredFallback) manifest.fallbackVersion = 1;
    manifest.repairingFallback = undefined;
    manifest.aiPipelineVersion = CURRENT_AI_PIPELINE_VERSION;
    manifest.upgradingAi = undefined;
    manifest.timingsMs = timings;
    manifest.status = needsReview ? "partial" : "complete";
    manifest.error = manifest.status === "partial"
      ? processingError ?? "One or more transcript sections used a lossless fallback"
      : undefined;
    await persistManifest();
    console.log(JSON.stringify({
      event: "recording_processing_completed",
      jobId: manifest.jobId,
      status: manifest.status,
      enhancementMode: manifest.enhancementMode,
      timingsMs: timings,
    }));

    return { noteTitle: finalTitle, enhancedText, success: true, outcome: "note_created" };
  } catch (error) {
    if (manifest) {
      manifest.status = "failed";
      manifest.error = String(error);
      await persistManifestBestEffort();
    }
    return {
      noteTitle,
      enhancedText: "",
      success: false,
      error: previewOnly
        ? "AI draft generation failed; the original note was kept."
        : String(error),
    };
  }
}

export interface AudioDraftCommitInput {
  audioPath: string;
  noteId: number;
  noteTitle: string;
  content: string;
  expectedUpdatedAt: string;
  canonicalTranscript: string;
  transcriptRevisionId?: string;
  tags?: string[];
}

/**
 * Accept a previously previewed AI draft with note-level compare-and-swap.
 * The preview itself never writes state; this is the only explicit commit
 * path, and it also retires the extractive fallback manifest after success.
 */
export function commitAudioRecordingDraft(input: AudioDraftCommitInput): Promise<Note> {
  return recordingProcessingGuard.run(input.audioPath, async () => {
    const runId = globalThis.crypto.randomUUID();
    const claimed = await invoke<boolean>("claim_processing_job", {
      audioPath: input.audioPath,
      runId,
    });
    if (!claimed) throw new Error("This recording is still being processed. Try again in a moment.");

    try {
      const manifest = await loadProcessingManifest(input.audioPath);
      if (!manifest || manifest.savedNoteId !== input.noteId) {
        throw new Error("The recording source for this note is no longer available.");
      }

      const user = authService.getUser();
      if (!user) throw new Error("User not authenticated");

      const updated = await noteService.updateNote(input.noteId, user.id, {
        title: input.noteTitle,
        content: input.content,
        tags: input.tags?.filter((tag) => tag !== "needs-review"),
        expected_updated_at: input.expectedUpdatedAt,
      });

      manifest.noteTitle = input.noteTitle;
      manifest.savedNoteUpdatedAt = updated.updated_at;
      manifest.transcript = input.canonicalTranscript;
      manifest.transcriptionPipelineVersion = CURRENT_TRANSCRIPTION_PIPELINE_VERSION;
      manifest.transcriptRevisionId = input.transcriptRevisionId;
      manifest.enhancementStageKey = `note:${CURRENT_AI_PIPELINE_VERSION}:${manifest.language}:${input.transcriptRevisionId ?? "unknown"}`;
      manifest.sections = [];
      manifest.enhancementMode = "ai";
      manifest.fallbackVersion = undefined;
      manifest.repairingFallback = undefined;
      manifest.aiPipelineVersion = CURRENT_AI_PIPELINE_VERSION;
      manifest.upgradingAi = undefined;
      manifest.transcriptReviewIssues = undefined;
      manifest.status = "complete";
      manifest.error = undefined;
      try {
        await saveProcessingManifest(manifest);
      } catch (error) {
        // The note is already protected by CAS and saved. A manifest sync
        // failure should not make the UI report a failed note update; log it so
        // the next explicit regeneration can repair the sidecar.
        console.error(JSON.stringify({
          event: "recording_ai_draft_manifest_sync_failed",
          jobId: manifest.jobId,
          noteId: input.noteId,
          reason: String(error),
        }));
      }

      if (manifest.transcript?.trim()) {
        try {
          await invoke<boolean>("agent_insert_document", {
            userId: user.id,
            text: input.content,
            metadata: {
              type: "voice_recording",
              date: manifest.recordedAt?.split("T")[0] ?? new Date().toISOString().split("T")[0],
              recorded_at: manifest.recordedAt,
              timezone: manifest.timezone,
              source: "whisper_transcription",
              note_id: manifest.savedNoteId,
              note_updated_at: updated.updated_at,
            },
          });
        } catch {
          // RAG indexing is optional and must not undo an accepted note.
        }
      }

      return updated;
    } finally {
      await invoke("release_processing_job", {
        audioPath: input.audioPath,
        runId,
      }).catch(() => {});
    }
  }, { joinExisting: false });
}

async function saveNote(
  title: string,
  content: string,
  tags: string[],
  userId?: string,
  jobId?: string,
  context?: RecordingNoteContext,
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
    recorded_at: context?.recordedAt,
    recording_timezone: context?.timezone,
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
- Preserve epistemic status: reported or unverified progress must not become confirmed; proposals must not become decisions; estimates must not become deadlines; suspected causes must not become confirmed causes
- Keep a Decisions section only for decisions or agreements explicitly present in the source
- Never infer an action owner from surrounding dialogue. Keep the owner unassigned unless the source explicitly identifies that person
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
    if (assessGeneratedNote(transcript, trimmed, { isTruncated: false }).length > 0) return draft;
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
