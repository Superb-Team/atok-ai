import { invoke } from '@tauri-apps/api/core';
import { noteService } from '@/services/note.service';
import { authService } from '@/services/auth.service';

export interface AudioProcessingResult {
  noteTitle: string;
  enhancedText: string;
  success: boolean;
  error?: string;
}

/**
 * Audio processing workflow:
 * 1. Transcribe audio via DeepInfra Whisper (backend)
 * 2. Enhance transcript via DeepInfra chat (backend)
 * 3. Save as note
 */
export async function processAudioRecording(
  audioPath: string,
  noteTitle: string
): Promise<AudioProcessingResult> {
  console.log('Starting audio processing...');

  try {
    // Step 1: Transcribe via Whisper
    console.log('Step 1: Transcribing via Whisper...');
    let transcript: string;
    try {
      transcript = await invoke<string>('transcribe_audio', { audioPath });
      console.log('Transcription completed:', transcript.length, 'chars');
    } catch (transcribeError) {
      console.warn('Transcription failed:', transcribeError);
      const user = authService.getUser();
      await saveNote(noteTitle, `[Voice recording - transcription failed]\n\nAudio: ${audioPath}\nError: ${transcribeError}`, ['voice-recording'], user?.id);
      return { noteTitle, enhancedText: '', success: false, error: String(transcribeError) };
    }

    // Step 2: Enhance transcript via AI chat
    console.log('Step 2: Enhancing transcript...');
    let enhancedText: string;
    try {
      enhancedText = await invoke<string>('ai_chat', {
        messages: [
          {
            role: 'system',
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
          {
            role: 'user',
            content: transcript,
          },
        ],
        temperature: 0.2,
        maxTokens: 4096,
      });
      console.log('Enhancement completed:', enhancedText.length, 'chars');
    } catch (enhanceError) {
      console.warn('Enhancement failed, using raw transcript:', enhanceError);
      enhancedText = transcript;
    }

    // Step 3: Save note
    console.log('Step 3: Saving note...');
    const user = authService.getUser();
    if (!user) throw new Error('User not authenticated');

    await saveNote(noteTitle, enhancedText, ['voice-recording', 'transcription'], user.id);

    // Step 4: Insert to RAG (optional, non-fatal)
    try {
      await invoke<boolean>('agent_insert_document', {
        userId: user.id,
        text: enhancedText,
        metadata: {
          type: 'voice_recording',
          date: new Date().toISOString().split('T')[0],
          source: 'whisper_transcription',
        },
      });
      console.log('Inserted to RAG');
    } catch (ragError) {
      console.warn('RAG insert failed (non-fatal):', ragError);
    }

    console.log('Audio processing completed!');
    return { noteTitle, enhancedText, success: true };

  } catch (error) {
    console.error('Failed to process recording:', error);
    return { noteTitle, enhancedText: '', success: false, error: String(error) };
  }
}

async function saveNote(title: string, content: string, tags: string[], userId?: string) {
  if (!userId) {
    const user = authService.getUser();
    if (!user) throw new Error('User not authenticated');
    userId = user.id;
  }
  await noteService.createNote(userId, { title, content, tags, color: '#E0F2FE' });
}

export function generateNoteTitle(): string {
  const now = new Date();
  const timestamp = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `Note - ${timestamp}`;
}
