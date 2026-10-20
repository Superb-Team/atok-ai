# Atok.ai

## Desktop startup on Linux

Run `pnpm tauri dev` for development. Linux startup checks for the loaded NVIDIA
kernel driver and a Wayland display before initializing Tauri/GTK. On that
combination it sets `__NV_DISABLE_EXPLICIT_SYNC=1` inside the app process to
avoid the WebKitGTK Wayland `Error 71` crash, while keeping GPU rendering.
This also runs in packaged desktop builds. Other drivers and explicitly selected
X11 backends retain their existing graphics settings.

The app preserves an existing `__NV_DISABLE_EXPLICIT_SYNC` environment variable,
including `0` to opt out. It logs the detection and whether it applied the
workaround as `graphics.startup_configured`. NVIDIA detection uses
`/sys/module/nvidia` or `/proc/driver/nvidia/version`; if neither is visible,
the app retains the default behavior. A loaded NVIDIA driver can also be detected
on hybrid GPU laptops, even when a different GPU renders the app.

For other graphics failures, the upstream troubleshooting options remain
available through the launch environment:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev
# Last resort: disables accelerated compositing.
WEBKIT_DISABLE_COMPOSITING_MODE=1 pnpm tauri dev
```

Graphics variables must be set before launch, rather than in the project `.env`,
which loads after GTK initialization. These workarounds do not guarantee support
for every driver or hardware combination. See
[Tauri's Linux graphics guidance](https://v2.tauri.app/develop/debug/linux-graphics/).

## Importing meeting audio

Imports support MP3, WAV, M4A (AAC or ALAC), FLAC and AAC. Choose the original
meeting date/time in your local timezone; the note retains that date rather
than the conversion date. Language and optional names/terms follow the same
transcription and note-generation pipeline as a live recording. Imported files
do not include screen captures or separate microphone/system audio tracks.

The app saves an account-owned queue entry before converting audio. Processing
continues across page navigation and resumes after restarting and signing in to
the same account. Keep the source file available until conversion finishes.
Failed or exhausted jobs appear with a **Retry** action; provider/network errors
also have a bounded automatic retry policy. Import failures retain their queue
entry without creating a placeholder note. Converted audio and transcript
checkpoints are retained for later processing.

Conversion streams decoded packets into an MP3 encoder rather than retaining
the whole recording as PCM. Existing MP3 input is decoded for validation before
copying. Corrupt or unsupported packets fail the import rather than silently
producing a partial recording. Mismatches with a declared frame count are
rejected; streams without a declared duration cannot reliably identify every
possible truncation.

Output is staged beside its destination and published without replacing an
existing file. This requires hard-link support in the app-data filesystem
(normal Linux/macOS filesystems and NTFS support it; FAT/exFAT do not). Ordinary
failures clean up staging files and preserve the source. A forced process kill
can leave a `.atok-import-*.tmp` staging file; a completed output is validated
and reused when the queue resumes. Tests currently cover Linux; cross-platform
desktop behavior and real-provider transcription need runtime verification.

## Frontend structure

```
src/
  app/            entry points (main window, recording popup) and App shell
  features/       one folder per domain
    <feature>/
      components/ React pages and components for this feature
      api/        thin wrappers around Tauri `invoke` commands
      lib/        pure logic, unit-tested with `*.test.ts` beside it
      pipeline/   stages of a multi-step flow (note-generation only)
      types.ts    types shared inside the feature
  components/     components shared across features (shadcn `ui/`, MarkdownRenderer)
  lib/            app-wide helpers (utils, theme)
  styles/         global stylesheet used by both windows
```

Features: `auth`, `notes` (pages, editor, note API), `recording` (popup, audio
import, capture policies), `note-generation` (transcript-to-note AI pipeline,
entry point `audio-processor.service.ts`), `tasks`, `extensions` (MCP),
`settings`, `search-ai`.

Conventions:

- App code imports through the `@/` alias, e.g. `@/features/notes/api/note.service`.
- `pnpm test` runs `node --test` directly on TypeScript without Vite, so the
  alias does not resolve there. Any module reachable from a `*.test.ts` file
  must import its dependencies with relative paths ending in `.ts`.
- Shared UI goes in `src/components`; only move something there once a second
  feature needs it.

## Logging

Frontend and backend write to one JSON-lines file per day (14 kept):

- Linux: `~/.local/share/com.superbteam.atok-ai/logs/atok.YYYY-MM-DD.log`
- macOS: `~/Library/Logs/com.superbteam.atok-ai/`
- Windows: `%LOCALAPPDATA%\com.superbteam.atok-ai\logs\`

Every Tauri command logs `ipc.command.received` (backend) and
`ipc.command.completed` / `ipc.command.failed` with its duration (frontend),
sharing one request id. Outbound provider calls log `http.response` with
operation, host, path, status and duration. To follow one action:

```sh
grep <request-id> ~/.local/share/com.superbteam.atok-ai/logs/atok.*.log
jq -c 'select(.level == "WARN" or .level == "ERROR")' atok.*.log
```

Set `RUST_LOG` to change verbosity, e.g. `RUST_LOG=debug pnpm tauri dev`.

In code, use `invokeCommand` from `@/lib/ipc` instead of Tauri's `invoke`,
`logger` from `@/lib/logger` instead of `console`, and `tracing` macros in
Rust. Log event names and ids, never argument values: they can contain
passwords, tokens, transcripts and note content.
