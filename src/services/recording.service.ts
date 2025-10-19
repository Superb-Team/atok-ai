import { invoke } from '@tauri-apps/api/core';
import { downloadDir } from '@tauri-apps/api/path';

export class RecordingService {
  private static currentRecordingPath: string | null = null;

  /**
   * Start recording microphone + desktop audio
   * @returns Path to the output file
   */
  static async startRecording(): Promise<string> {
    try {
      // Get Downloads folder path
      const downloads = await downloadDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputPath = `${downloads}atok-recording-${timestamp}.wav`;
      
      console.log('🎙️ Starting recording to:', outputPath);
      
      // Call Tauri command to start recording
      await invoke('start_desktop_recording', { outputPath });
      
      this.currentRecordingPath = outputPath;
      console.log('✅ Recording started successfully');
      
      return outputPath;
    } catch (error) {
      console.error('❌ Failed to start recording:', error);
      throw new Error(`Failed to start recording: ${error}`);
    }
  }

  /**
   * Stop the current recording
   * @returns Path to the saved recording file
   */
  static async stopRecording(): Promise<string> {
    try {
      console.log('🛑 Stopping recording...');
      
      // Call Tauri command to stop recording
      await invoke('stop_desktop_recording');
      
      const savedPath = this.currentRecordingPath;
      this.currentRecordingPath = null;
      
      console.log('✅ Recording stopped successfully');
      
      if (!savedPath) {
        throw new Error('No recording path found');
      }
      
      return savedPath;
    } catch (error) {
      console.error('❌ Failed to stop recording:', error);
      throw new Error(`Failed to stop recording: ${error}`);
    }
  }

  /**
   * Check if currently recording
   */
  static async isRecording(): Promise<boolean> {
    try {
      const recording = await invoke<boolean>('is_recording');
      return recording;
    } catch (error) {
      console.error('❌ Failed to check recording status:', error);
      return false;
    }
  }

  /**
   * Get the current recording file path
   */
  static getCurrentRecordingPath(): string | null {
    return this.currentRecordingPath;
  }
}

export const recordingService = RecordingService;
