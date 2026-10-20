import { debug, error, info, warn } from "@tauri-apps/plugin-log";

type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | null | undefined>;

const backendSinks = { debug, info, warn, error };

// Every event goes to the backend log file (JSON lines, shared with Rust logs)
// and to the devtools console. `event` is a stable dot-separated name such as
// "recording.transcription_failed"; put variable data in `fields`, never in
// the name. Never pass secrets, transcripts or note content as fields.
function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  const keyValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) keyValues[key] = String(value);
  }
  console[level](event, fields);
  // Logging must never break the caller, including outside the Tauri webview.
  backendSinks[level](event, { keyValues }).catch(() => {});
}

export const logger = {
  debug: (event: string, fields?: LogFields) => write("debug", event, fields),
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};

const MAX_ERROR_LENGTH = 500;

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}
