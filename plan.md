# AEC (Acoustic Echo Cancellation) Implementation Plan

**Status:** Planning
**Goal:** "Install app → record → AEC otomatis jalan di Linux/Windows/macOS, tanpa setup manual"

---

## Context

User report: device audio "kenceng, cempreng, gak bold" saat record tanpa earphone.

**Root cause:** Speaker output bocor ke mic built-in (kebanyakan laptop combo jack, speaker + mic di ALSA card yang sama). Mic captures speaker audio, lalu di-mix dengan sys audio → device audio muncul 2x (digital + bocoran akustik) + comb filter = harsh/shrill.

**Solusi terbaik:** AEC (Acoustic Echo Cancellation) — software yang "tau" audio mana yang user denger (reference signal dari sys), lalu cancel-nya dari mic input.

**Quality benchmark:** WebRTC AEC (dipake Chrome/Zoom/Discord) — battle-tested, low CPU, BSD-3 license.

---

## Per-Platform Analysis

### Linux (PulseAudio / PipeWire)
- **Module `module-echo-cancel`** built-in (webrtc + speex backend)
- **Loaded via:** `pactl load-module module-echo-cancel aec_method=webrtc source_name=... sink_name=...`
- **Verifikasi sistem ini:** `pactl load-module module-echo-cancel aec_method=webrtc source_name=mic_aec sink_name=spk_aec` → ID 536870916, source `mic_aec` registered
- **Effort:** 30 menit
- **Quality:** ⭐⭐⭐⭐⭐ (sama dengan Chrome)

### Windows (WASAPI)
- **Tidak ada AEC built-in** — Microsoft expect apps pakai library sendiri
- **Opsi:**
  - `webrtc-audio-processing` (C++ lib, BSD-3) — quality tertinggi
  - `speexdsp` (C lib, BSD) — quality medium, build lebih simple
- **Effort:** 2-3 hari (FFI + integrasi + testing)
- **Quality:** ⭐⭐⭐⭐⭐ (webrtc) atau ⭐⭐⭐ (speexdsp)

### macOS (Core Audio)
- **`kAudioUnitSubType_VoiceProcessingIO`** — built-in AEC + AGC + NS, sama kualitasnya dengan FaceTime
- **Atau:** `webrtc-audio-processing` (sama dengan Windows)
- **Effort:** 1-2 hari (VPIO perlu custom AudioUnit) atau 2-3 hari (webrtc)
- **Quality:** ⭐⭐⭐⭐⭐ (VPIO = webrtc)

---

## Phased Rollout

### Phase 1 — Linux Auto-Load (Effort: 30 menit)

**Scope:** Linux desktop only
**Approach:** App detect OS, load `module-echo-cancel` webrtc via `pactl`, set as default source.

**Deliverables:**
1. `src-tauri/src/audio_aec.rs` — new module
2. Wire ke `lib.rs` `setup()` hook
3. Idempotent: kalau module udah loaded, skip
4. Logging: kasih tau user kalau AEC aktif atau gak

**Code sketch:**

```rust
// src-tauri/src/audio_aec.rs
use std::process::Command;

const AEC_SOURCE: &str = "atok_mic_aec";
const AEC_SINK: &str = "atok_spk_aec";

#[cfg(target_os = "linux")]
pub fn setup_linux_aec() -> Result<bool, String> {
    // 1. Check if AEC source already exists (idempotent)
    let exists = Command::new("pactl")
        .args(&["list", "short", "sources"])
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.contains(AEC_SOURCE))
        .unwrap_or(false);
    
    if exists {
        eprintln!("[aec] AEC source '{}' already loaded", AEC_SOURCE);
        let _ = Command::new("pactl")
            .args(&["set-default-source", AEC_SOURCE])
            .output();
        return Ok(true);
    }
    
    // 2. Load module
    let load = Command::new("pactl")
        .args(&["load-module", "module-echo-cancel",
                "aec_method=webrtc",
                &format!("source_name={}", AEC_SOURCE),
                &format!("sink_name={}", AEC_SINK)])
        .output();
    
    match load {
        Ok(out) if out.status.success() => {
            let _ = Command::new("pactl")
                .args(&["set-default-source", AEC_SOURCE])
                .output();
            eprintln!("[aec] AEC enabled: {}", AEC_SOURCE);
            Ok(true)
        }
        _ => {
            eprintln!("[aec] module-echo-cancel not available, recording without AEC");
            Ok(false)
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub fn setup_linux_aec() -> Result<bool, String> { Ok(false) }
```

