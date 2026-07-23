# macOS-First Modular Audio Refactor Plan

**Status:** Initial macOS milestone implemented; hardware qualification pending  
**Primary target:** macOS recording reliability and modularity  
**Protected baseline:** Existing Linux recording behavior  
**Deferred target:** Windows cleanup after the macOS path is qualified

## 1. Objective

Refactor the recording subsystem so macOS becomes reliable for long recordings without
regressing the Linux path that is currently used for development.

The resulting design must:

1. Keep the current Linux capture and output behavior intact until parity tests prove a
   replacement is equivalent.
2. Remove the current macOS whole-recording-in-memory implementation.
3. Give every platform a small capture adapter while sharing lifecycle, chunk storage,
   processing, encoding, and reporting code.
4. Propagate capture and finalization failures to the frontend instead of silently changing
   recording mode.
5. Support clean recovery and future progressive transcription without another large rewrite.
6. Avoid another platform file growing into a multi-thousand-line module.

This is a refactor and macOS hardening project. It is not an authorization to redesign the
working Linux signal chain, change its audio tuning, or add native macOS VPIO in the first pass.

## 2. Pre-Refactor Verified State

The findings in this section describe the baseline that motivated the implementation. The current
implementation snapshot is recorded in Section 13.

### Linux

- System audio is captured through native PulseAudio/PipeWire monitor access.
- Microphone audio is captured through CPAL and drained through a ring buffer.
- Audio is stored in rotating raw chunks and progressively encoded.
- WebRTC AEC, RNNoise, and `AudioDsp` are applied in the chunk worker.
- Standalone MP3 chunks can be emitted for live transcription.
- This is the behavioral baseline to protect.

### macOS

- System audio is captured by ScreenCaptureKit through `SystemAudio.swift`.
- The ScreenCaptureKit audio APIs used by the app require macOS 13 or newer.
- Microphone audio is captured by CPAL.
- The system stream is written to one fixed `/tmp/atok_macos_system.raw` file.
- The microphone stream is accumulated in a `Vec<u8>`.
- At stop, the entire system file and microphone recording are loaded into memory, processed,
  and encoded.
- macOS does not emit progressive transcription chunks.
- Several setup errors after ScreenCaptureKit starts can exit without stopping the native stream.
- The Rust-to-Swift path bridge passes a byte pointer plus length, but Swift currently constructs
  the path as a null-terminated C string and ignores the length.

### Windows

- Windows already has a separate WASAPI implementation.
- It now uses the shared AEC and `AudioDsp`, but lifecycle, device selection, buffering, and error
  propagation still differ from the non-Windows recorder.
- Windows changes are deferred except where a shared type can be adopted without changing its
  runtime behavior.

### Structural problem

`audio_recorder.rs` currently contains all of the following:

- non-Windows recorder lifecycle;
- Linux capture and chunk orchestration;
- macOS ScreenCaptureKit and CPAL orchestration;
- CPAL fallback recording;
- raw chunk storage;
- stream alignment;
- resampling;
- RNNoise integration;
- MP3 encoding;
- device enumeration;
- device-name presentation;
- output verification;
- tests for several unrelated layers.

The file cannot be safely evolved as a single unit. Platform capture and shared processing need
different ownership boundaries.

## 3. Non-Negotiable Invariants

Every phase must preserve these invariants.

### Linux protection

1. Linux continues using native PulseAudio monitor capture and the existing CPAL mic path.
2. Linux chunk duration, overlap, MP3 bitrate, AEC ordering, RNNoise ordering, DSP settings, and
   transcript handoff remain unchanged unless a separately approved audio-quality change is made.
3. Existing Linux tests remain green.
4. Extraction commits must be behavior-preserving: move code first, improve it later.
5. No macOS-only dependency may be compiled or linked on Linux.
6. A macOS failure must not cause changes to Linux fallback behavior.

### Recording durability

1. `start` returns success only after required capture resources have started.
2. `stop` returns success only after capture has stopped and the final MP3 is flushed, synced, and
   verified.
