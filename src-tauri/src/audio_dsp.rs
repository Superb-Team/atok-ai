//! Audio DSP processing for mic + system audio mixing.
//!
//! Signal chain per chunk:
//!   mic → HPF 80Hz → noise gate → gain → mix with sys → HPF 40Hz → true-peak limiter → i16
//!
//! Design principles:
//!   - No per-sample AGC (causes pumping, destroys prosody for Whisper)
//!   - Fixed gain staging (predictable, no adaptation artifacts)
//!   - Single limiter at the end (no cascaded compression)
//!   - No mic LPF (Whisper needs full bandwidth for sibilant recognition)
//!   - Noise gate with soft knee (no hard on/off transitions)

/// Adaptive loudness leveler: slews a gain toward the value that lands the
/// stream at `target_lufs` (BS.1770 K-weighted) instead of using a fixed gain,
/// so speech sits at a consistent level across a long meeting. Near-silent
/// windows hold the gain (never amplifies room tone or digital silence).
struct LoudnessLeveler {
    target_lufs: f32,
    min_gain_db: f32,
    max_gain_db: f32,
    gain: f32,
    // Buffer short callbacks until there is enough audio to measure.
    accum: Vec<f32>,
}

impl LoudnessLeveler {
    fn new(target_lufs: f32, min_gain_db: f32, max_gain_db: f32, initial_gain_db: f32) -> Self {
        Self {
            target_lufs,
            min_gain_db,
            max_gain_db,
            gain: db_to_linear(initial_gain_db),
            accum: Vec::new(),
        }
    }

    /// Feed interleaved stereo samples; downmixes to mono so the 48kHz
    /// K-weighting sees the correct time base, then re-levels once a full
    /// measurement window is available.
    fn update(&mut self, stereo: &[f32]) {
        // Fast path: a large buffer (Linux 3-min chunk / macOS whole take) already
        // exceeds the window — measure it directly with no cross-call buffering.
        if self.accum.is_empty() && stereo.len() / 2 >= LEVELER_WINDOW_SAMPLES {
            let mono: Vec<f32> = stereo
                .chunks_exact(2)
                .map(|p| 0.5 * (p[0] + p[1]))
                .collect();
            self.measure(&mono);
            return;
        }
        self.accum
            .extend(stereo.chunks_exact(2).map(|p| 0.5 * (p[0] + p[1])));
        if self.accum.len() >= LEVELER_WINDOW_SAMPLES {
            let buf = std::mem::take(&mut self.accum);
            self.measure(&buf);
        }
    }

    fn measure(&mut self, mono: &[f32]) {
        if let Some(lufs) = kweighted_lufs(mono) {
            let gain_db = (self.target_lufs - lufs).clamp(self.min_gain_db, self.max_gain_db);
            let desired = db_to_linear(gain_db);
            self.gain = self.gain * 0.4 + desired * 0.6;
        }
    }
}

pub struct AudioDsp {
    mic_leveler: LoudnessLeveler,
    // System audio also gets leveled: the PulseAudio monitor signal follows the
    // sink volume, so remote voices arrive as quiet as the user's earphone knob.
    // A wider up-side clamp lets the leveler recover a low playback volume.
    sys_leveler: LoudnessLeveler,
    mix_headroom: f32,

    // Noise gate — envelope follower with soft knee
    noise_gate_threshold: f32,
    noise_gate_attack: f32,
    noise_gate_release: f32,
    gate_envelope: [f32; 2], // per channel
    gate_floor: f32,

    // Mic high-pass filter (80Hz, 2nd-order Butterworth)
    mic_hp_b: [f32; 3],
    mic_hp_a: [f32; 3],
    mic_hp_x: [[f32; 2]; 2], // [channel][delay]
    mic_hp_y: [[f32; 2]; 2],

    // Mix high-pass filter (40Hz, removes DC/subsonic)
    mix_hp_b: [f32; 3],
    mix_hp_a: [f32; 3],
    mix_hp_x: [[f32; 2]; 2],
    mix_hp_y: [[f32; 2]; 2],

    // True-peak limiter state
    limiter_gain: f32,
    limiter_envelope: f32,
}

