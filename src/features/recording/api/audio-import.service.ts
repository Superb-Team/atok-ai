import { invokeCommand } from '@/lib/ipc';
import { open } from '@tauri-apps/plugin-dialog';
import { appDataDir, join } from '@tauri-apps/api/path';
import { authService } from '@/features/auth/api/auth.service';
import { claimProcessingJob, loadProcessingManifest, saveProcessingManifest } from '@/features/note-generation/api/processing-manifest';
import { recordingService } from './recording.service';
import { persistImportedJob } from '../lib/persist-import-job';
import { prepareImportJob, resetImportRetryBudget } from '../lib/prepare-import-job';
import type { RecordingNoteContext } from '../lib/recording-note-metadata';

const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'm4a', 'flac', 'aac'];

async function releaseImportClaim(path: string, runId: string): Promise<void> {
  const released = await invokeCommand<boolean>('release_processing_job', { audioPath: path, runId });
  if (!released) throw new Error('The import ownership claim could not be released.');
}

export class AudioImportService {
  static async pickAudioFile(): Promise<string | null> {
    const selected = await open({ multiple: false, filters: [{ name: 'Audio', extensions: SUPPORTED_EXTENSIONS }] });
    return typeof selected === 'string' ? selected : null;
  }

  static async allocateImportPath(): Promise<string> {
    const recordingsDir = await join(await appDataDir(), 'recordings');
    await invokeCommand('ensure_recordings_dir', { path: recordingsDir });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return join(recordingsDir, `imported-${timestamp}-${globalThis.crypto.randomUUID()}.mp3`);
  }

  static async queueImportedAudio(sourcePath: string, audioPath: string, noteTitle: string, language: string,
    glossary: string[], context: RecordingNoteContext, userId: string): Promise<void> {
    await persistImportedJob({ sourcePath, audioPath, noteTitle, language, glossary, context, userId }, {
      claim: claimProcessingJob,
      load: loadProcessingManifest,
      save: saveProcessingManifest,
      currentUserId: () => authService.getUser()?.id,
      release: releaseImportClaim,
    });
    window.dispatchEvent(new Event('audio-import-queued'));
  }

  static async prepareQueuedImport(audioPath: string, userId: string): Promise<boolean> {
    const runId = globalThis.crypto.randomUUID();
    if (!await claimProcessingJob(audioPath, runId)) return false;
    try {
      return await prepareImportJob(audioPath, userId, {
        load: loadProcessingManifest,
        save: saveProcessingManifest,
        saveGlossary: recordingService.saveGlossary,
        currentUserId: () => authService.getUser()?.id,
        resume: async (sourcePath, outputPath) => {
          await invokeCommand('resume_audio_import', { sourcePath, outputPath });
        },
      });
    } finally {
      await releaseImportClaim(audioPath, runId);
    }
  }

  static async retryImport(audioPath: string, userId: string): Promise<void> {
    const runId = globalThis.crypto.randomUUID();
    if (!await claimProcessingJob(audioPath, runId)) throw new Error('This recording is still processing.');
    try {
      const manifest = await loadProcessingManifest(audioPath);
      if (!manifest || manifest.source !== 'import' || manifest.ownerUserId !== userId || authService.getUser()?.id !== userId) {
        throw new Error('Sign in to the account that imported this recording.');
      }
      if (!resetImportRetryBudget(manifest)) return;
      await saveProcessingManifest(manifest);
    } finally {
      await releaseImportClaim(audioPath, runId);
    }
    window.dispatchEvent(new Event('audio-import-queued'));
  }
}

export const audioImportService = AudioImportService;
