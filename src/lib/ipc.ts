import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { errorMessage, logger } from "./logger.ts";

// Must match REQUEST_ID_HEADER in src-tauri/src/logging.rs.
const REQUEST_ID_HEADER = "x-request-id";

/**
 * Calls a Tauri command and logs its outcome. The request id is sent as a
 * header so the backend's "ipc.command.received" line and this completion
 * line can be joined. Argument values are never logged: they include
 * passwords, tokens, transcripts and note content.
 */
export async function invokeCommand<T>(command: string, args?: InvokeArgs): Promise<T> {
  const requestId = globalThis.crypto.randomUUID();
  const startedAt = performance.now();
  try {
    const result = await invoke<T>(command, args, { headers: { [REQUEST_ID_HEADER]: requestId } });
    logger.info("ipc.command.completed", {
      command,
      requestId,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    logger.warn("ipc.command.failed", {
      command,
      requestId,
      durationMs: Math.round(performance.now() - startedAt),
      error: errorMessage(error),
    });
    throw error;
  }
}