impl AudioDsp {
    pub const DEFAULT_SYSTEM_TRIM_DB: f32 = 3.0;
    const MIC_TARGET_LUFS: f32 = -22.0;
    const SYSTEM_TARGET_LUFS: f32 = -19.0;

    pub fn new(system_gain_db: f32) -> Self {
        let fs = 48000.0_f32;

        // 2nd-order Butterworth HPF at 80Hz (cascaded two 1st-order sections)
        let (b80, a80) = butterworth_hpf_coeffs(80.0, fs);
        // 2nd-order Butterworth HPF at 40Hz
        let (b40, a40) = butterworth_hpf_coeffs(40.0, fs);

        Self {
            // Start with a small mic cut and system boost; the levelers converge per chunk.
            // Headset meetings usually contain a local mic that is hotter than
            // the playback monitor. Keep remote speech slightly forward while
            // retaining headroom for the final limiter.
            mic_leveler: LoudnessLeveler::new(Self::MIC_TARGET_LUFS, -18.0, 12.0, -9.0),
            sys_leveler: LoudnessLeveler::new(
                Self::SYSTEM_TARGET_LUFS,
                -12.0,
                18.0,
                system_gain_db,
            ),
            // Keep the sum below the limiter for normal speech.
            mix_headroom: 0.60,

            noise_gate_threshold: 0.03,
            noise_gate_attack: 1.0 - (-1.0 / (0.015 * fs)).exp(), // 15ms attack
            noise_gate_release: (-1.0 / (0.250 * fs)).exp(),      // 250ms release
            gate_envelope: [0.0; 2],
            gate_floor: 0.01,

            mic_hp_b: b80,
            mic_hp_a: a80,
            mic_hp_x: [[0.0; 2]; 2],
            mic_hp_y: [[0.0; 2]; 2],

            mix_hp_b: b40,
            mix_hp_a: a40,
            mix_hp_x: [[0.0; 2]; 2],
            mix_hp_y: [[0.0; 2]; 2],

            limiter_gain: 1.0,
            limiter_envelope: 0.0,
        }
    }

    /// Use a gentler gate for speech recognition than for playback.
    pub fn new_for_asr(system_gain_db: f32) -> Self {
        let mut dsp = Self::new(system_gain_db);
        dsp.noise_gate_threshold = 0.012;
        dsp.gate_floor = 0.25;
        dsp
    }

    pub fn process(&mut self, sys_pcm: &[u8], mic_pcm: &[u8]) -> Vec<i16> {
        let sys_f = pcm_bytes_to_f32(sys_pcm);
        let mic_f = pcm_bytes_to_f32(mic_pcm);

        if mic_f.is_empty() && sys_f.is_empty() {
            return Vec::new();
        }

        let has_sys = !sys_f.is_empty();
        let has_mic = !mic_f.is_empty();

        let len = if has_sys && has_mic {
            // Span the LONGER stream and let the shorter read as silence past its
            // end (guarded below). min() would drop the tail every chunk and
            // accumulate A/V desync over a long recording.
            align_to_stereo(sys_f.len().max(mic_f.len()))
        } else if has_sys {
            align_to_stereo(sys_f.len())
        } else {
            align_to_stereo(mic_f.len())
        };

        if len == 0 {
            return Vec::new();
        }

        // Measure each stream's loudness for this chunk and slew its leveler gain
        // toward the target. One gain per chunk → no intra-chunk pumping.
        if has_mic {
            self.mic_leveler.update(&mic_f);
        }
        if has_sys {
            self.sys_leveler.update(&sys_f);
        }

        let mut mixed = Vec::with_capacity(len);

        for i in 0..len {
            let ch = i % 2;

            let mic = if has_mic && i < mic_f.len() {
                let mic_hp = self.apply_mic_hpf(mic_f[i], ch);
                let gate = self.noise_gate_gain(mic_hp.abs(), ch);
                mic_hp * gate * self.mic_leveler.gain
            } else {
                0.0
            };

            // System audio skips the HPF/gate: it's already clean digital audio.
            let sys = if has_sys && i < sys_f.len() {
                sys_f[i] * self.sys_leveler.gain
            } else {
                0.0
            };

            let sum = (sys + mic) * self.mix_headroom;
            let filtered = self.apply_mix_hpf(sum, ch);
            let limited = self.true_peak_limit(filtered);

            mixed.push(limited);
        }

        mixed
            .iter()
            .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect()
    }

