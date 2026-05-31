import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';

export class RecordingService {
  private static currentRecordingPath: string | null = null;

  /**
   * Get the recordings directory (cross-platform)
   */
  private static async getRecordingsDir(): Promise<string> {
    const appDir = await appDataDir();
    const recordingsDir = await join(appDir, 'recordings');
    return recordingsDir;
  }

  /**
   * Start recording microphone audio
   */
  static async startRecording(): Promise<string> {
    const recordingsDir = await this.getRecordingsDir();
    await invoke('ensure_recordings_dir', { path: recordingsDir });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = await join(recordingsDir, `recording-${timestamp}.mp3`);

    await invoke('start_desktop_recording', { outputPath });
    this.currentRecordingPath = outputPath;

    return outputPath;
  }

  /**
   * Stop the current recording
   */
  static async stopRecording(): Promise<string> {
    await invoke('stop_desktop_recording');

    const savedPath = this.currentRecordingPath;
    this.currentRecordingPath = null;

    if (!savedPath) {
      throw new Error('No recording path found');
    }

    return savedPath;
  }
}

export const recordingService = RecordingService;
