# atok-ai — Audio & Transcription Architecture Upgrade

**Status:** Design locked, implementation in progress
**Author:** engineering pass (deep audit + research)
**Supersedes:** `plan.md` (old AEC-only plan, partially built)

This document is the single source of truth for the recording/transcription overhaul.
It records (1) the verified defect inventory, (2) research-grounded decisions for the
three product goals, and (3) a prioritized, reversible implementation roadmap.

> **macOS-first execution note (2026-07-23):** The implementation has moved beyond parts of
> the as-built snapshot and defect list below. Use
> [`tasks/macos-audio-refactor-plan.md`](tasks/macos-audio-refactor-plan.md) for the current
> macOS modularization sequence, Linux regression gates, rollback boundaries, and qualification
> criteria. This document still owns the cross-platform product goals until the refactor lands and
> the final as-built architecture replaces both planning snapshots.

The three product goals (from the owner):

1. **Mic level "just right"** — microphone not too hot/harsh; consistent level across a long meeting.
2. **No speaker bleed** — the mic must not re-record what the device speakers play (real echo cancellation).
3. **Efficient long-form transcription** — chunk *concurrently while recording*, then merge into one
   transcript once all context is gathered; reliable for 2h+ multi-speaker meetings.

Cross-cutting: all OS paths (Windows / Linux / macOS) behave the same and sound the same; clean,
reliable code; minimal in-code comments.

---

## 1. Current architecture (as-built)

Platform recorder is chosen at compile time (`lib.rs`):

| OS | System audio | Mic | Processing | Encode |
|----|--------------|-----|-----------|--------|
| **Windows** | WASAPI loopback (`eRender`) | WASAPI (`eCapture`) | `mix_windows_frames` (own chain) | live MP3 |
| **Linux** | `parec` on `<sink>.monitor` | `cpal` → 3-min `.raw` chunks | `chunk_worker`: resample→AEC→RNNoise→`audio_dsp`→MP3 | progressive MP3 |
| **macOS** | ScreenCaptureKit (Swift) → file | `cpal` → ringbuf | batch: resample→AEC→RNNoise→`audio_dsp`→MP3 | MP3 at end |
| **fallback** | none | `cpal` → ringbuf | mic-only, no DSP | live MP3 |

Transcription (`agent.rs`): after stop, read whole MP3 → DeepInfra Whisper `whisper-large-v3-turbo`;
if > 40 MB, split by **raw byte offset** and upload in parallel; join with `\n\n`.

### The central structural problem

There are **two divergent signal chains**. Linux/macOS use `audio_dsp.rs` (80 Hz HPF → soft-knee
noise gate → fixed −6 dB mic gain → mix → 40 Hz HPF → true-peak limiter) **plus RNNoise**. Windows
uses `mix_windows_frames` — a bare `(mic + sys·+2dB)·0.5` with a crude soft clip and **no HPF, no
gate, no RNNoise, no real limiter**. So "mic too loud / harsh / has bleed" manifests *differently per
OS*, and any fix applied to one chain does not help the others. **Unifying the chain is the backbone
of this upgrade.**

---

## 2. Verified defect inventory

15 bugs confirmed by an adversarial multi-agent audit (each independently re-verified), plus
architectural findings. Ranked by impact on the three goals.

### HIGH

- **H1 — Blocking disk I/O inside the real-time cpal callback** (`audio_recorder.rs` `cpal_record_chunked`,
  ~L290-340). The mic callback does `File::create` (on rotation) + per-sample `write_all` + takes a
  `std::Mutex` — all forbidden in an RT audio callback. Any fs stall → xrun → **silently dropped mic
  samples**. macOS/fallback already use the correct lock-free-ringbuf + drain-thread pattern; Linux does not.
  *Hurts goal 1 (mic quality) directly.* → **Fix: ringbuf + drain thread.**

- **H2 — Closing the popup mid-recording never stops the backend** (`RecordingPopupApp.tsx`; no
  `onCloseRequested`, no Rust `on_window_event`). The atomic `is_recording` stays `true`, capture
  threads keep running, the take is never finalized, and every future start returns "Already recording"
  until app restart. *Reliability killer.* → **Fix: window-close handler (JS) + Rust close-event safety net.**