3. Background thread errors are returned through the recorder completion result.
4. A finalized MP3 is never deleted by cleanup of temporary session data.
5. Every temporary session uses a unique directory; no global fixed raw-audio path is allowed.
6. Cleanup must never remove a directory while a capture, drain, processing, or encoder worker can
   still access it.

### Audio correctness

1. The processing format is explicit: signed 16-bit little-endian PCM at 48 kHz.
2. Channel count and frame count are carried in types, not inferred repeatedly from byte lengths.
3. AEC receives time-aligned render and microphone frames.
4. AEC runs before RNNoise and `AudioDsp`.
5. Resampling state persists across adjacent buffers; it must not restart phase for every packet.
6. Mono-only recordings are encoded as mono or explicitly converted to stereo once.
7. Buffer overflow, dropped frames, clock drift, and degraded capture mode are observable.

### User-visible truth

1. A system+mic request that falls back to mic-only is reported as degraded, not clean success.
2. macOS permission denial is distinguishable from missing device and internal capture failure.
3. Device capability reporting reflects the selected platform and actual permission state.
4. The frontend receives a final capture summary containing actual sources, duration, dropped
   frames, warnings, and artifact path.

## 4. Target Module Layout

```text
src-tauri/src/audio/
├── mod.rs                       # compile-time platform selection and public API
├── types.rs                     # configs, device types, outcomes, typed errors
├── lifecycle.rs                 # recorder state machine and completion handling
├── session.rs                   # unique session directory and durable finalization
├── capabilities.rs              # feature/capability reporting
│
├── platform/
│   ├── mod.rs
│   ├── linux/
│   │   ├── mod.rs               # Linux adapter only
│   │   ├── capture.rs           # Pulse monitor + CPAL mic orchestration
│   │   └── devices.rs           # Linux device mapping/presentation
│   ├── macos/
│   │   ├── mod.rs               # macOS adapter only
│   │   ├── capture.rs           # SCK + CPAL lifecycle
│   │   ├── bridge.rs            # safe Swift FFI wrappers and RAII guard
│   │   ├── devices.rs           # CoreAudio/CPAL device handling
│   │   └── permissions.rs       # Screen Recording and mic permission state
│   └── windows/
│       ├── mod.rs               # later migration of existing WASAPI code
│       ├── capture.rs
│       └── devices.rs
│
├── capture/
│   ├── cpal_mic.rs              # reusable RT-safe CPAL mic producer
│   ├── frame.rs                 # typed PCM frame and source/timestamp metadata
│   └── queue.rs                 # bounded ring/queue and overflow accounting
│
├── pipeline/
│   ├── mod.rs                   # shared processing entry point
│   ├── align.rs                 # timestamp/start-offset alignment and tail carry
│   ├── resample.rs              # stateful resampling
│   ├── aec.rs                   # adapter around existing AudioAec
│   ├── denoise.rs               # persistent RNNoise state
│   └── mix.rs                   # adapter around existing AudioDsp
│
├── storage/
│   ├── raw_chunks.rs            # rotating, atomic raw chunk writer
│   ├── chunk_manifest.rs        # indexes, formats, time ranges, completion state
│   └── cleanup.rs               # fenced session cleanup
│
└── encoding/
    ├── mp3.rs                   # shared LAME builder/finalizer
    ├── progressive.rs           # final MP3 plus standalone ASR chunks
    └── verify.rs                # frame-safe output validation
```

Existing top-level `audio_aec.rs`, `audio_dsp.rs`, and `linux_pulse.rs` do not need to move in the
first macOS milestone. Moving them is cosmetic and adds avoidable Linux risk. They can be re-exported
from `audio::pipeline` until the refactor is stable.

### File-size guidance

- Platform adapter files should normally stay below 400 lines.
- Shared modules should have one responsibility and normally stay below 300 lines.
- Functions should normally stay below 80 lines.
- A longer file or function requires a clear cohesion reason; it must not become an arbitrary split
  into numbered helper files.
- Unit tests live next to small pure modules; larger integration fixtures live under
  `src-tauri/tests/audio/`.

These are review signals, not blind formatting rules.

## 5. Shared Contracts

### Capture configuration

