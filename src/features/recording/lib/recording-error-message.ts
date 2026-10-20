export function importPreparationErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/no such file|not found|original imported file path is missing/i.test(raw)) {
    return "The source audio could not be found. Restore it to its original location, then use Retry. If the file moved, import it again.";
  }
  if (/disk full|no space|permission denied|hard link|hard_link|publish/i.test(raw)) {
    return "The audio could not be saved. Check free disk space, folder permissions and filesystem support, then use Retry.";
  }
  if (/decode|codec|corrupt|truncat|invalid|unsupported|empty|audio.*limit/i.test(raw)) {
    return "The audio format could not be read completely. Choose a valid MP3, WAV, M4A, FLAC or AAC file. Your source file was kept.";
  }
  return "The import could not continue. Its queue entry was kept; check the source file and storage, then use Retry.";
}

export function recordingProcessingErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const normalized = raw.replace(/^Error:\s*/i, "").trim();

  if (/no speech|no usable text|transcription returned empty/i.test(normalized)) {
    return "The recording was saved, but no speech was detected. Check the selected microphone and try again.";
  }
  if (/api.?key|not configured|unauthorized|status 401|status 403/i.test(normalized)) {
    return "Transcription is not configured correctly. Check the transcription service credentials in Settings.";
  }
  if (/network|timed? out|timeout|connection|dns|request failed/i.test(normalized)) {
    return "The recording was saved, but transcription could not connect to the service. Check your connection and try again.";
  }

  return "The recording was saved, but the note could not be processed. You can retry it from the recording later.";
}