- **H3 — Recorder stuck "recording" after a failed stop** (`RecordingPopupApp.tsx` `handleFinish`
  rolls `isRecording` back to `true` on error; backend `swap(false)` already consumed state). A second
  FINISH returns `Ok` with the stale path → a **corrupt take gets reprocessed**. → **Fix: transition to
  an explicit error state; clear path on every stop attempt.**

### MEDIUM (several compound over a 2h meeting)

- **M1 — Per-chunk sys/mic length mismatch drops the tail of the longer stream every chunk**
  (`process_chunk_batch` / Windows `process_windows_buffers` use `min(sys,mic)`), so leftover samples
  are discarded each chunk → **A/V desync that accumulates** over a long recording.
- **M2 — Worker-join 300 s timeout leaks the worker thread, then `remove_dir_all` deletes the session
  dir out from under its in-flight reads/writes** (`record_linux_chunked`).
- **M3 — Mono mic-only chunk fed to the stereo DSP + stereo encoder** → 2×-speed/pitch-shifted audio
  (encoder is fixed at `channels=2`).
- **M4 — Biquad HPF state split across channels via `ch = i % 2` for mono mic** → corrupted filtering.
- **M5 — Noise-gate envelope shared across L/R** → coupled stereo gating.
- **M6 — Windows `is_recording` left `true` when the capture thread exits on error** → blocks restart.
- **M7 — cpal callback ignores `push_slice` return** (ring sized for mono only) → silent drop on stall.
- **M8 — User-selected microphone is never sent to the backend** — the picker is decorative; capture
  always uses the OS default device.

### LOW

- L1 — `parec` stderr discarded; read error == EOF == success → silent loss of system audio if parec dies.
- L2 — Limiter envelope/gain shared across interleaved channels & updated per-sample → time constants 2× fast.
- L3 — Windows `GetMixFormat` WAVEFORMATEX never `CoTaskMemFree`'d (tiny leak).
- L4 — Windows recording thread `CoInitializeEx` without `CoUninitialize` (thread-exit reclaims it).

### Architectural (mine)

- **A1 — Windows bypasses `audio_dsp.rs` + RNNoise entirely** (see §1). Biggest professionalism gap.
- **A2 — Transcription byte-splits MP3** + 40 MB threshold exceeds Whisper's ~25 MB/file limit; no
  concurrency; no boundary handling. *Blocks goal 3.*
- **A3 — macOS loads the entire take into RAM** (`record_macos` reads whole sys file + mic) → ~1.3 GB+
  for 2h. Not scalable. (Linux is chunked; Windows streams.)
- **A4 — AEC is off by default** (`AEC_ENABLED=false`) and runs as fragile per-chunk post-processing on
  Linux/macOS. *Goal 2 needs it reliable and default-on.*
- **A5 — Linear-interpolation resampling** everywhere → aliasing/HF artifacts on 44.1→48k mic.

---

## 3. Research-grounded decisions

### Pillar 1 — Mic loudness leveling