```rust
pub struct CaptureConfig {
    pub recording_id: Uuid,
    pub output_path: PathBuf,
    pub microphone: Option<DeviceId>,
    pub include_system_audio: bool,
    pub aec_enabled: bool,
    pub processing_sample_rate: u32,
    pub chunk_duration: Duration,
}
```

### Capability reporting

```rust
pub struct CaptureCapabilities {
    pub system_audio: Availability,
    pub microphone_selection: bool,
    pub progressive_chunks: bool,
    pub native_aec: bool,
}

pub enum Availability {
    Available,
    PermissionRequired,
    Unsupported,
    Unavailable { reason: String },
}
```

### Final result

```rust
pub struct CaptureSummary {
    pub recording_id: Uuid,
    pub artifact_path: PathBuf,
    pub actual_mode: CaptureMode,
    pub duration: Duration,
    pub system_frames: u64,
    pub microphone_frames: u64,
    pub dropped_frames: u64,
    pub warnings: Vec<CaptureWarning>,
}
```

### Lifecycle

```text
Idle
  -> Starting
  -> Recording
  -> Stopping
  -> Finalizing
  -> Completed

Starting/Recording/Stopping/Finalizing
  -> Failed(recoverable artifact state)
```

The state transition owner is shared lifecycle code. Platform modules own capture resources but do
not independently decide that a recording is finalized.

## 6. Implementation Phases

## Phase 0 — Freeze and characterize the Linux baseline

**Purpose:** Prevent accidental Linux regression before moving code.

### Work

1. Record the exact current Linux constants and processing order in tests:
   - 48 kHz processing rate;
   - 3-minute raw chunk rotation;
   - 5-second live transcription overlap;
   - AEC -> RNNoise -> `AudioDsp`;
   - 192 kbps final MP3;
   - existing mono/stereo conversion behavior.
2. Add pure fixture tests around `process_chunk_batch` using deterministic system and mic PCM.
3. Add tests for:
   - mic-only;
   - system-only;
   - system+mono mic;
   - unequal input lengths;
   - non-48-kHz mic;
   - partial RNNoise frame;
   - AEC disabled and enabled.
4. Add a Linux session fixture asserting:
   - chunk indexes are monotonic;
   - final MP3 exists and is synced;
   - standalone ASR chunks are emitted in order;
   - temporary cleanup happens only after workers join.
5. Capture a short manual Linux golden recording and record:
   - duration;
   - MP3 size;
   - channel count/sample rate;
   - clipping ratio;
   - approximate integrated loudness;
   - transcript chunk count.

### Gate

- No production behavior changes.
- Existing frontend tests pass.
- Rust unit tests pass on Linux.
- Manual 2-, 10-, and 35-minute Linux recordings complete.
- Baseline measurements are stored without committing private audio.

### Rollback

No runtime change exists, so rollback is test-file removal only.

## Phase 1 — Introduce shared types and lifecycle facade

**Purpose:** Establish boundaries without moving the Linux implementation.

### Work

1. Add `audio/types.rs`, `audio/lifecycle.rs`, and `audio/mod.rs`.
2. Move `DeviceStatus` and `AudioDeviceInfo` from `lib.rs` into `audio::types` and re-export them so
   Tauri serialization remains unchanged.
3. Define typed `AudioError` categories:
   - permission;
   - device;
   - capture start;
   - capture runtime;
   - storage;
   - processing;
   - encoding;
   - finalization.
4. Define `CaptureSummary`, but keep the existing Tauri command response compatible until the
   frontend is ready.
5. Wrap the existing non-Windows recorder behind the new facade without altering its internals.
6. Keep compile-time platform selection; do not introduce runtime OS branching.

### Gate

- Linux executable behavior and generated MP3 remain unchanged.
- Tauri command names and frontend payloads remain compatible.
- Linux-only builds do not compile Swift or Windows dependencies.

### Rollback

The facade can be removed while the existing recorder remains untouched.

## Phase 2 — Extract shared code mechanically

**Purpose:** Reduce `audio_recorder.rs` safely before changing macOS behavior.

### Extraction order

