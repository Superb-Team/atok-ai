import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { appDataDir, join } from '@tauri-apps/api/path';

const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'm4a', 'flac', 'aac'];

export class AudioImportService {
  // Returns null if the user cancels the picker.
  static async pickAudioFile(): Promise<string | null> {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Audio', extensions: SUPPORTED_EXTENSIONS }],
    });
    return typeof selected === 'string' ? selected : null;
  }

  // Transcodes to MP3 in the recordings dir so it flows through transcribe_audio unchanged.
  static async importAudioFile(sourcePath: string): Promise<string> {
    const appDir = await appDataDir();
    const recordingsDir = await join(appDir, 'recordings');
    await invoke('ensure_recordings_dir', { path: recordingsDir });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = await join(recordingsDir, `imported-${timestamp}.mp3`);

    await invoke('import_audio_file', { sourcePath, outputPath });
    return outputPath;
  }
}

export const audioImportService = AudioImportService;
