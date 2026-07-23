import assert from "node:assert/strict";
import test from "node:test";
import { recorderErrorMessage } from "./recorder-feedback.ts";

test("maps macOS screenshot permission failures to a compact action", () => {
  const message = recorderErrorMessage(
    "screenshot",
    "macOS could not capture the screen. Allow Screen Recording in System Settings > Privacy & Security.",
  );
  assert.equal(message, "Enable Screen Recording in macOS Settings");
});

test("does not expose native recorder internals", () => {
  const message = recorderErrorMessage("start", "CoreAudio device error: internal payload");
  assert.equal(message, "Could not start recording");
  assert.doesNotMatch(message, /CoreAudio|payload/);
});