1. MP3 builder, encode, flush, sync, and verify -> `audio/encoding/mp3.rs`.
2. PCM byte/sample/channel conversion -> `audio/capture/frame.rs`.
3. CPAL device resolution and RT-safe mic producer -> `audio/capture/cpal_mic.rs`.
4. Raw chunk rotation and drain worker -> `audio/storage/raw_chunks.rs`.
5. Start-offset and tail alignment helpers -> `audio/pipeline/align.rs`.
6. RNNoise state management -> `audio/pipeline/denoise.rs`.
7. Existing linear resampling -> temporary `audio/pipeline/resample.rs`.
8. Shared AEC/DSP composition -> `audio/pipeline/mod.rs`.

### Rules

- Each extraction commit moves one responsibility.
- Do not change constants, algorithms, logging semantics, or buffer sizes during the move.
- Call the extracted helpers from the existing Linux code immediately.
- Compare deterministic Linux fixture output before and after each extraction.
- Do not replace the resampler yet; extraction and algorithm improvement are separate phases.

### Gate

- Linux fixture PCM output is identical where deterministic.
- Encoded output properties remain equivalent.
- No new macOS behavior is enabled yet.
- `audio_recorder.rs` is reduced without creating circular dependencies.

### Rollback

Every extraction commit is independently revertible.

## Phase 3 — Repair the macOS bridge and lifecycle

**Purpose:** Fix correctness hazards before implementing a new macOS pipeline.

### Rust/Swift bridge

1. Replace the unsafe path conversion contract:
   - preferred: pass pointer plus explicit byte length and construct Swift `String` from that length;
   - alternative: pass a Rust `CString` and document null-termination.
2. Reject paths that cannot be decoded rather than reading beyond the buffer.
3. Replace Swift globals with one synchronized capture-session object.
4. Make `start` return structured failure information.
5. Ensure every failed start closes its file handle and clears session state.
6. Ensure `didStopWithError` records the error and triggers idempotent resource cleanup.
7. Make `stop` idempotent but return the recorded runtime error.
8. Set the Swift package, Swift linker, and Tauri bundle minimum consistently to macOS 13.

### Rust RAII

1. Add `MacSystemCaptureGuard`.
2. `Drop` must request best-effort ScreenCaptureKit stop.
3. Explicit `finish()` performs checked stop and returns errors.
4. Start ScreenCaptureKit and CPAL under one staged startup transaction.
5. If any later startup step fails, previously acquired resources are released automatically.

### Session paths

1. Replace `/tmp/atok_macos_system.raw`.
2. Create:

```text
<app-data>/recordings/.sessions/<recording-uuid>/
├── session.json
├── system/
├── microphone/
└── output/
```

3. Record capture format and lifecycle state in `session.json`.
4. Never use a filename shared by two recordings or processes.

### Gate

- Denied Screen Recording permission leaves no live stream or open file handle.
- Missing mic after system capture starts cleans system resources.
- Repeated `stop` does not crash or leak.
- Two concurrent app processes cannot use the same temporary path.
- macOS start failure is reported to the frontend.

### Rollback

The old macOS batch processor remains available behind a temporary
`legacy_macos_batch_capture` feature until Phase 5 qualifies the replacement.

## Phase 4 — Build a disk-backed macOS capture path

**Purpose:** Eliminate memory growth without changing audio quality.

### Work

1. Send CPAL mic data to the shared bounded queue and rotating raw chunk writer.
2. Make ScreenCaptureKit output rotate into indexed raw chunks, or emit chunk boundary metadata
   that lets Rust finalize safe ranges.
3. Persist for every chunk:
   - index;
   - source;
   - format;
   - first/last timestamp;
   - frame count;
   - byte count;
   - completion flag.
4. Process only completed system/mic ranges.
5. Carry unmatched tails into the next processing window.
6. Keep processing state, AEC state, RNNoise state, DSP state, resampler phase, and encoder state
   alive across chunks.
7. Bound all in-memory queues.
8. Count overflow instead of silently ignoring failed `push_slice`.

### Important first milestone

The first disk-backed version may still process completed raw chunks during finalization rather than
transcribing live. The required result is bounded memory and correct output. Progressive processing
is enabled only after capture correctness is proven.

### Gate

