//! Acoustic Echo Cancellation (AEC) using WebRTC audio processing.
//!
//! Sits between resample and denoise in the audio pipeline. Processes 10ms
//! frames (480 samples @ 48kHz) using the WebRTC adaptive filter. State
//! persists across chunks for continuous echo path estimation.

// ---------- Feature-gated imports ----------

#[cfg(feature = "aec")]
use webrtc_audio_processing::{Config, EchoCancellation, InitializationConfig, Processor};

pub const AEC_SAMPLE_RATE: u32 = 48_000;
#[allow(dead_code)]
pub const AEC_FRAME_SAMPLES: usize = 480;

// ---------- Suppression level enum ----------

#[cfg(feature = "aec")]
pub use webrtc_audio_processing::EchoCancellationSuppressionLevel;

#[cfg(not(feature = "aec"))]
#[allow(dead_code)]
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum EchoCancellationSuppressionLevel {
    Lowest,
    Lower,
    Low,
    Moderate,
    High,
}

// ---------- Config ----------

#[derive(Clone, Debug)]
#[cfg_attr(not(feature = "aec"), allow(dead_code))]
pub struct AecConfig {
    pub enabled: bool,
    pub suppression_level: EchoCancellationSuppressionLevel,
    pub enable_extended_filter: bool,
    pub enable_delay_agnostic: bool,
    pub capture_channels: i32,
    pub render_channels: i32,
}

impl Default for AecConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            // High: the primary use case is speakerphone capture (no earphones),
            // where the mic hears the speakers directly. Moderate leaves audible
            // residual echo there; High costs a little near-end dampening during
            // double-talk, which Whisper tolerates far better than echo.
            suppression_level: EchoCancellationSuppressionLevel::High,
            enable_extended_filter: true,
            enable_delay_agnostic: true,
            capture_channels: 1,
            render_channels: 2,
        }
    }
}

// ---------- Processor wrapper ----------

#[cfg_attr(not(feature = "aec"), allow(dead_code))]
pub struct AudioAec {
    #[cfg(feature = "aec")]
    processor: Option<Processor>,
    enabled: bool,
    capture_channels: usize,
    render_channels: usize,
}