    fn noise_gate_gain(&mut self, abs_sample: f32, ch: usize) -> f32 {
        let env = &mut self.gate_envelope[ch];
        if abs_sample > *env {
            *env += (abs_sample - *env) * self.noise_gate_attack;
        } else {
            *env = *env * self.noise_gate_release + abs_sample * (1.0 - self.noise_gate_release);
        }

        let ratio = (*env / self.noise_gate_threshold).clamp(0.0, 1.0);
        // Smooth hermite interpolation for soft knee
        let smooth = ratio * ratio * (3.0 - 2.0 * ratio);
        self.gate_floor + (1.0 - self.gate_floor) * smooth
    }

    fn apply_mic_hpf(&mut self, input: f32, ch: usize) -> f32 {
        let out = self.mic_hp_b[0] * input
            + self.mic_hp_b[1] * self.mic_hp_x[ch][0]
            + self.mic_hp_b[2] * self.mic_hp_x[ch][1]
            - self.mic_hp_a[1] * self.mic_hp_y[ch][0]
            - self.mic_hp_a[2] * self.mic_hp_y[ch][1];
        self.mic_hp_x[ch][1] = self.mic_hp_x[ch][0];
        self.mic_hp_x[ch][0] = input;
        self.mic_hp_y[ch][1] = self.mic_hp_y[ch][0];
        self.mic_hp_y[ch][0] = out;
        out
    }

    fn apply_mix_hpf(&mut self, input: f32, ch: usize) -> f32 {
        let out = self.mix_hp_b[0] * input
            + self.mix_hp_b[1] * self.mix_hp_x[ch][0]
            + self.mix_hp_b[2] * self.mix_hp_x[ch][1]
            - self.mix_hp_a[1] * self.mix_hp_y[ch][0]
            - self.mix_hp_a[2] * self.mix_hp_y[ch][1];
        self.mix_hp_x[ch][1] = self.mix_hp_x[ch][0];
        self.mix_hp_x[ch][0] = input;
        self.mix_hp_y[ch][1] = self.mix_hp_y[ch][0];
        self.mix_hp_y[ch][0] = out;
        out
    }

    /// True-peak limiter with attack/release envelope.
    /// Threshold -3.5dBFS (~0.668): catches peaks early, minimal gain reduction needed.
    /// Ceiling -1.0dBFS (~0.891): safe headroom for MP3 encoding artifacts.
    fn true_peak_limit(&mut self, sample: f32) -> f32 {
        let threshold = 0.668_f32;
        let ceiling = 0.891_f32;
        let abs_s = sample.abs();

        // Envelope follower: 5ms attack (preserves speech transients), 120ms release
        if abs_s > self.limiter_envelope {
            let attack = 1.0_f32 - (-1.0_f32 / (0.005_f32 * 48000.0_f32)).exp();
            self.limiter_envelope += (abs_s - self.limiter_envelope) * attack;
        } else {
            let release = (-1.0_f32 / (0.120_f32 * 48000.0_f32)).exp();
            self.limiter_envelope *= release;
        }

        if self.limiter_envelope > threshold {
            // Attenuate only — never make up gain. When the envelope sits between
            // threshold and ceiling the peak is already safe, so gain clamps to 1.0.
            let gain = (ceiling / self.limiter_envelope.max(0.001)).min(1.0);
            self.limiter_gain = gain;
        } else {
            self.limiter_gain += (1.0 - self.limiter_gain) * 0.01;
        }

        (sample * self.limiter_gain).clamp(-ceiling, ceiling)
    }
}

// ========== DSP helpers ==========

fn butterworth_hpf_coeffs(cutoff_hz: f32, sample_rate: f32) -> ([f32; 3], [f32; 3]) {
    // 2nd-order Butterworth HPF via bilinear transform
    let fc = cutoff_hz / sample_rate;
    let k = (std::f32::consts::PI * fc).tan();
    let k2 = k * k;
    let sqrt2 = std::f32::consts::SQRT_2;
    let norm = 1.0 / (1.0 + sqrt2 * k + k2);

    let b0 = norm;
    let b1 = -2.0 * norm;
    let b2 = norm;
    let a1 = 2.0 * (k2 - 1.0) * norm;
    let a2 = (1.0 - sqrt2 * k + k2) * norm;

    ([b0, b1, b2], [1.0, a1, a2])
}

