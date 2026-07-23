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