**Standard:** ITU-R BS.1770-4 / [EBU R128](https://tech.ebu.ch/docs/r/r128.pdf). Loudness in **LUFS**;
true-peak ceiling **−1 dBTP**. Broadcast target −23 LUFS; podcast/voice −16 LUFS (Apple).

**Does Whisper care about absolute level?** No — Whisper normalizes log-mel internally, so ASR accuracy
is level-insensitive as long as the signal isn't clipping or near-silent. The target therefore serves
**human listening + the owner's "too loud/harsh" complaint + consistency**, not ASR.

**Why not per-sample AGC:** it pumps and destroys prosody (the code already, correctly, refuses it).
A **loudness-normalizing leveler** (measure integrated loudness per chunk, apply a *slowly smoothed*
make-up gain toward target, with a true-peak limiter as the only fast element) is the professional
approach and is what Auphonic / EBU-style normalizers do.

**Decision:**
- Add the **`ebur128`** crate (libebur128 bindings) to measure integrated LUFS + true-peak per chunk.
- Target: **mic stem ≈ −20 LUFS** before mix (so speech sits comfortably under the limiter), **final mix
  ≈ −18 LUFS**, **true-peak ceiling −1 dBTP** (≈ 0.891 linear; the existing limiter already targets this).
- Replace the fixed `mic_gain = −6 dB` with a leveler: `gain_db = clamp(target − measured, −12, +12)`,
  smoothed across chunks (e.g. ≤ ±1 dB/chunk step) so it doesn't pump. Keep the existing soft-knee gate
  + true-peak limiter as the safety net.
- This lives in `audio_dsp.rs` so **all three OS paths inherit it** once the chain is unified (§4).

### Pillar 2 — No speaker bleed (AEC)

**Why post/batch AEC is fragile:** WebRTC AEC requires the **render** (far-end/speaker) and **capture**
(mic) frames fed in lockstep with a known, stable delay; it adapts a filter online. Feeding two
*separately captured* streams (loopback vs mic) that started at different times and drift in clock is
exactly the hard case — convergence is poor. The most reliable fix is AEC **at capture time** where the
OS already knows the alignment.

**Decision (most-reliable per OS, with a common fallback):**
- **Linux:** prefer the OS canceller — PipeWire/PulseAudio **`module-echo-cancel` (`aec_method=webrtc`)**,
  load it and capture the cleaned `source`. This is what Chrome/Zoom effectively use on Linux and it
  handles alignment for us. Fallback: in-pipeline `webrtc-audio-processing` APM.
- **macOS:** prefer **`kAudioUnitSubType_VoiceProcessingIO`** (VPIO) — FaceTime-grade AEC+AGC+NS at the
  AudioUnit level. Fallback: APM.
- **Windows:** no system AEC for loopback; run the **`webrtc-audio-processing` APM in the real-time
  capture loop** (windows_audio.rs already feeds ~10 ms/480-sample frames at 48 kHz — the right shape).
- **Ordering:** AEC **before** RNNoise denoise, both on 48 kHz s16le frames (already the case).
- Make AEC **on by default** with a settings toggle for "raw mic" power users.

> Implementation note: OS-native AEC (Linux module / macOS VPIO) is the larger lift and platform-specific.
> The immediate, portable win is to **make the existing APM path correct + default-on + frame-aligned**
> and unify it; OS-native cancellers are a follow-up that further improves reliability.

### Pillar 3 — Efficient long-form concurrent transcription

**Whisper facts:** `whisper-large-v3-turbo` is a 4-decoder-layer pruned large-v3 (fast, minor quality
loss); processes audio in **30 s** windows internally; DeepInfra accepts mp3/mp4/wav/webm/flac/ogg up to
**~25 MB/file** and up to ~4 h. Long-form Whisper is prone to **hallucination/repetition on silence** and
drift when `condition_on_previous_text` is on.

**The byte-split is invalid:** MP3 frames are variable-length; cutting at 40 MB offsets splits mid-frame
→ corrupt seams, no time alignment. (Confirmed bug A2.)

**Decision — chunk the *source*, not the encoded file:**
- The recorder already produces natural ~3-min boundaries. **Emit one standalone audio file per chunk**
  (`chunk_0000.mp3` …) at clean boundaries, each ~4 MB (3 min @ 192 kbps) — always under 25 MB.
- **Transcribe each chunk concurrently as it finalizes** (during recording), bounded parallelism;
  preserve order by index. Merge once recording stops ("setelah semua konteks kumpul").
- **Overlap + stitch:** carry a small **~2 s overlap** between adjacent chunks and **trim the duplicated
  text at the seam** (token-level longest-overlap match) so boundary words aren't lost or doubled.
- **Hallucination mitigation:** skip near-silent chunks (gate/VAD energy threshold), and do **not** blindly
  condition each chunk on the previous chunk's text (avoid cross-chunk drift); optionally pass a short
  `initial_prompt` of the last sentence only.
- Keep the final single MP3 as the saved artifact; transcription consumes the per-chunk files.
- Fix `CHUNK_SIZE`/byte-split regardless: never exceed 25 MB; never split encoded MP3 by bytes.

### Cross-cutting quality

- **RT callbacks:** never block/alloc/lock/IO in a cpal/WASAPI/CoreAudio callback → ringbuf + drain
  thread (fixes H1). This is standard real-time-audio doctrine.
- **Resampling:** replace linear interpolation with **`rubato`** (windowed-sinc / FFT) for 44.1→48 k mic.
  Linear interpolation aliases; sinc is the professional standard and audibly cleaner.
- **Chain order (voice):** capture → AEC → denoise (RNNoise) → HPF → gate → leveler(LUFS) → mix → mix-HPF
  → true-peak limiter → encode.
- **Upload format:** MP3 per-chunk is adequate (~4 MB/3 min). Opus/ogg would cut upload size ~3-5× and is
  Whisper-accepted — a worthwhile *follow-up* optimization, deferred to keep scope contained.

---

## 4. Target unified architecture

```
                ┌──────────── per-OS capture (RT-safe: ringbuf only) ────────────┐
  Windows WASAPI │  Linux parec+cpal  │  macOS SCK+cpal  │  fallback cpal-mic     │
                └───────────────────────────────┬───────────────────────────────┘
                                                 │ 48 kHz s16le frames (sys, mic)
                                   ┌─────────────▼─────────────┐
                                   │  shared pipeline (Rust)   │
                                   │  AEC → RNNoise → audio_dsp │  ← audio_dsp gains LUFS leveler
                                   │  (HPF→gate→leveler→mix→    │
                                   │   mix-HPF→true-peak limit) │
                                   └───────┬───────────┬────────┘
                                           │           │
                              progressive MP3      per-chunk MP3 (chunk_NNNN.mp3)
                              (final artifact)          │
                                                        ▼
                                    concurrent DeepInfra Whisper per chunk
                                          → ordered, overlap-stitched transcript
```

Key move: **one shared processing function** consumed by every OS recorder (Windows included), so DSP,
RNNoise, AEC, and the LUFS leveler are identical everywhere. Windows stops using `mix_windows_frames`
and feeds its decoded/normalized 48 kHz frames into the shared chain (A1 fixed).

---

## 5. Implementation roadmap (prioritized, reversible)

Phases are ordered by value/safety. Each ends green on `cargo check && cargo clippy && cargo test`
(Linux is locally verifiable; **Windows/macOS cannot be compiled here** — those edits are written
carefully and flagged for the owner to build).

- **P0 — Correctness fixes that don't need redesign** (safe now): H1 (RT ringbuf on Linux), M1 tail
  carry-over, M2 worker/session-dir race, M3/M4/M5 mono+stereo DSP, L2 limiter per-frame. Linux-verifiable.
- **P1 — LUFS leveler in `audio_dsp.rs`** (Pillar 1): add `ebur128`, two-stage measure→smoothed-gain,
  unit tests on tone/speech. Linux-verifiable.
- **P2 — Concurrent chunked transcription** (Pillar 3): recorder emits `chunk_NNNN.mp3`; new Tauri
  command + events; `agent.rs` per-chunk transcribe with bounded concurrency + overlap-stitch; delete
  byte-split; frontend collects ordered partials. Backend Linux-verifiable; wire-up testable.
- **P3 — Unify Windows onto the shared chain** (A1) + Windows lifecycle (H2/H3 belong here too, M6, L3,
  L4): biggest behavioral win; **needs a Windows build to verify** — written + flagged.
- **P4 — AEC default-on + correctness** (Pillar 2): APM path frame-aligned + default-on + toggle; then
  OS-native cancellers (Linux module-echo-cancel, macOS VPIO) as reliability follow-ups.
- **P5 — Resampling via `rubato`** (A5) + macOS chunked/streaming (A3) + remaining lows.

## 6. Risks / notes

- **No Windows/macOS toolchain here** → P3/P4/P5 platform code is verified by reasoning + shared-module
  tests only; the owner must build on those OSes. Each such edit is marked `// VERIFY-ON-<os>`.
- **`module-echo-cancel` / VPIO** are environment-dependent; always keep the in-pipeline APM fallback so
  a missing OS canceller degrades gracefully, never breaks recording.
- **Session usage limit** was hit mid-research (resets 05:40 Asia/Jakarta) — the deep web-research
  fan-out could not complete; decisions above rely on primary standards already retrieved + domain
  knowledge. Re-run the research workflow after reset to add citations if desired.

## Sources
- EBU R128 loudness standard — https://tech.ebu.ch/docs/r/r128.pdf
- EBU R128 streaming supplement — https://tech.ebu.ch/docs/r/r128s2.pdf
- DeepInfra whisper-large-v3-turbo — https://deepinfra.com/openai/whisper-large-v3-turbo
- (to add after limit reset) WebRTC AEC3, rubato docs.rs, faster-whisper/WhisperX VAD chunking
