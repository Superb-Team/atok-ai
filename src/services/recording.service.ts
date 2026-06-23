import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';

export interface DeviceStatus {
  mic_available: boolean;
  mic_name: string | null;
  mic_display_name: string | null;
  system_audio_available: boolean;
  system_audio_name: string | null;
  system_audio_display_name: string | null;
}

export interface AudioDeviceInfo {
  raw_name: string;
  display_name: string;
  device_type: 'mic' | 'system';
  is_default: boolean;
}

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
   * List all available audio input devices.
   * Returns structured device info sorted with default first.
   */
  static async listInputDevices(): Promise<AudioDeviceInfo[]> {
    return await invoke<AudioDeviceInfo[]>('list_audio_input_devices');
  }

  /**
   * Get mic + system audio availability status.
   */
  static async getDeviceStatus(): Promise<DeviceStatus> {
    return await invoke<DeviceStatus>('get_audio_device_status');
  }

  /**
   * Start recording microphone audio
   * AEC is now read from the backend's in-memory AEC_ENABLED static.
   * `language` is an ISO-639-1 code (e.g. "id", "en") pinned for Whisper so quiet
   * chunks don't get misdetected into the wrong language during transcription.
   */
  static async startRecording(micDevice?: string, language?: string): Promise<string> {
    const recordingsDir = await this.getRecordingsDir();
    await invoke('ensure_recordings_dir', { path: recordingsDir });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = await join(recordingsDir, `recording-${timestamp}.mp3`);

    await invoke('start_desktop_recording', {
      outputPath,
      micDevice: micDevice ?? null,
      language: language ?? 'id',
    });
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