**Integration di `lib.rs`:**

```rust
.setup(|app| {
    // Initialize AEC for current OS
    let _ = audio_aec::setup_linux_aec();
    // ... existing setup ...
    Ok(())
})
```

**Testing:**
1. `cargo build` → no errors
2. Run app → check log: `[aec] AEC enabled: atok_mic_aec`
3. Record 2-3 min tanpa earphone → device audio harusnya gak double
4. Verify MP3: device audio di MP3 ~1x (cancelled bocoran)
5. Test idempotency: restart app, gak double-load module

**Risks & mitigations:**
- `pactl` gak ada di PATH → fallback gracefully (log warning, AEC off)
- Module gagal load (missing dep) → fallback gracefully
- User re-run app → idempotency check skip load kedua kali

---

### Phase 2 — Cross-Platform AEC (Effort: 2-3 hari)

**Scope:** Windows + macOS + Linux fallback
**Approach:** Integrate `webrtc-audio-processing` di Rust.

**Library evaluation:**

| Crate | Status | Last update | Notes |
|-------|--------|-------------|-------|
| `webrtc-audio-processing` | Active | 2024 | Pure Rust wrapper around C++ lib |
| `webrtc-audio-processing-sys` | Active | 2024 | FFI bindings only |
| `speexdsp` | Active | 2023 | Lighter, BSD |

**Decision:** `webrtc-audio-processing` (battle-tested, Chrome-quality).

**Architecture:**

```
mic_raw → WebRTC APM (process_capture) → clean_mic → mix with sys
sys_raw → WebRTC APM (process_render) → reference signal
```

Per-frame processing:
- `apm.process_render(&sys_frame)` — feed reference
- `apm.process_capture(&mic_frame)` — clean mic using reference

**Sample rate constraint:** webrtc-audio-processing requires 16kHz, 32kHz, or 48kHz. Kita udah pake 48kHz. ✓

**Channel constraint:** mono mic in, stereo sys render. ✓

**Implementation steps:**

1. **Add dependency:**
   ```toml
   # src-tauri/Cargo.toml
   [dependencies]
   webrtc-audio-processing = "0.3"
   ```

2. **Create `audio_aec.rs`:**
   ```rust
   use webrtc_audio_processing::{AudioProcessing, Config, SampleRate};
   
   pub struct AecProcessor {
       apm: AudioProcessing,
       frame_size: usize,
   }
   
   impl AecProcessor {
       pub fn new(sample_rate: u32, mic_ch: u32, sys_ch: u32) -> Result<Self, String> {
           let mut apm = AudioProcessing::new();
           apm.set_sample_rate(SampleRate::Hz48000);
           // ... config
           Ok(Self { apm, frame_size: sample_rate as usize / 100 })  // 10ms @ 48kHz
       }
       
       pub fn process_frame(&mut self, mic: &mut [f32], sys: &[f32]) {
           self.apm.process_render(sys);
           self.apm.process_capture(mic);
       }
   }
   ```

3. **Integrate di mic capture path:**
   - Linux/macOS/Windows: di `record_linux`, `record_macos`, `record_with_cpal`
   - Pass sys buffer to AecProcessor
   - Process mic with sys as reference

4. **Frame alignment:** 10ms frames (480 samples @ 48kHz). Chunked pipeline already aligns at 3-min rotation, but AEC needs 10ms frames for `process_frame` calls.

5. **Testing:**
   - Test di Linux: WebRTC AEC vs `module-echo-cancel` — quality sama?
   - Test di Windows: install Windows build, record tanpa earphone
   - Test di macOS: install macOS build, record tanpa earphone
   - **Caveat:** user belum punya Windows/macOS build env, test terbatas

