export type RecorderAction = "start" | "pause" | "resume" | "screenshot" | "finish";

export function recorderErrorMessage(action: RecorderAction, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");

  if (
    action === "screenshot" &&
    /screen recording|privacy.*security|could not capture|permission/i.test(raw)
  ) {
    return "Enable Screen Recording in macOS Settings";
  }

  const messages: Record<RecorderAction, string> = {
    start: "Could not start recording",
    pause: "Could not pause recording",
    resume: "Could not resume recording",
    screenshot: "Could not capture screenshot",
    finish: "Could not save recording",
  };
  return messages[action];
}