- Memory use remains approximately flat during 10-, 60-, and 120-minute recordings.
- No whole-take `Vec<u8>` or `std::fs::read()` exists in the macOS recording path.
- Final MP3 duration matches wall-clock duration within an agreed tolerance.
- System and mic tails are retained.
- Forced error in chunk N preserves all previously completed chunks.

### Rollback

Switch the macOS feature flag back to the legacy batch path. Linux is unaffected.

## Phase 5 — Move macOS onto the shared processing and encoding pipeline

**Purpose:** Give macOS the same processing contract as Linux.

### Work

1. Normalize macOS source frames into shared typed PCM frames.
2. Add timestamp/start-offset alignment using ScreenCaptureKit sample timing and CPAL callback
   timestamps where available.
3. Feed aligned 48-kHz frames through:

```text
AEC -> RNNoise -> AudioDsp -> progressive encoder
```

4. Reuse Linux-proven MP3 chunk and final-artifact code.
5. Preserve existing macOS AEC settings behavior.
6. Return `CaptureSummary` with actual source counts and warnings.
7. Make mic-only fallback explicit and visible.

### Gate

- Shared pipeline fixtures pass on macOS.
- AEC-off output has no frame loss.
- AEC-on system/mic alignment does not drift over one hour.
- Mic-only and system-only modes produce valid audio at the correct speed.
- Output is playable immediately after `stop` returns.

### Rollback

Use the legacy macOS processing feature while retaining the repaired bridge and unique session
storage.

## Phase 6 — Enable progressive macOS chunks and live transcription

**Purpose:** Reach feature parity with Linux after the capture path is stable.

### Work

1. Emit standalone MP3 chunks only after each encoder flush/finalization succeeds.
2. Send chunk paths in index order through the existing transcription channel.
3. Preserve the configured overlap and stitch semantics.
4. Persist chunk transcription status so restart does not retranscribe completed chunks.
5. Close the channel only after the final chunk has been emitted or a typed terminal error occurs.
6. Ensure the final MP3 remains independent from disposable upload chunks.

### Gate

- A 35-minute recording emits multiple valid chunks before stop.
- Transcription order matches chunk indexes.
- Failure to upload one chunk does not corrupt the final MP3.
- Stop waits for final audio persistence, not for optional AI enhancement.
- Linux live transcription behavior remains unchanged.

### Rollback

Disable progressive macOS emission and retain full-file post-stop transcription.

## Phase 7 — Device selection, permissions, and UX truthfulness

**Purpose:** Make the macOS controls correspond to real backend behavior.

### Work

1. Use stable CoreAudio device identity rather than display text.
2. Map stable identity to CPAL devices behind the macOS adapter.
3. Report microphone and Screen Recording permission separately.
4. Update device status after permission changes and capture failures.
5. Expose capture capabilities to the popup.
6. Display explicit states:
   - ready for system+mic;
   - mic-only;
   - permission required;
   - selected device unavailable;
   - capture degraded;
   - finalization failed.
7. Persist selected mic only after confirming it still exists.

### Gate

- Selecting two different microphones records from the selected endpoint.
- Disconnecting the selected microphone produces a clear error or declared fallback.
- Permission denial never appears as “System Audio available”.
- Frontend does not begin processing a failed or unfinished MP3.

## Phase 8 — Replace temporary technical debt

**Purpose:** Improve quality only after macOS parity is established.

### Work

1. Replace stateless linear resampling with one stateful production resampler.
2. Add clock-drift compensation between independent system and microphone devices.
3. Evaluate native VoiceProcessingIO as an optional macOS capture/AEC backend.
4. Keep WebRTC AEC as the fallback until VPIO is independently qualified.
5. Remove the legacy macOS batch feature after one stable release cycle.
6. Remove stale comments and update `DESIGN.md` to match the as-built architecture.

### Gate

- A/B fixtures show no duration regression.
- Resampler phase remains continuous across chunks.
- VPIO failure falls back without losing the recording.
- Legacy removal happens only after 2-hour qualification passes.

## Phase 9 — Windows adoption

Windows is deliberately outside the macOS-first critical path. After the shared lifecycle and
pipeline are proven by Linux and macOS:

1. Move existing WASAPI capture behind `audio/platform/windows`.
2. Adopt shared completion/error propagation.
3. Use stable endpoint IDs for microphone selection.
4. Replace front-draining `Vec` buffers with bounded queues/cursors.
5. Validate silent WASAPI packets before constructing slices.
6. Detect the actual WASAPI sample format instead of treating all 32-bit samples as float.
7. Adopt the stateful resampler and shared capture summary.

## 7. Linux Regression Gates Per Phase

Every phase that touches shared Rust code must run this matrix before merge:

| Check | Required result |
|---|---|
| Rust format/check/clippy/tests on Linux | Pass |
| Existing audio DSP/AEC tests | Pass |
| Deterministic PCM fixtures | No unexpected difference |
| 2-minute Linux system+mic recording | Valid MP3, correct duration |
| 10-minute Linux system+mic recording | No worker leak or growing memory |
| 35-minute Linux recording | Multiple ordered ASR chunks |
| Linux mic-only fallback | Valid speed/channel layout plus warning |
| Start/stop/start | Second session starts cleanly |
| Popup close during recording | Recoverable finalization or explicit failure |
| Forced capture error | Error reaches UI; recorder is reusable |

For major shared pipeline changes, also run a 1-hour Linux soak before merge.

## 8. macOS Qualification Matrix

### Functional

- built-in mic + active system audio;
- built-in mic + silent system;
- selected USB mic;
- selected Bluetooth mic;
- mic-only;
- system-only if supported by product UX;
- AEC enabled and disabled;
- headphones and built-in speakers;
- screen permission granted, denied, and revoked;
- microphone permission granted, denied, and revoked.

### Duration

- 10 seconds for rapid lifecycle tests;
- 2 minutes for basic quality;
- 10 minutes for chunk and memory validation;
- 35 minutes for multi-chunk transcription;
- 1 hour for drift;
- 2 hours for release qualification.

### Failure injection

- ScreenCaptureKit start failure;
- CPAL mic start failure after system capture starts;
- system stream runtime failure;
- mic runtime failure;
- ring/queue saturation;
- raw chunk write failure;
- MP3 encode failure;
- disk full;
- app close during recording;
- forced process termination during capture;
- forced process termination during finalization;
- transcription provider offline.

### Artifact audit

After each injected failure, inspect:

- session manifest;
- completed system chunks;
- completed mic chunks;
- final or partial MP3;
- standalone transcription chunks;
- transcript sidecar;
- cleanup state;
- absence of live native capture resources.

## 9. Test Strategy

### Pure unit tests

- PCM conversion;
- channel normalization;
- frame/timestamp arithmetic;
- alignment and tail carry;
- resampler continuity;
- AEC frame batching;
- RNNoise partial frames;
- chunk rotation;
- MP3 finalize and verification;
- lifecycle state transitions;
- typed error mapping.

### Contract tests

Create a fake platform capture adapter that can:

- emit deterministic frames;
- delay startup;
- fail after N frames;
- overflow its queue;
- stop normally;
- hang during stop;
- report different capabilities.

Run the shared lifecycle, storage, processing, finalization, and cleanup code against the fake
adapter on every development OS.

### Platform integration tests

- Linux PulseAudio smoke tests remain ignored unless a server is available.
- macOS ScreenCaptureKit tests are feature-gated and require permission.
- Never make ordinary unit tests depend on real audio hardware.

### Manual quality fixtures

Use non-private reproducible fixtures:

- silence;
- sine sweeps;
- speech from speaker with built-in mic;
- near-field speech;
- simultaneous system and local speech;
- deliberate clock offset and drift.

Do not commit personal meeting audio.

## 10. Commit and Review Sequence

Recommended small-commit order:

1. `test(audio): characterize linux recording baseline`
2. `refactor(audio): add shared recording types and lifecycle facade`
3. `refactor(audio): extract mp3 encoding and verification`
4. `refactor(audio): extract pcm frames and cpal mic producer`
5. `refactor(audio): extract raw chunk storage`
6. `refactor(audio): extract alignment and processing pipeline`
7. `fix(macos): make screencapturekit bridge memory-safe`
8. `fix(macos): add raii capture cleanup and unique sessions`
9. `feat(macos): add disk-backed microphone and system chunks`
10. `feat(macos): use shared audio processing pipeline`
11. `feat(macos): emit progressive transcription chunks`
12. `feat(macos): expose truthful permissions and capture status`
13. `refactor(audio): remove qualified legacy macos batch path`
14. `docs(audio): update as-built cross-platform architecture`

