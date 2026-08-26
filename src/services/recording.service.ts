import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import {
  createRecordingNoteContext,
  type RecordingNoteContext,
} from '@/services/recording-note-metadata';
import { requiresCaptureReview } from '@/services/recording-quality-policy';

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

export interface AudioQualityReport {
  schemaVersion: number;
  createdAt: string;
  sampleRate: number;
  outputChannels: number;
  micSampleRate: number;
  micChannels: number;
  windows: AudioQualityWindow[];
  sourceArtifacts: AudioSourceArtifact[];
  warnings: string[];
  micDroppedBytes?: number;
  requiresReview: boolean;
}

export { blockingQualityWarnings, requiresCaptureReview } from '@/services/recording-quality-policy';

export function qualityReportRequiresReview(
  report: Pick<AudioQualityReport, 'requiresReview' | 'warnings'> | null | undefined,
): boolean {
  return requiresCaptureReview(report?.requiresReview ?? false, report?.warnings ?? []);
}

export interface AudioQualityWindow {
  chunkIndex: number;
  startMs: number;
  endMs: number;
  micClippedRatio: number;
  micRmsDbfs: number;
  systemRmsDbfs: number;
  mixedRmsDbfs: number;
  mixedClippedRatio: number;
  micBytes: number;
  systemBytes: number;
}

export interface AudioSourceArtifact {
  kind: string;
  chunkIndex: number;
  relativePath: string;
  sha256: string;
  bytes: number;
  sampleRate: number;
  channels: number;
}

export interface ProcessingJobSummary {
  schemaVersion: number;
  jobId: string;
  audioPath: string;
  noteTitle: string;
  language: string;
  status: 'transcribing' | 'extracting' | 'synthesizing' | 'saving' | 'complete' | 'partial' | 'failed';
  updatedAt: string;
  recordedAt?: string;
  timezone?: string;
  savedNoteId?: number;
  enhancementMode?: 'ai' | 'hybrid' | 'extractive-fallback';
  fallbackVersion?: number;
  repairingFallback?: boolean;
  aiPipelineVersion?: number;
  upgradingAi?: boolean;
  transcriptionPipelineVersion?: number;
  transcript?: string;
}

export interface RecordingStartInfo extends RecordingNoteContext {
  audioPath: string;
}

export class RecordingService {
  private static currentRecordingPath: string | null = null;

  /**
   * Get the recordings directory (cross-platform)
   */
  static async getRecordingsDir(): Promise<string> {
    const appDir = await appDataDir();
    const recordingsDir = await join(appDir, 'recordings');
    return recordingsDir;
  }

  static async listProcessingJobs(): Promise<ProcessingJobSummary[]> {
    return invoke<ProcessingJobSummary[]>('list_processing_manifests', {
      directory: await this.getRecordingsDir(),
    });
  }

  static async saveGlossary(audioPath: string, glossary: string[]): Promise<void> {
    await invoke('save_recording_glossary', { audioPath, terms: glossary });
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

  static async getQualityReport(audioPath: string): Promise<AudioQualityReport | null> {
    return await invoke<AudioQualityReport | null>('get_recording_quality_report', { audioPath });
  }

  /**
   * Start recording microphone audio
   * AEC is now read from the backend's in-memory AEC_ENABLED static.
   * `language` is an ISO-639-1 code (e.g. "id", "en") pinned for Whisper so quiet
   * chunks don't get misdetected into the wrong language during transcription.
   */
  static async startRecording(
    micDevice?: string,
    language?: string,
    glossary: string[] = [],
  ): Promise<RecordingStartInfo> {
    const recordingsDir = await this.getRecordingsDir();
    await invoke('ensure_recordings_dir', { path: recordingsDir });

    const context = createRecordingNoteContext();
    const timestamp = context.recordedAt.replace(/[:.]/g, '-');
    const outputPath = await join(recordingsDir, `recording-${timestamp}.mp3`);

    await invoke('start_desktop_recording', {
      outputPath,
      micDevice: micDevice ?? null,
      language: language ?? 'id',
      glossary,
    });
    this.currentRecordingPath = outputPath;

    return { audioPath: outputPath, ...context };
  }

  /**
   * Path of the in-progress recording, if any (used to attach screenshots).
   */
  static getCurrentRecordingPath(): string | null {
    return this.currentRecordingPath;
  }

  static async setPaused(paused: boolean): Promise<void> {
    await invoke('set_desktop_recording_paused', { paused });
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
