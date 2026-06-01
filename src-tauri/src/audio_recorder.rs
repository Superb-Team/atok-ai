// Cross-platform audio recorder
//
// Windows: WASAPI loopback + mic (windows_audio.rs)
// Linux:   parec (PulseAudio/PipeWire) + cpal mic
// macOS:   ScreenCaptureKit + cpal mic
// Fallback: cpal mic only

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::audio_dsp::AudioDsp;

pub struct DesktopAudioRecorder {
    is_recording: Arc<AtomicBool>,
    recording_thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
}

impl DesktopAudioRecorder {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            recording_thread: Arc::new(Mutex::new(None)),
        }
    }

    pub fn start_recording(&self, output_path: PathBuf) -> Result<(), String> {
        if self.is_recording.swap(true, Ordering::SeqCst) {
            return Err("Already recording".to_string());
        }

        let is_recording = Arc::clone(&self.is_recording);
        let thread_handle = std::thread::spawn(move || {
            if let Err(e) = Self::record(output_path, is_recording) {
                eprintln!("Recording error: {}", e);
            }
        });

        *self.recording_thread.lock().map_err(|e| e.to_string())? = Some(thread_handle);
        Ok(())
    }

    pub fn stop_recording(&self) -> Result<(), String> {
        if !self.is_recording.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        eprintln!("[recorder] Stop signal sent");

        let mut thread_lock = self.recording_thread.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = thread_lock.take() {
            let join_handle = std::thread::spawn(move || handle.join());
            for i in 0..300 {
                if join_handle.is_finished() {
                    return match join_handle.join() {
                        Ok(Ok(())) => {
                            eprintln!("[recorder] Thread finished OK");
                            Ok(())
                        }
                        Ok(Err(_)) => Err("Recording thread error".to_string()),
                        Err(_) => Err("Recording thread panicked".to_string()),
                    };
                }
                if i % 50 == 0 && i > 0 {
                    eprintln!("[recorder] Waiting for encoding... ({}s)", i / 10);
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            eprintln!("[recorder] Timeout after 30s");
            Ok(())
        } else {
            Ok(())
        }
    }

    pub fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    fn record(output_path: PathBuf, is_recording: Arc<AtomicBool>) -> Result<(), String> {
        let mp3_path = match output_path.extension().and_then(|s| s.to_str()) {
            Some("mp3") => output_path,
            _ => output_path.with_extension("mp3"),
        };

        if let Some(parent) = mp3_path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
        }

        #[cfg(target_os = "linux")]
        {
            match Self::record_linux(&mp3_path, &is_recording) {
                Ok(()) => return Ok(()),
                Err(e) => eprintln!("Linux recording failed: {}, falling back", e),
            }
        }

        #[cfg(target_os = "macos")]
        {
            match Self::record_macos(&mp3_path, &is_recording) {
                Ok(()) => return Ok(()),
                Err(e) => eprintln!("macOS recording failed: {}, falling back to cpal", e),
            }
        }

        Self::record_with_cpal(&mp3_path, &is_recording)
    }

    // ==================== Linux: parec (system) + cpal (mic) ====================

    #[cfg(target_os = "linux")]
    fn record_linux(mp3_path: &Path, is_recording: &Arc<AtomicBool>) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        use cpal::SampleFormat;

        eprintln!("[recorder] Linux capture starting");

        let sys_raw = "/tmp/atok_linux_sys.raw";
        let mic_raw = "/tmp/atok_linux_mic.raw";
        let _ = std::fs::remove_file(sys_raw);
        let _ = std::fs::remove_file(mic_raw);

        // --- System audio via parec (PulseAudio/PipeWire) ---
        let sample_rate = 48000u32;
        let channels = 2u32;
        let sys_device = Self::linux_default_monitor_source();
        if let Some(device) = &sys_device {
            eprintln!("[recorder] System monitor: {}", device);
        }
        let sys_is_rec = is_recording.clone();
        let sys_path = sys_raw.to_string();
        let sys_thread = std::thread::Builder::new()
            .name("parec-sys".into())
            .spawn(move || {
                Self::parec_record(&sys_path, sample_rate, channels, sys_device, &sys_is_rec)
            })
            .map_err(|e| format!("Failed to spawn parec thread: {}", e))?;

        // --- Mic via cpal (native device rate) ---
        let host = cpal::default_host();
        let mic_device = host
            .default_input_device()
            .ok_or("No default input device (mic)")?;

        let mic_cfg_range = mic_device
            .supported_input_configs()
            .map_err(|e| format!("Mic supported_input_configs: {}", e))?
            .find(|c| c.sample_format() == SampleFormat::F32)
            .ok_or("Mic does not support F32")?;

        let mic_cfg = Self::with_preferred_sample_rate(mic_cfg_range, sample_rate);
        let mic_sr = mic_cfg.sample_rate().0;
        let mic_ch = mic_cfg.channels() as u32;

        eprintln!(
            "[recorder] Mic: {}Hz, {}ch, F32 | Sys: {}Hz, {}ch via parec",
            mic_sr, mic_ch, sample_rate, channels
        );

        let mic_buffer: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let mic_buf_c = mic_buffer.clone();

        let mic_stream = mic_device
            .build_input_stream(
                &mic_cfg.config(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mut buf: Vec<u8> = Vec::with_capacity(data.len() * 2);
                    for &s in data {
                        let s16 = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
                        buf.extend_from_slice(&s16.to_le_bytes());
                    }
                    if let Ok(mut b) = mic_buf_c.lock() {
                        b.extend_from_slice(&buf);
                    }
                },
                move |err| eprintln!("[recorder] Mic stream error: {}", err),
                None,
            )
            .map_err(|e| format!("Mic stream build failed: {}", e))?;

        mic_stream
            .play()
            .map_err(|e| format!("Mic play failed: {}", e))?;
        eprintln!("[recorder] Streams playing");

        while is_recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        drop(mic_stream);
        std::thread::sleep(std::time::Duration::from_millis(200));

        let _ = sys_thread.join();

        let sys_data = std::fs::read(sys_raw).unwrap_or_default();
        let mic_data = match Arc::try_unwrap(mic_buffer) {
            Ok(m) => m.into_inner().map_err(|e| e.to_string())?,
            Err(_) => return Err("Mic buffer still locked".into()),
        };

        let _ = std::fs::remove_file(sys_raw);
        eprintln!(
            "[recorder] Captured: sys={} bytes, mic={} bytes",
            sys_data.len(),
            mic_data.len()
        );

        let has_sys = sys_data.len() > 1024;
        let has_mic = mic_data.len() > 1024;

        if !has_sys && !has_mic {
            return Err("No audio captured".into());
        }

        // Resample mic to match system rate if different
        let (sys_final, mic_final, final_sr, final_ch) =
            if has_sys && has_mic && mic_sr != sample_rate {
                let resampled = Self::resample_linear(&mic_data, mic_sr, sample_rate, mic_ch);
                (sys_data, resampled, sample_rate, channels)
            } else if has_sys && has_mic {
                (sys_data, mic_data, sample_rate, channels)
            } else if has_sys {
                (sys_data, Vec::new(), sample_rate, channels)
            } else {
                (Vec::new(), mic_data, mic_sr, mic_ch)
            };

        let mic_final = if has_mic {
            Self::denoise_mic_pcm(&mic_final, final_sr, mic_ch)
        } else {
            mic_final
        };

        let (sys_out, mic_out) =
            if mic_ch == 1 && final_ch == 2 && !mic_final.is_empty() && !sys_final.is_empty() {
                let stereo_mic = Self::mono_to_stereo(&mic_final);
                (sys_final, stereo_mic)
            } else {
                (sys_final, mic_final)
            };

        let encode_ch = if !sys_out.is_empty() { 2u32 } else { final_ch };
        let encode_sr = final_sr;

        if !sys_out.is_empty() && !mic_out.is_empty() {
            let mut dsp = AudioDsp::new(1.5);
            let mixed = dsp.process(&sys_out, &mic_out);
            if mixed.is_empty() {
                return Err("DSP produced no output".into());
            }
            Self::encode_i16_to_mp3(&mixed, mp3_path, encode_sr, encode_ch)?;
        } else if !sys_out.is_empty() {
            Self::pcm_to_mp3(&sys_out, mp3_path, encode_sr, encode_ch)?;
        } else {
            Self::pcm_to_mp3(&mic_out, mp3_path, encode_sr, encode_ch)?;
        }

        eprintln!("[recorder] Encoding done");
        Self::verify_output(mp3_path)
    }

    #[cfg(target_os = "linux")]
    fn parec_record(
        output_path: &str,
        sample_rate: u32,
        channels: u32,
        device: Option<String>,
        is_recording: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        use std::io::Read;
        use std::process::{Command, Stdio};

        eprintln!("[recorder] parec starting");

        let mut args = vec![
            "--format=s16le".to_string(),
            format!("--rate={}", sample_rate),
            format!("--channels={}", channels),
            "--volume=65536".to_string(),
        ];
        if let Some(device) = device {
            args.push(format!("--device={}", device));
        }

        let mut child = Command::new("parec")
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                format!(
                    "Failed to start parec: {}. Is PulseAudio/PipeWire installed?",
                    e
                )
            })?;

        let mut stdout = child.stdout.take().ok_or("parec stdout not available")?;
        let mut file = std::io::BufWriter::new(
            std::fs::File::create(output_path)
                .map_err(|e| format!("Failed to create {}: {}", output_path, e))?,
        );
        let mut buf = [0u8; 8192];

        while is_recording.load(Ordering::SeqCst) {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = file.write_all(&buf[..n]);
                }
                Err(_) => break,
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        let _ = file.flush();
        eprintln!("[recorder] parec stopped");
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn linux_default_monitor_source() -> Option<String> {
        use std::process::Command;

        let output = Command::new("pactl")
            .arg("get-default-sink")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }

        let sink = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if sink.is_empty() {
            None
        } else {
            Some(format!("{}.monitor", sink))
        }
    }

    // ==================== macOS: ScreenCaptureKit + cpal mic ====================

    #[cfg(target_os = "macos")]
    fn record_macos(mp3_path: &Path, is_recording: &Arc<AtomicBool>) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        use cpal::SampleFormat;
        use swift_rs::swift;

        swift! {
            fn sc_start_system_audio(path: *const u8, path_len: u32) -> bool;
            fn sc_stop_system_audio() -> bool;
        }

        eprintln!("[recorder] macOS ScreenCaptureKit recording start");

        let sample_rate = 48000u32;
        let channels = 2u32;

        let sys_raw = "/tmp/atok_macos_system.raw";
        let mic_raw = "/tmp/atok_macos_mic.raw";
        let _ = std::fs::remove_file(sys_raw);
        let _ = std::fs::remove_file(mic_raw);

        let path_bytes = sys_raw.as_bytes();
        let success =
            unsafe { sc_start_system_audio(path_bytes.as_ptr(), path_bytes.len() as u32) };
        if !success {
            return Err("ScreenCaptureKit failed. Grant Screen Recording permission.".into());
        }

        let host = cpal::default_host();
        let mic_device = host
            .default_input_device()
            .ok_or("No default input device (mic)")?;

        let mic_cfg_range = mic_device
            .supported_input_configs()
            .map_err(|e| format!("Mic supported_input_configs: {}", e))?
            .find(|c| c.sample_format() == SampleFormat::F32)
            .ok_or("Mic does not support F32")?;

        let mic_cfg = Self::with_preferred_sample_rate(mic_cfg_range, sample_rate);
        let mic_sr = mic_cfg.sample_rate().0;
        let mic_ch = mic_cfg.channels() as u32;

        eprintln!("[recorder] macOS mic: {}Hz, {}ch", mic_sr, mic_ch);

        let mic_buffer: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let mic_buf_c = mic_buffer.clone();

        let mic_stream = mic_device
            .build_input_stream(
                &mic_cfg.config(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mut buf: Vec<u8> = Vec::with_capacity(data.len() * 2);
                    for &s in data {
                        let s16 = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
                        buf.extend_from_slice(&s16.to_le_bytes());
                    }
                    if let Ok(mut b) = mic_buf_c.lock() {
                        b.extend_from_slice(&buf);
                    }
                },
                move |err| eprintln!("[recorder] Mic stream error: {}", err),
                None,
            )
            .map_err(|e| format!("Mic stream build failed: {}", e))?;

        mic_stream
            .play()
            .map_err(|e| format!("Mic play failed: {}", e))?;
        eprintln!("[recorder] macOS streams playing");

        while is_recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        unsafe {
            sc_stop_system_audio();
        }
        drop(mic_stream);
        std::thread::sleep(std::time::Duration::from_millis(200));

        let mic_data = match Arc::try_unwrap(mic_buffer) {
            Ok(m) => m.into_inner().map_err(|e| e.to_string())?,
            Err(_) => return Err("Mic buffer still locked".into()),
        };
        let sys_data = std::fs::read(sys_raw).unwrap_or_default();
        let _ = std::fs::remove_file(sys_raw);

        eprintln!(
            "[recorder] macOS captured: sys={} bytes, mic={} bytes",
            sys_data.len(),
            mic_data.len()
        );

        let has_sys = sys_data.len() > 1024;
        let has_mic = mic_data.len() > 1024;

        if !has_sys && !has_mic {
            return Err("No audio captured on macOS".into());
        }

        // Resample mic if sample rates differ
        let mic_final = if has_sys && has_mic && mic_sr != sample_rate {
            Self::resample_linear(&mic_data, mic_sr, sample_rate, mic_ch)
        } else {
            mic_data.clone()
        };

        let mic_final = if has_mic {
            let mic_rate = if has_sys && has_mic {
                sample_rate
            } else {
                mic_sr
            };
            Self::denoise_mic_pcm(&mic_final, mic_rate, mic_ch)
        } else {
            mic_final
        };

        let mic_stereo = if mic_ch == 1 && has_sys && has_mic {
            Self::mono_to_stereo(&mic_final)
        } else {
            mic_final
        };

        if has_sys && has_mic {
            let mut dsp = AudioDsp::new(1.5);
            let mixed = dsp.process(&sys_data, &mic_stereo);
            Self::encode_i16_to_mp3(&mixed, mp3_path, sample_rate, channels)?;
        } else if has_sys {
            Self::pcm_to_mp3(&sys_data, mp3_path, sample_rate, channels)?;
        } else {
            Self::pcm_to_mp3(&mic_final, mp3_path, mic_sr, mic_ch)?;
        }

        eprintln!("[recorder] macOS encoding done");
        Self::verify_output(mp3_path)
    }

    // ==================== Shared: Encoding & Utils ====================

    fn pcm_to_mp3(
        pcm_data: &[u8],
        output: &Path,
        sample_rate: u32,
        channels: u32,
    ) -> Result<(), String> {
        let samples: Vec<i16> = pcm_data
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        Self::encode_i16_to_mp3(&samples, output, sample_rate, channels)
    }

    fn encode_i16_to_mp3(
        samples: &[i16],
        output: &Path,
        sample_rate: u32,
        channels: u32,
    ) -> Result<(), String> {
        use mp3lame_encoder::{Builder, FlushNoGap, InterleavedPcm, MonoPcm};

        if channels != 1 && channels != 2 {
            return Err(format!(
                "MP3 encoder only supports mono/stereo, got {} channels",
                channels
            ));
        }

        let channel_count = channels as usize;
        let aligned_len = samples.len() - (samples.len() % channel_count);
        if aligned_len == 0 {
            return Err("No aligned PCM samples to encode".into());
        }
        let samples = &samples[..aligned_len];

        let mut builder = Builder::new().ok_or("MP3 encoder init failed")?;
        builder
            .set_sample_rate(sample_rate)
            .map_err(|e| format!("{:?}", e))?;
        builder
            .set_num_channels(channels as u8)
            .map_err(|e| format!("{:?}", e))?;
        builder
            .set_quality(mp3lame_encoder::Quality::Best)
            .map_err(|e| format!("{:?}", e))?;
        builder
            .set_brate(mp3lame_encoder::Bitrate::Kbps192)
            .map_err(|e| format!("{:?}", e))?;

        let mut encoder = builder.build().map_err(|e| format!("{:?}", e))?;
        let mut mp3_file = std::fs::File::create(output)
            .map_err(|e| format!("Failed to create MP3 file: {}", e))?;

        let chunk_size = 1152 * channel_count;
        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); chunk_size * 5 / 4 + 7200];

        for chunk in samples.chunks(chunk_size) {
            let encoded = if channels == 1 {
                encoder.encode(MonoPcm(chunk), &mut mp3_buf)
            } else {
                encoder.encode(InterleavedPcm(chunk), &mut mp3_buf)
            };

            match encoded {
                Ok(written) if written > 0 => {
                    let data = unsafe {
                        std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, written)
                    };
                    mp3_file
                        .write_all(data)
                        .map_err(|e| format!("MP3 write error: {}", e))?;
                }
                Err(e) => return Err(format!("MP3 encode error: {:?}", e)),
                _ => {}
            }
        }

        match encoder.flush::<FlushNoGap>(&mut mp3_buf) {
            Ok(written) if written > 0 => {
                let data =
                    unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, written) };
                mp3_file
                    .write_all(data)
                    .map_err(|e| format!("MP3 flush error: {}", e))?;
            }
            Err(e) => return Err(format!("MP3 flush error: {:?}", e)),
            _ => {}
        }

        mp3_file
            .sync_all()
            .map_err(|e| format!("Sync failed: {}", e))?;
        Ok(())
    }

    fn resample_linear(input: &[u8], from_sr: u32, to_sr: u32, channels: u32) -> Vec<u8> {
        if from_sr == to_sr || input.is_empty() {
            return input.to_vec();
        }

        let ch = channels as usize;
        let input_samples: Vec<i16> = input
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        let input_frames = input_samples.len() / ch;
        let output_frames = (input_frames as f64 * to_sr as f64 / from_sr as f64) as usize;
        let ratio = input_frames as f64 / output_frames as f64;

        let mut output = Vec::with_capacity(output_frames * ch);
        for i in 0..output_frames {
            let pos = i as f64 * ratio;
            let idx = pos as usize;
            let frac = pos - idx as f64;

            for c in 0..ch {
                let s0 = if idx * ch + c < input_samples.len() {
                    input_samples[idx * ch + c]
                } else {
                    0
                };
                let s1 = if (idx + 1) * ch + c < input_samples.len() {
                    input_samples[(idx + 1) * ch + c]
                } else {
                    s0
                };
                let interpolated = s0 as f64 + (s1 as f64 - s0 as f64) * frac;
                let s16 = (interpolated).clamp(-32768.0, 32767.0) as i16;
                output.extend_from_slice(&s16.to_le_bytes());
            }
        }
        output
    }

    fn mono_to_stereo(mono: &[u8]) -> Vec<u8> {
        let mut stereo = Vec::with_capacity(mono.len() * 2);
        for chunk in mono.chunks_exact(2) {
            stereo.extend_from_slice(chunk);
            stereo.extend_from_slice(chunk);
        }
        stereo
    }

    fn denoise_mic_pcm(pcm: &[u8], sample_rate: u32, channels: u32) -> Vec<u8> {
        let channel_count = channels as usize;
        if sample_rate != 48_000 || !(1..=2).contains(&channel_count) || pcm.len() < 2 {
            return pcm.to_vec();
        }

        let mut samples: Vec<i16> = pcm
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        let frame_count = samples.len() / channel_count;
        let full_frames = frame_count / nnnoiseless::DenoiseState::FRAME_SIZE;
        if full_frames == 0 {
            return pcm.to_vec();
        }

        eprintln!(
            "[recorder] RNNoise mic denoise: {} frames, {}ch",
            full_frames, channels
        );

        let mut denoisers: Vec<_> = (0..channel_count)
            .map(|_| nnnoiseless::DenoiseState::new())
            .collect();
        let mut input = [0.0_f32; nnnoiseless::DenoiseState::FRAME_SIZE];
        let mut output = [0.0_f32; nnnoiseless::DenoiseState::FRAME_SIZE];

        for channel in 0..channel_count {
            for frame in 0..full_frames {
                let frame_start = frame * nnnoiseless::DenoiseState::FRAME_SIZE;
                for i in 0..nnnoiseless::DenoiseState::FRAME_SIZE {
                    input[i] = samples[(frame_start + i) * channel_count + channel] as f32;
                }

                denoisers[channel].process_frame(&mut output, &input);

                for i in 0..nnnoiseless::DenoiseState::FRAME_SIZE {
                    samples[(frame_start + i) * channel_count + channel] =
                        output[i].round().clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                }
            }
        }

        let mut denoised = Vec::with_capacity(pcm.len());
        for sample in samples {
            denoised.extend_from_slice(&sample.to_le_bytes());
        }
        denoised.extend_from_slice(&pcm[denoised.len()..]);
        denoised
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn with_preferred_sample_rate(
        config: cpal::SupportedStreamConfigRange,
        preferred_sample_rate: u32,
    ) -> cpal::SupportedStreamConfig {
        let sample_rate =
            preferred_sample_rate.clamp(config.min_sample_rate().0, config.max_sample_rate().0);
        config.with_sample_rate(cpal::SampleRate(sample_rate))
    }

    #[cfg(target_os = "macos")]
    fn encode_i16_to_pcm(samples: &[i16]) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity(samples.len() * 2);
        for &s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        Ok(out)
    }

    // ==================== cpal Fallback (mic only, all platforms) ====================

    fn record_with_cpal(mp3_path: &Path, is_recording: &Arc<AtomicBool>) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        use cpal::SampleFormat;

        let host = cpal::default_host();
        let mic = host
            .default_input_device()
            .ok_or_else(|| "No input device found".to_string())?;

        let cfg_range = mic
            .supported_input_configs()
            .map_err(|e| format!("supported_input_configs: {}", e))?
            .find(|c| c.sample_format() == SampleFormat::F32)
            .ok_or("Mic does not support F32 format")?;

        // Prefer 48kHz and clamp to the device range to avoid extreme rates like 384kHz.
        let cfg = Self::with_preferred_sample_rate(cfg_range, 48000);
        let sample_rate = cfg.sample_rate().0;
        let channels = cfg.channels() as u32;

        eprintln!(
            "[recorder] Fallback cpal: {}Hz, {}ch, F32",
            sample_rate, channels
        );

        let mp3_file = Arc::new(Mutex::new(
            std::fs::File::create(mp3_path).map_err(|e| format!("Create file failed: {}", e))?,
        ));
        let encoder = Self::build_cpal_encoder(sample_rate, channels)?;
        let encoder = Arc::new(Mutex::new(encoder));
        let buffer: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));

        let stream = {
            let buffer = Arc::clone(&buffer);
            let encoder = Arc::clone(&encoder);
            let mp3_file = Arc::clone(&mp3_file);

            mic.build_input_stream(
                &cfg.config(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    Self::cpal_encode_audio(data, &buffer, &encoder, &mp3_file, channels);
                },
                move |err| eprintln!("Stream error: {}", err),
                None,
            )
            .map_err(|e| format!("Stream failed: {}", e))?
        };

        stream.play().map_err(|e| format!("Play failed: {}", e))?;

        while is_recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        drop(stream);
        std::thread::sleep(std::time::Duration::from_millis(200));
        Self::cpal_flush_encoder(&buffer, &encoder, &mp3_file, channels)?;
        Self::cpal_finalize_encoder(&encoder, &mp3_file)?;
        Self::verify_output(mp3_path)
    }

    fn build_cpal_encoder(
        sample_rate: u32,
        channels: u32,
    ) -> Result<mp3lame_encoder::Encoder, String> {
        if channels != 1 && channels != 2 {
            return Err(format!(
                "MP3 encoder only supports mono/stereo, got {} channels",
                channels
            ));
        }

        let mut b = mp3lame_encoder::Builder::new().ok_or("Encoder init failed")?;
        b.set_sample_rate(sample_rate)
            .map_err(|e| format!("{:?}", e))?;
        b.set_num_channels(channels as u8)
            .map_err(|e| format!("{:?}", e))?;
        b.set_quality(mp3lame_encoder::Quality::Best)
            .map_err(|e| format!("{:?}", e))?;
        b.set_brate(mp3lame_encoder::Bitrate::Kbps192)
            .map_err(|e| format!("{:?}", e))?;
        b.build().map_err(|e| format!("{:?}", e))
    }

    fn cpal_encode_audio(
        data: &[f32],
        buffer: &Arc<Mutex<Vec<i16>>>,
        encoder: &Arc<Mutex<mp3lame_encoder::Encoder>>,
        mp3_file: &Arc<Mutex<std::fs::File>>,
        channels: u32,
    ) {
        let mut buf = buffer.lock().unwrap();
        for &s in data {
            buf.push((s * 32767.0).clamp(-32768.0, 32767.0) as i16);
        }
        let chunk_size = 1152 * channels as usize;
        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); chunk_size * 5 / 4 + 7200];
        while buf.len() >= chunk_size {
            let chunk: Vec<i16> = buf.drain(..chunk_size).collect();
            if let Ok(mut enc) = encoder.lock() {
                let encoded = if channels == 1 {
                    enc.encode(mp3lame_encoder::MonoPcm(&chunk), &mut mp3_buf)
                } else {
                    enc.encode(mp3lame_encoder::InterleavedPcm(&chunk), &mut mp3_buf)
                };

                if let Ok(w) = encoded {
                    if w > 0 {
                        let data =
                            unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w) };
                        if let Ok(mut f) = mp3_file.lock() {
                            let _ = f.write_all(data);
                        }
                    }
                }
            }
        }
    }

    fn cpal_flush_encoder(
        buffer: &Arc<Mutex<Vec<i16>>>,
        encoder: &Arc<Mutex<mp3lame_encoder::Encoder>>,
        mp3_file: &Arc<Mutex<std::fs::File>>,
        channels: u32,
    ) -> Result<(), String> {
        let mut buf = buffer.lock().map_err(|e| e.to_string())?;
        if buf.is_empty() {
            return Ok(());
        }
        let channel_count = channels as usize;
        let aligned_len = buf.len() - (buf.len() % channel_count);
        if aligned_len == 0 {
            buf.clear();
            return Ok(());
        }
        let chunk: Vec<i16> = buf.drain(..aligned_len).collect();
        buf.clear();

        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); chunk.len() * 5 / 4 + 7200];
        let mut enc = encoder.lock().map_err(|e| e.to_string())?;
        let encoded = if channels == 1 {
            enc.encode(mp3lame_encoder::MonoPcm(&chunk), &mut mp3_buf)
        } else {
            enc.encode(mp3lame_encoder::InterleavedPcm(&chunk), &mut mp3_buf)
        };

        if let Ok(w) = encoded {
            if w > 0 {
                let data = unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w) };
                let mut f = mp3_file.lock().map_err(|e| e.to_string())?;
                f.write_all(data).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn cpal_finalize_encoder(
        encoder: &Arc<Mutex<mp3lame_encoder::Encoder>>,
        mp3_file: &Arc<Mutex<std::fs::File>>,
    ) -> Result<(), String> {
        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); 8192];
        let mut enc = encoder.lock().map_err(|e| e.to_string())?;
        if let Ok(w) = enc.flush::<mp3lame_encoder::FlushNoGap>(&mut mp3_buf) {
            if w > 0 {
                let data = unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w) };
                let mut f = mp3_file.lock().map_err(|e| e.to_string())?;
                f.write_all(data).map_err(|e| e.to_string())?;
            }
        }
        let f = mp3_file.lock().map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| format!("Sync failed: {}", e))?;
        Ok(())
    }

    fn verify_output(path: &Path) -> Result<(), String> {
        if path.exists() {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            if size < 100 {
                return Err(format!("Output file too small: {} bytes", size));
            }
            Ok(())
        } else {
            Err("Output file missing".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_mp3_path(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("atok-ai-{}-{}.mp3", name, nanos))
    }

    fn test_pcm_samples(count: usize) -> Vec<i16> {
        (0..count)
            .map(|i| ((i as f32 * 0.01).sin() * 12_000.0) as i16)
            .collect()
    }

    #[test]
    fn encodes_odd_length_mono_pcm_without_panicking() {
        let path = temp_mp3_path("mono-odd");
        let samples = test_pcm_samples(48_001);

        let result = DesktopAudioRecorder::encode_i16_to_mp3(&samples, &path, 48000, 1);

        assert!(result.is_ok(), "{result:?}");
        assert!(std::fs::metadata(&path).unwrap().len() > 100);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn encodes_odd_length_stereo_pcm_without_panicking() {
        let path = temp_mp3_path("stereo-odd");
        let samples = test_pcm_samples(96_001);

        let result = DesktopAudioRecorder::encode_i16_to_mp3(&samples, &path, 48000, 2);

        assert!(result.is_ok(), "{result:?}");
        assert!(std::fs::metadata(&path).unwrap().len() > 100);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn denoises_48khz_mono_pcm_without_changing_length() {
        let samples = test_pcm_samples(nnnoiseless::DenoiseState::FRAME_SIZE * 2);
        let pcm: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();

        let denoised = DesktopAudioRecorder::denoise_mic_pcm(&pcm, 48_000, 1);

        assert_eq!(denoised.len(), pcm.len());
    }

    #[test]
    fn skips_denoise_for_non_48khz_pcm() {
        let samples = test_pcm_samples(nnnoiseless::DenoiseState::FRAME_SIZE * 2);
        let pcm: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();

        let denoised = DesktopAudioRecorder::denoise_mic_pcm(&pcm, 44_100, 1);

        assert_eq!(denoised, pcm);
    }
}