Do not mix structural moves, audio tuning changes, and platform feature changes in the same commit.

## 11. Risk Register

| Risk | Mitigation |
|---|---|
| Linux output changes during extraction | Characterization fixtures; move-only commits; Linux gate on every shared change |
| macOS permission behavior is hard to automate | Typed permission state plus manual matrix on a dedicated macOS test account |
| SCK and mic clocks drift | Preserve timestamps, carry tails, add stateful resampling/drift correction |
| AEC degrades due to bad alignment | Gate AEC on validated aligned frames; report disabled/degraded state |
| Disk chunks accumulate after crash | Session manifest and startup recovery; cleanup only fenced disposable sessions |
| Feature flag leaves two permanent implementations | Removal deadline: after macOS 2-hour qualification and one stable release cycle |
| Excessive module fragmentation | Split by ownership/responsibility; file-size guidance is not an automatic rule |
| Frontend processes incomplete file | `stop` returns artifact only after sync and verification |
| Live transcription failure blocks recording | Audio finalization is authoritative; transcription remains recoverable and optional |

## 12. Definition of Done

The macOS-first refactor is complete only when:

1. Linux passes the full regression gate with no unapproved signal-chain change.
2. `audio_recorder.rs` no longer contains both Linux and macOS implementations.
3. macOS recording memory remains bounded for two hours.
4. macOS uses unique managed session storage.
5. Swift path conversion is length-safe and all native resources have deterministic cleanup.
6. macOS errors propagate through shared lifecycle state to the frontend.
7. Final MP3 is synced and verified before processing begins.
8. Mic-only fallback is explicitly reported.
9. macOS produces ordered progressive transcription chunks or has an explicitly approved deferred
   gate with recoverable post-stop transcription.
10. Unit, contract, Linux regression, macOS integration, and 2-hour qualification tests pass.
11. The legacy macOS batch path is removed after its rollback window.
12. `DESIGN.md` and the final module map describe the actual implementation.

## 13. Implemented Initial Milestone

Implemented in the current worktree:

- shared `audio::types` and unique `RecordingSession` modules;
- a dedicated `audio::platform::macos` orchestration module, leaving the Linux capture branch
  unchanged;
- a Swift Package with the ScreenCaptureKit minimum aligned to macOS 13 in Swift, Rust linking,
  and Tauri bundling;
- length-safe Rust-to-Swift paths and a synchronized Swift capture-session object;
- Rust RAII cleanup through `MacSystemCapture`;
- unique per-recording `.sessions/<uuid>` storage instead of a global `/tmp` file;
- rotating three-minute system and microphone raw chunks;
- the existing AEC -> RNNoise -> `AudioDsp` -> MP3 chunk worker reused by macOS;
- progressive standalone MP3 chunks available to the existing live-transcription channel;
- bounded Swift write backlog and disk-backed capture, eliminating whole-recording accumulation;
- retained failed/timed-out session data for diagnosis, with cleanup only after worker completion;
- obsolete macOS batch buffering helpers removed.

Automated gates passed on macOS:

- all 118 Rust library tests plus binary/doc test targets;
- all 26 frontend Node tests;
- TypeScript and Vite production build;
- clean Swift package compilation and runtime linkage through the system Swift runtime.

Still required before declaring the full plan complete:

- real-device permission-denied, mic-missing, repeated-stop, and suspend/resume checks;
- 2-, 10-, 35-, and 120-minute macOS recordings with memory and artifact measurements;
- Linux CI or Linux-host regression execution (the Linux branch was not available to execute on
  this macOS host);
- structured capture summaries and typed frontend-visible error categories;
- stateful clock-drift correction and timestamped chunk manifests;
- the remaining shared pipeline/storage/encoding extraction;
- Windows adoption, which remains intentionally deferred.

Do not begin native VPIO or Windows cleanup until the disk-backed macOS path passes the 10-minute
memory and artifact gates.
