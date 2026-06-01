pub struct AudioDsp {
    target_rms: f32,
    system_gain: f32,
    mic_gain: f32,
    mix_headroom: f32,
    agc_state: f32,
    agc_smoothing: f32,
    noise_gate_threshold: f32,
    noise_gate_attack: f32,
    noise_gate_release: f32,
    gate_envelope: f32,
    gate_floor: f32,
    mic_hp_coeff: f32,
    mic_hp_prev_in: [f32; 2],
    mic_hp_prev_out: [f32; 2],
    mic_lp_alpha: f32,
    mic_lp_prev_out: [f32; 2],
    mix_hp_coeff: f32,
    mix_hp_prev_in: [f32; 2],
    mix_hp_prev_out: [f32; 2],
}

impl AudioDsp {
    pub fn new(system_gain_db: f32) -> Self {
        let fs = 48000.0_f32;

        Self {
            // Speech transcription works better with headroom than with loud mastered audio.
            target_rms: 0.10,
            system_gain: db_to_linear(system_gain_db),
            mic_gain: db_to_linear(-3.0),
            mix_headroom: 0.58,
            agc_state: 1.0,
            agc_smoothing: 0.025,
            // Soft expander: suppress idle-room hiss without chopping syllable tails.
            noise_gate_threshold: 0.015,
            noise_gate_attack: 1.0 - (-1.0 / (0.003 * fs)).exp(),
            noise_gate_release: (-1.0 / (0.12 * fs)).exp(),
            gate_envelope: 0.0,
            gate_floor: 0.06,
            mic_hp_coeff: highpass_coeff(120.0, fs),
            mic_hp_prev_in: [0.0; 2],
            mic_hp_prev_out: [0.0; 2],
            mic_lp_alpha: lowpass_alpha(8_500.0, fs),
            mic_lp_prev_out: [0.0; 2],
            mix_hp_coeff: highpass_coeff(70.0, fs),
            mix_hp_prev_in: [0.0; 2],
            mix_hp_prev_out: [0.0; 2],
        }
    }

    pub fn process(&mut self, sys_pcm: &[u8], mic_pcm: &[u8]) -> Vec<i16> {
        let sys_f = pcm_bytes_to_f32(sys_pcm);
        let mic_f = pcm_bytes_to_f32(mic_pcm);

        let min_len = align_to_stereo(sys_f.len().min(mic_f.len()));
        if min_len == 0 {
            return Vec::new();
        }

        let mut mixed = Vec::with_capacity(min_len);
        for i in 0..min_len {
            let channel = i % 2;
            let mic = self.apply_mic_cleanup(mic_f[i], channel);
            let mic = mic * self.noise_gate_gain(mic.abs()) * self.mic_gain;
            let system = sys_f[i] * self.system_gain;
            let sum = (system + mic) * self.mix_headroom;
            let filtered = self.apply_mix_highpass(sum, channel);
            mixed.push(soft_limit(filtered));
        }

        let rms = compute_rms(&mixed);
        if rms > 0.001 {
            let desired = self.target_rms / rms;
            let clamped = desired.clamp(0.45, 1.8);
            self.agc_state += (clamped - self.agc_state) * self.agc_smoothing;
        }

        let gain = self.agc_state;
        mixed
            .iter()
            .map(|&s| {
                let out = soft_limit(s * gain).clamp(-0.88, 0.88);
                (out * 32767.0) as i16
            })
            .collect()
    }

    fn noise_gate_gain(&mut self, abs_sample: f32) -> f32 {
        if abs_sample > self.gate_envelope {
            self.gate_envelope += (abs_sample - self.gate_envelope) * self.noise_gate_attack;
        } else {
            self.gate_envelope = self.gate_envelope * self.noise_gate_release
                + abs_sample * (1.0 - self.noise_gate_release);
        }

        let ratio = (self.gate_envelope / self.noise_gate_threshold).clamp(0.0, 1.0);
        let smooth = ratio * ratio * (3.0 - 2.0 * ratio);
        self.gate_floor + (1.0 - self.gate_floor) * smooth
    }

    fn apply_mic_cleanup(&mut self, input: f32, channel: usize) -> f32 {
        let hp = self.mic_hp_coeff
            * (self.mic_hp_prev_out[channel] + input - self.mic_hp_prev_in[channel]);
        self.mic_hp_prev_in[channel] = input;
        self.mic_hp_prev_out[channel] = hp;

        let lp = self.mic_lp_prev_out[channel]
            + self.mic_lp_alpha * (hp - self.mic_lp_prev_out[channel]);
        self.mic_lp_prev_out[channel] = lp;
        lp
    }

    fn apply_mix_highpass(&mut self, input: f32, channel: usize) -> f32 {
        let output = self.mix_hp_coeff
            * (self.mix_hp_prev_out[channel] + input - self.mix_hp_prev_in[channel]);
        self.mix_hp_prev_in[channel] = input;
        self.mix_hp_prev_out[channel] = output;
        output
    }
}

fn align_to_stereo(len: usize) -> usize {
    len - (len % 2)
}

fn pcm_bytes_to_f32(data: &[u8]) -> Vec<f32> {
    data.chunks_exact(2)
        .map(|c| {
            let s = i16::from_le_bytes([c[0], c[1]]);
            s as f32 / 32767.0
        })
        .collect()
}

fn soft_limit(x: f32) -> f32 {
    if x.abs() > 0.78 {
        x.signum() * (0.78 + (1.0 - (-(x.abs() - 0.78) * 8.0).exp()) * 0.10)
    } else {
        x
    }
}

fn highpass_coeff(cutoff_hz: f32, sample_rate: f32) -> f32 {
    1.0 / (1.0 + 2.0 * std::f32::consts::PI * cutoff_hz / sample_rate)
}

fn lowpass_alpha(cutoff_hz: f32, sample_rate: f32) -> f32 {
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_hz);
    let dt = 1.0 / sample_rate;
    dt / (rc + dt)
}

fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|&s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}