**Build complexity:**
- `webrtc-audio-processing` = C++ library, butuh C++ compiler
- Linux: gcc/g++ udah ada
- Windows: MSVC build tools (Visual Studio Build Tools)
- macOS: Xcode command line tools
- Tauri udah require C++ toolchain, jadi gak extra setup

**Binary size impact:** ~5-15MB (webrtc-audio-processing statically linked)

**Risks & mitigations:**
- Build failure di salah satu platform → fallback ke Phase 1 (Linux) atau skip AEC
- Audio quality regression → A/B test webrtc vs RNNoise-only
- CPU usage naik ~1-2% per channel → acceptable untuk desktop app

---

### Phase 3 — macOS VPIO Optimization (Effort: 1-2 hari, OPTIONAL)

**Scope:** macOS only, replace webrtc with native VPIO
**Approach:** Custom AudioUnit dengan `kAudioUnitSubType_VoiceProcessingIO`

**Quality benefit:** Sama dengan webrtc, tapi lebih efficient (hardware-accelerated di Apple Silicon)

**Implementation:** Core Audio AudioUnit, 200+ lines C-style code, butuh `coreaudio-rs` atau `coreaudio` crate + `audio-toolbox` bindings

**Effort:** 1-2 hari + testing di macOS

**Decision:** **Defer.** Phase 2 udah cukup bagus. VPIO = nice-to-have, not critical.

---

### Phase 4 — UI Settings Toggle (Effort: 1 jam)

**Scope:** Frontend toggle untuk disable AEC kalau user mau raw mic

**Use case:** Pro audio engineer mau raw mic tanpa processing

**Implementation:**
- Frontend: switch di Settings
- IPC: send to backend
- Backend: per-session flag, skip AEC processing

**Decision:** Nice-to-have, implement kalau ada waktu.

---

## Critical: Why This Matters

Tanpa AEC, app kita hanya bekerja optimal **dengan earphone**. Itu limitasi besar untuk use case:
- Meeting offline (multi-person, 1 mic)
- Conference recording (1 orang, 1 mic, dengan speaker)
- Voice memo saat presentasi

**Dengan AEC, app kita jadi 95% real-world ready:** user install, pakai speaker built-in, dapat clean recording.

---

## Open Questions untuk User

1. **Target release timing:** Phase 1 siap implement sekarang (30 menit). Phase 2 butuh 2-3 hari (cross-platform). User mau gas Phase 1 dulu atau langsung Phase 2?

2. **Binary size tradeoff:** WebRTC adds ~10MB ke binary. Acceptable?

3. **Fallback strategy:** Kalau webrtc-audio-processing gagal build di salah satu platform, fallback ke speexdsp atau no AEC?

---

## Implementation Order (Recommended)

1. **Phase 1 (Linux auto-load)** — implement & test hari ini
2. **Phase 4 (UI toggle)** — quick win, 1 jam
3. **Phase 2 (cross-platform webrtc)** — sprint 2-3 hari
4. **Phase 3 (macOS VPIO)** — defer / nice-to-have

---

## Reference Material

- WebRTC audio_processing: https://chromium.googlesource.com/external/webrtc/+/master/modules/audio_processing/
- PulseAudio module-echo-cancel: https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Modules/#module-echo-cancel
- macOS VPIO: https://developer.apple.com/documentation/audiotoolkit/voice_processing_io_audio_unit
- PipeWire AEC: https://docs.pipewire.org/page_module_echo_cancel.html

---

## Status Checklist

- [x] Plan written
- [ ] Phase 1: Linux auto-load implemented
- [ ] Phase 1: Linux auto-load tested by user
- [ ] Phase 1: Phase 1 committed + pushed
- [ ] Phase 4: UI toggle implemented
- [ ] Phase 2: webrtc-audio-processing dependency added
- [ ] Phase 2: cross-platform AEC working on Linux
- [ ] Phase 2: cross-platform AEC working on Windows
- [ ] Phase 2: cross-platform AEC working on macOS
- [ ] Phase 3: macOS VPIO (deferred)
