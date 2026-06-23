import { invoke } from "@tauri-apps/api/core";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";

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

export interface AudioProcessingResult {
  noteTitle: string;
  enhancedText: string;
  success: boolean;
  error?: string;
}

/**
 * Audio processing workflow:
 * 1. Transcribe audio via Groq Whisper (backend)
 * 2. Enhance transcript via DeepInfra chat (backend)
 * 3. Save as note
 * 4. Insert into RAG (optional)
 */
export async function processAudioRecording(
  audioPath: string,
  noteTitle: string,
  language?: string,
): Promise<AudioProcessingResult> {
  try {
    // `??` not `||`: an explicit "" means AUTO-detect and must survive; only a
    // missing language (legacy handoff) falls back to Indonesian.
    const lang = language ?? "id";
    const langName = LANGUAGE_NAMES[lang] || "the same language as the transcript";

    // Step 1: Transcribe via Whisper (language pinned so quiet chunks don't drift)
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

    // Step 2: Enhance transcript via AI chat
    let enhancedText: string;
    try {
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
          { role: "user", content: transcript },
        ],
        temperature: 0.2,
        maxTokens: 8192,
      });
    } catch {
      enhancedText = transcript;
    }

    // Step 3: Save note
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

  return title ? truncateTitle(title) : fallbackTitle;
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

function truncateTitle(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69).trim()}...` : value;
}