fn pcm_bytes_to_f32(data: &[u8]) -> Vec<f32> {
    data.chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect()
}

fn align_to_stereo(len: usize) -> usize {
    len - (len % 2)
}

fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

/// Minimum mono samples (100ms @ 48k) the leveler buffers before measuring loudness.
/// Matches the lower bound `kweighted_lufs` needs for a stable estimate.
const LEVELER_WINDOW_SAMPLES: usize = 4800;

/// Integrated loudness (LUFS) of a mono/flat sample buffer via ITU-R BS.1770
/// K-weighting (48 kHz coefficients). Near-silent input (below the ~-70 LUFS
/// absolute gate, or too short) returns None so the leveler holds its gain.
fn kweighted_lufs(samples: &[f32]) -> Option<f32> {
    if samples.len() < 4800 {
        return None; // need >=100ms @48k for a stable estimate
    }
    // Stage 1: high-shelf pre-filter. Stage 2: RLB high-pass.
    const B1: [f32; 3] = [1.535_124_9, -2.691_696_2, 1.198_392_8];
    const A1: [f32; 3] = [1.0, -1.690_659_3, 0.732_480_8];
    const B2: [f32; 3] = [1.0, -2.0, 1.0];
    const A2: [f32; 3] = [1.0, -1.990_047_5, 0.990_072_3];

    let (mut x1, mut y1) = ([0.0f32; 2], [0.0f32; 2]);
    let (mut x2, mut y2) = ([0.0f32; 2], [0.0f32; 2]);
    let mut sum_sq = 0.0f64;
    let mut active = 0u64;

    for &s in samples {
        let w1 = B1[0] * s + B1[1] * x1[0] + B1[2] * x1[1] - A1[1] * y1[0] - A1[2] * y1[1];
        x1[1] = x1[0];
        x1[0] = s;
        y1[1] = y1[0];
        y1[0] = w1;

        let w2 = B2[0] * w1 + B2[1] * x2[0] + B2[2] * x2[1] - A2[1] * y2[0] - A2[2] * y2[1];
        x2[1] = x2[0];
        x2[0] = w1;
        y2[1] = y2[0];
        y2[0] = w2;

        // ~-70 LUFS absolute gate: ignore near-silent samples so the mean square
        // reflects speech, not room tone.
        if w2.abs() > 3.0e-4 {
            sum_sq += (w2 as f64) * (w2 as f64);
            active += 1;
        }
    }

    if active < 2400 {
        return None; // <50ms of active audio → not enough to re-level on
    }
    let mean_sq = (sum_sq / active as f64) as f32;
    if mean_sq <= 1.0e-12 {
        return None;
    }
    Some(-0.691 + 10.0 * mean_sq.log10())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_passes_through() {
        let mut dsp = AudioDsp::new(2.0);
        let sys = vec![0u8; 960 * 2 * 2];
        let mic = vec![0u8; 480 * 2];
        let out = dsp.process(&sys, &mic);
        assert!(!out.is_empty());
        // Silence should produce near-silence
        let peak = out.iter().map(|s| s.abs()).max().unwrap_or(0);
        assert!(peak < 100, "silence produced signal: {}", peak);
    }

    #[test]
    fn signal_stays_bounded() {
        let mut dsp = AudioDsp::new(2.0);
        // 1kHz sine wave, stereo, 48kHz, 10ms (480 frames = 960 interleaved samples)
        let sys: Vec<u8> = (0..960)
            .map(|i| {
                ((i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin() * 30000.0) as i16
            })
            .flat_map(|s| s.to_le_bytes().to_vec())
            .collect();
        let mic: Vec<u8> = (0..960)
            .map(|i| {
                ((i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin() * 20000.0) as i16
            })
            .flat_map(|s| s.to_le_bytes().to_vec())
            .collect();
        for _ in 0..100 {
            let out = dsp.process(&sys, &mic);
            // i16 is always in bounds by type; verify output is non-empty and non-zero
            assert!(!out.is_empty());
            let peak = out.iter().map(|s| s.abs()).max().unwrap_or(0);
            assert!(peak > 0, "DSP produced only zeros");
        }
    }

    #[test]
    fn limiter_prevents_clipping() {
        let mut dsp = AudioDsp::new(6.0);
        // 1kHz sine at full scale, 500ms stereo (48000 interleaved samples)
        let sys: Vec<u8> = (0..48000)
            .map(|i| {
                ((i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin() * 30000.0) as i16
            })
            .flat_map(|s| s.to_le_bytes().to_vec())
            .collect();
        let mic: Vec<u8> = (0..48000)
            .map(|i| {
                ((i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin() * 30000.0) as i16
            })
            .flat_map(|s| s.to_le_bytes().to_vec())
            .collect();
        let out = dsp.process(&sys, &mic);
        // Check settled portion (skip first 50ms — limiter attack transient)
        let settled = &out[4800..];
        let peak = settled.iter().map(|s| s.abs()).max().unwrap_or(0);
        // Limiter ceiling at -1.0dBFS (0.891) → ~29191 i16
        assert!(peak <= 30000, "limiter didn't reduce level: {}", peak);
    }

    #[test]
    fn noise_gate_attenuates_silence() {
        let mut dsp = AudioDsp::new(2.0);
        // 100ms of 1kHz sine at speech level, stereo
        let signal: Vec<u8> = (0..9600)
            .map(|i| {
                ((i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin() * 16000.0) as i16
            })
            .flat_map(|s| s.to_le_bytes().to_vec())
            .collect();
        let sys = vec![0u8; 9600 * 2];
        let out1 = dsp.process(&sys, &signal);

        // 3 seconds of silence — 300ms release needs ~5τ to fully close
        let silence = vec![0u8; 144000 * 2];
        let out2 = dsp.process(&sys, &silence);

        // Check the last 100ms of silence (gate should be fully closed)
        let tail = &out2[out2.len() - 9600..];
        let peak1 = out1.iter().map(|s| s.abs()).max().unwrap_or(0);
        let peak2 = tail.iter().map(|s| s.abs()).max().unwrap_or(0);
        assert!(peak1 > 1000, "speech signal too quiet: {}", peak1);
        assert!(
            peak2 < peak1 / 5,
            "gate didn't close: speech={}, silence_tail={}",
            peak1,
            peak2
        );
    }

    #[test]
    fn biquad_hpf_removes_dc() {
        let mut dsp = AudioDsp::new(2.0);
        // DC signal as stereo (L,R interleaved)
        let signal: Vec<u8> = (0..9600 * 2)
            .flat_map(|_| 16000i16.to_le_bytes().to_vec())
            .collect();
        let out = dsp.process(&signal, &signal);
        let tail = &out[out.len() - 2000..];
        let avg = tail.iter().map(|s| *s as f32).sum::<f32>() / tail.len() as f32;
        assert!(avg.abs() < 500.0, "DC not removed: avg={}", avg);
    }

    fn sine_pcm(amplitude: f32, frames: usize) -> Vec<u8> {
        (0..frames)
            .map(|i| {
                ((i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin()
                    * amplitude
                    * 32767.0) as i16
            })
            .flat_map(|s| s.to_le_bytes())
            .collect()
    }

    #[test]
    fn kweighted_lufs_full_scale_sine_near_minus_3() {
        let sine: Vec<f32> = (0..48000)
            .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin())
            .collect();
        let lufs = kweighted_lufs(&sine).expect("should measure a full-scale sine");
        assert!(lufs > -6.0 && lufs < -1.0, "1kHz full-scale LUFS={}", lufs);
    }

    #[test]
    fn kweighted_lufs_silence_is_none() {
        assert!(kweighted_lufs(&vec![0.0f32; 48000]).is_none());
    }

    #[test]
    fn leveler_raises_gain_for_quiet_mic() {
        let mut dsp = AudioDsp::new(0.0);
        let mic = sine_pcm(0.05, 48000); // ~-30 LUFS, well below the -20 target
        let sys = vec![0u8; 48000 * 2];
        for _ in 0..4 {
            let _ = dsp.process(&sys, &mic);
        }
        assert!(
            dsp.mic_leveler.gain > 1.0,
            "mic leveler gain={}",
            dsp.mic_leveler.gain
        );
    }

    #[test]
    fn sys_leveler_raises_gain_for_quiet_sys() {
        // Quiet monitor signal (user listening at low earphone volume) must be
        // brought up toward the target instead of staying buried under the mic.
        let mut dsp = AudioDsp::new(0.0);
        let sys = sine_pcm(0.05, 48000); // ~-30 LUFS, well below the -20 target
        let mic = vec![0u8; 48000 * 2];
        for _ in 0..4 {
            let _ = dsp.process(&sys, &mic);
        }
        assert!(
            dsp.sys_leveler.gain > 1.0,
            "sys leveler gain={}",
            dsp.sys_leveler.gain
        );
    }

    #[test]
    fn sys_leveler_holds_on_silence() {
        // Digital silence between speech must never be boosted — the loudness
        // gate returns None so the gain holds at its initial value.
        let mut dsp = AudioDsp::new(0.0);
        let sys = vec![0u8; 48000 * 2];
        let mic = vec![0u8; 48000 * 2];
        for _ in 0..4 {
            let _ = dsp.process(&sys, &mic);
        }
        assert!(
            (dsp.sys_leveler.gain - 1.0).abs() < 1e-6,
            "sys leveler moved on silence: {}",
            dsp.sys_leveler.gain
        );
    }

    #[test]
    fn keeps_longer_stream_when_lengths_differ() {
        // Regression for the per-chunk tail-drop: output spans the longer stream
        // (mic here) instead of being truncated to the shorter (sys).
        let mut dsp = AudioDsp::new(0.0);
        let sys = vec![0u8; 1000 * 2 * 2]; // 2000 f32 samples
        let mic = sine_pcm(0.3, 4000); // 4000 f32 samples
        let out = dsp.process(&sys, &mic);
        assert_eq!(out.len(), 4000, "must keep the longer stream, not truncate");
    }

    #[test]
    fn limiter_does_not_amplify_below_ceiling() {
        // A steady level between threshold (0.668) and ceiling (0.891) must not be
        // boosted — a limiter only attenuates. Regression for gain = ceiling/env > 1.
        let mut dsp = AudioDsp::new(0.0);
        let mut out = 0.0;
        for _ in 0..4000 {
            out = dsp.true_peak_limit(0.75);
        }
        assert!(
            out <= 0.75 + 1e-3,
            "limiter amplified steady 0.75 to {}",
            out
        );
    }

    #[test]
    fn leveler_engages_with_tiny_buffers() {
        // Windows feeds ~5ms buffers; the accumulator must still reach a window and
        // re-level. Feed many small quiet mic buffers and assert the gain rises.
        let mut dsp = AudioDsp::new(0.0);
        let sys = vec![0u8; 240 * 2 * 2];
        // 240-frame (~5ms) quiet mic buffers, ~-30 LUFS, well below the -20 target.
        let mic = sine_pcm(0.05, 240);
        for _ in 0..60 {
            let _ = dsp.process(&sys, &mic);
        }
        assert!(
            dsp.mic_leveler.gain > 1.0,
            "leveler never engaged with small buffers: {}",
            dsp.mic_leveler.gain
        );
    }

    #[test]
    fn leveler_lowers_gain_for_hot_mic() {
        let mut dsp = AudioDsp::new(0.0);
        let mic = sine_pcm(0.9, 48000); // ~-4.6 LUFS, far above the -20 target
        let sys = vec![0u8; 48000 * 2];
        for _ in 0..4 {
            let _ = dsp.process(&sys, &mic);
        }
        assert!(
            dsp.mic_leveler.gain < 0.45,
            "mic leveler gain={}",
            dsp.mic_leveler.gain
        );
    }

    #[test]
    fn default_targets_keep_system_audio_slightly_above_mic() {
        let mut dsp = AudioDsp::new(0.0);
        let signal = sine_pcm(0.2, 48000);
        for _ in 0..4 {
            let _ = dsp.process(&signal, &signal);
        }

        assert!(
            dsp.sys_leveler.gain > dsp.mic_leveler.gain * 1.1,
            "system gain should retain a small remote-speech bias: system={}, mic={}",
            dsp.sys_leveler.gain,
            dsp.mic_leveler.gain
        );
    }
}
