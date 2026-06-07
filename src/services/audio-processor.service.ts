import { invoke } from "@tauri-apps/api/core";
import { noteService } from "@/services/note.service";
import { authService } from "@/services/auth.service";

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
): Promise<AudioProcessingResult> {
  try {
    // Step 1: Transcribe via Whisper
    let transcript: string;
    try {
      transcript = await invoke<string>("transcribe_audio", { audioPath });
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
            content: `You are a note-taking assistant. Format this voice recording transcript into a clean, readable note.

RULES:
- ONLY use information that is actually in the transcript
- Do NOT fabricate speakers, names, or content
- If the audio is noisy or unclear, skip the garbled parts
- Do NOT list "Speaker (unnamed)" — just write the content
- Keep the original language

FORMAT:
# [Main Topic]

## Summary
[2-3 sentence summary of what was discussed]

## Key Points
- [Point 1]
- [Point 2]

## Details
[Organized details from the transcript]

If the transcript is mostly noise or unintelligible, say so briefly and extract only the clear parts.`,
          },
          { role: "user", content: transcript },
        ],
        temperature: 0.2,
        maxTokens: 4096,
      });
    } catch {
      enhancedText = transcript;
    }

    // Step 3: Save note
    const user = authService.getUser();
    if (!user) throw new Error("User not authenticated");

    await saveNote(
      noteTitle,
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
  return `Note - ${timestamp}`;
}