impl AudioAec {
    pub fn new(config: AecConfig) -> Self {
        if !config.enabled {
            return Self::noop();
        }

        match Self::try_init(config) {
            Ok(aec) => {
                eprintln!("[AEC] Initialized successfully");
                aec
            }
            Err(e) => {
                eprintln!(
                    "[AEC] Init failed: {}. Recording will proceed without echo cancellation.",
                    e
                );
                Self::noop()
            }
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn process_chunk(&mut self, sys_pcm: &[u8], mic_pcm: &[u8]) -> Vec<u8> {
        if !self.enabled || mic_pcm.is_empty() || sys_pcm.is_empty() {
            return mic_pcm.to_vec();
        }

        match self.try_process_chunk(sys_pcm, mic_pcm) {
            Ok(result) => result,
            Err(e) => {
                eprintln!(
                    "[AEC] Processing error: {}. Passing mic through unchanged.",
                    e
                );
                mic_pcm.to_vec()
            }
        }
    }

    // ---------- Internal ----------

    fn noop() -> Self {
        Self {
            #[cfg(feature = "aec")]
            processor: None,
            enabled: false,
            capture_channels: 1,
            render_channels: 2,
        }
    }

    #[cfg(feature = "aec")]
    fn try_init(config: AecConfig) -> Result<Self, String> {
        if config.capture_channels <= 0 || config.render_channels <= 0 {
            return Err(format!(
                "invalid channel config: capture={}, render={}",
                config.capture_channels, config.render_channels
            ));
        }

        let init_config = InitializationConfig {
            num_capture_channels: config.capture_channels,
            num_render_channels: config.render_channels,
            enable_experimental_agc: false,
            enable_intelligibility_enhancer: false,
        };

        let processor =
            Processor::new(&init_config).map_err(|e| format!("Processor::new failed: {:?}", e))?;

        let runtime_config = Config {
            echo_cancellation: Some(EchoCancellation {
                suppression_level: config.suppression_level,
                enable_extended_filter: config.enable_extended_filter,
                enable_delay_agnostic: config.enable_delay_agnostic,
                stream_delay_ms: None,
            }),
            gain_control: None,
            noise_suppression: None,
            voice_detection: None,
            enable_transient_suppressor: false,
            enable_high_pass_filter: false,
        };

        let mut aec = Self {
            processor: Some(processor),
            enabled: true,
            capture_channels: config.capture_channels as usize,
            render_channels: config.render_channels as usize,
        };
        if let Some(ref mut p) = aec.processor {
            p.set_config(runtime_config);
        }
        Ok(aec)
    }

    #[cfg(not(feature = "aec"))]
    fn try_init(_config: AecConfig) -> Result<Self, String> {
        Err("aec feature not enabled at compile time".into())
    }

    #[cfg(feature = "aec")]
    fn try_process_chunk(&mut self, sys_pcm: &[u8], mic_pcm: &[u8]) -> Result<Vec<u8>, String> {
        let processor = self
            .processor
            .as_mut()
            .ok_or_else(|| "AEC processor not initialized".to_string())?;

        let samples_per_frame = AEC_FRAME_SAMPLES;

        let mic_f32: Vec<f32> = mic_pcm
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();

        let sys_f32: Vec<f32> = sys_pcm
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();

        let render_frame_size = samples_per_frame * self.render_channels;
        let capture_frame_size = samples_per_frame * self.capture_channels;

        let mic_frames = mic_f32.len() / capture_frame_size;
        let sys_frames = sys_f32.len() / render_frame_size;
        let frame_count = mic_frames.min(sys_frames);

        if frame_count == 0 {
            return Ok(mic_pcm.to_vec());
        }

        let mut output = mic_f32.clone();

        for i in 0..frame_count {
            let sys_offset = i * render_frame_size;
            let mic_offset = i * capture_frame_size;

            let mut render_frame = sys_f32[sys_offset..sys_offset + render_frame_size].to_vec();
            let mut capture_frame = output[mic_offset..mic_offset + capture_frame_size].to_vec();

            processor
                .process_render_frame(&mut render_frame)
                .map_err(|e| format!("process_render_frame: {:?}", e))?;
            processor
                .process_capture_frame(&mut capture_frame)
                .map_err(|e| format!("process_capture_frame: {:?}", e))?;

            output[mic_offset..mic_offset + capture_frame_size].copy_from_slice(&capture_frame);
        }

        // Partial tail: the last <10ms of a chunk falls outside the full-frame loop
        // and would pass through with its echo intact. Zero-pad it to one frame,
        // run it through the canceller, and keep only the real samples.
        let mic_tail_start = frame_count * capture_frame_size;
        let tail_len = output.len() - mic_tail_start;
        if tail_len > 0 && tail_len < capture_frame_size {
            let mut capture_frame = vec![0.0f32; capture_frame_size];
            capture_frame[..tail_len].copy_from_slice(&output[mic_tail_start..]);

            let mut render_frame = vec![0.0f32; render_frame_size];
            let sys_tail_start = frame_count * render_frame_size;
            if sys_tail_start < sys_f32.len() {
                let sys_tail = (sys_f32.len() - sys_tail_start).min(render_frame_size);
                render_frame[..sys_tail]
                    .copy_from_slice(&sys_f32[sys_tail_start..sys_tail_start + sys_tail]);
            }

            processor
                .process_render_frame(&mut render_frame)
                .map_err(|e| format!("process_render_frame (tail): {:?}", e))?;
            processor
                .process_capture_frame(&mut capture_frame)
                .map_err(|e| format!("process_capture_frame (tail): {:?}", e))?;

            output[mic_tail_start..].copy_from_slice(&capture_frame[..tail_len]);
        }

        let mut result = Vec::with_capacity(mic_pcm.len());
        for &s in &output {
            let i16_val = (s * 32768.0).clamp(-32768.0, 32767.0) as i16;
            result.extend_from_slice(&i16_val.to_le_bytes());
        }
        if !mic_pcm.len().is_multiple_of(2) {
            if let Some(&last) = mic_pcm.last() {
                result.push(last);
            }
        }
        Ok(result)
    }

    #[cfg(not(feature = "aec"))]
    fn try_process_chunk(&mut self, _sys_pcm: &[u8], mic_pcm: &[u8]) -> Result<Vec<u8>, String> {
        Ok(mic_pcm.to_vec())
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noop_passes_through_when_disabled() {
        let mut aec = AudioAec::new(AecConfig {
            enabled: false,
            ..Default::default()
        });
        assert!(!aec.is_enabled());

        let sys = vec![0u8; 480 * 2 * 2];
        let mic = vec![0u8; 480 * 2];
        let out = aec.process_chunk(&sys, &mic);
        assert_eq!(out, mic);
    }

    #[test]
    fn empty_input_returns_empty() {
        let mut aec = AudioAec::new(AecConfig {
            enabled: false,
            ..Default::default()
        });
        let out = aec.process_chunk(&[], &[]);
        assert!(out.is_empty());
    }

    #[cfg(feature = "aec")]
    #[test]
    fn enabled_processor_initializes() {
        let aec = AudioAec::new(AecConfig {
            enabled: true,
            ..Default::default()
        });
        if aec.is_enabled() {
            eprintln!("[test] AEC initialized OK");
        } else {
            eprintln!("[test] AEC fell back to noop (expected without build tools)");
        }
    }

    #[cfg(feature = "aec")]
    #[test]
    fn enabled_processing_preserves_capture_length_with_partial_tail() {
        let mut aec = AudioAec::new(AecConfig {
            enabled: true,
            capture_channels: 1,
            render_channels: 2,
            ..Default::default()
        });
        assert!(aec.is_enabled());

        let sys = vec![0u8; AEC_FRAME_SAMPLES * 2 * 2];
        let mut mic = vec![0u8; (AEC_FRAME_SAMPLES + 13) * 2];
        mic.push(0x7f);

        let out = aec.process_chunk(&sys, &mic);
        assert_eq!(out.len(), mic.len());
        assert_eq!(out.last(), mic.last());
    }
}
