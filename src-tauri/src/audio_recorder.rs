// Cross-platform audio recorder
//
// Windows: WASAPI loopback + mic (windows_audio.rs)
// Linux:   parec (PulseAudio/PipeWire) + cpal mic
// macOS:   ScreenCaptureKit + cpal mic
// Fallback: cpal mic only

use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;

use crate::audio_dsp::AudioDsp;

type RecordingResult = Result<PathBuf, String>;
type CompletionReceiver = oneshot::Receiver<RecordingResult>;

// Phase 2: frame-level capture via lock-free SPSC ring buffers.
// Capacity: 10 seconds of i16 LE audio at 48 kHz.
// Sys: 48_000 samples/s * 2 ch * 2 bytes * 10 s = 1,920,000 bytes.
// Mic: 48_000 samples/s * 1 ch  * 2 bytes * 10 s =   960,000 bytes.
#[allow(dead_code)]
const SYS_RINGBUF_BYTES: usize = 1_920_000;
#[allow(dead_code)]
const MIC_RINGBUF_BYTES: usize = 960_000;
const PUMP_CHUNK_BYTES: usize = 8192;
const PUMP_SLEEP_MS: u64 = 5;

// Phase 3: streaming DSP + encoding.
// 10ms frames @ 48kHz (matches RNNoise FRAME_SIZE).
// Mixed ringbuf (unused now that we use batch path, kept for reference).
pub struct DesktopAudioRecorder {
    is_recording: Arc<AtomicBool>,
    recording_thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    completion: Arc<Mutex<Option<CompletionReceiver>>>,
}

impl DesktopAudioRecorder {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            recording_thread: Arc::new(Mutex::new(None)),
            completion: Arc::new(Mutex::new(None)),
        }
    }

    pub fn start_recording(&self, output_path: PathBuf) -> Result<(), String> {
        if self.is_recording.swap(true, Ordering::SeqCst) {
            return Err("Already recording".to_string());
        }

        let is_recording = Arc::clone(&self.is_recording);
        let (tx, rx) = oneshot::channel();
        *self
            .completion
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))? = Some(rx);

        let thread_handle = std::thread::spawn(move || {
            let result = Self::record(output_path, is_recording);
            if let Err(ref e) = result {
                eprintln!("Recording error: {}", e);
            }
            let _ = tx.send(result);
        });

        *self.recording_thread.lock().map_err(|e| e.to_string())? = Some(thread_handle);
        Ok(())
    }

    pub fn stop_recording(&self) -> Result<(), String> {
        if !self.is_recording.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        eprintln!("[recorder] Stop signal sent");

        let rx = self
            .completion
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?
            .take()
            .ok_or_else(|| "No completion receiver (internal error)".to_string())?;

        let result = rx
            .blocking_recv()
            .map_err(|_| "Recording thread dropped sender".to_string())?;

        let mut thread_lock = self
            .recording_thread
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if let Some(handle) = thread_lock.take() {
            if let Err(e) = handle.join() {
                eprintln!("[recorder] Recording thread panicked: {:?}", e);
            }
        }

        match result {
            Ok(path) => {
                eprintln!("[recorder] Thread finished OK: {}", path.display());
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    pub fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    fn record(output_path: PathBuf, is_recording: Arc<AtomicBool>) -> Result<PathBuf, String> {
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
                Ok(()) => return Ok(mp3_path),
                Err(e) => eprintln!("Linux recording failed: {}, falling back", e),
            }
        }

        #[cfg(target_os = "macos")]
        {
            match Self::record_macos(&mp3_path, &is_recording) {
                Ok(()) => return Ok(mp3_path),
                Err(e) => eprintln!("macOS recording failed: {}, falling back to cpal", e),
            }
        }

        Self::record_with_cpal(&mp3_path, &is_recording)?;
        Ok(mp3_path)
    }

    // ==================== Linux: parec (system) + cpal (mic) ====================

    #[cfg(target_os = "linux")]
    fn record_linux(mp3_path: &Path, is_recording: &Arc<AtomicBool>) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, HostTrait};
        use cpal::SampleFormat;

        eprintln!("[recorder] Linux capture starting");

        // --- System audio via parec (PulseAudio/PipeWire) ---
        let sample_rate = 48000u32;
        let channels = 2u32;
        let sys_device = Self::linux_default_monitor_source();
        if let Some(device) = &sys_device {
            eprintln!("[recorder] System monitor: {}", device);
        }

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

        // Phase 2 batch path: capture ringbufs, denoise + mix + encode after stop.
        // Disk-backed chunked pipeline: progressive processing, <3s stop latency
        eprintln!("[recorder] Phase 2 chunked path (progressive processing)");
        Self::record_linux_chunked(
            mp3_path,
            is_recording,
            &mic_device,
            &mic_cfg,
            sample_rate,
            channels,
            sys_device,
            mic_sr,
            mic_ch,
        )
    }

    /// Phase 3 streaming path. sys + mic are denoised/mixed/encoded in
    /// real-time during capture. No `Vec<u8>` accumulation — memory stays
    /// bounded to ringbuf depth (~5 MB) regardless of recording duration.
    /// Post-stop work is bounded to "drain ringbufs + flush LAME" (< 1s).
    #[cfg(target_os = "linux")]
    #[allow(clippy::too_many_arguments)]

    /// Phase 2 batch fallback. Used when mic sample rate != sys sample rate
    /// (rare; most modern mics support 48kHz). Pumps sys+mic to Vec<u8>,
    /// resamples, denoises, mixes, encodes AFTER capture ends.
    /// Memory grows linearly with recording duration.
    #[cfg(target_os = "linux")]
    #[allow(clippy::too_many_arguments)]
    #[allow(dead_code)]
    fn record_linux_batch(
        mp3_path: &Path,
        is_recording: &Arc<AtomicBool>,
        mic_device: &cpal::Device,
        mic_cfg: &cpal::SupportedStreamConfig,
        sample_rate: u32,
        channels: u32,
        sys_device: Option<String>,
        mic_sr: u32,
        mic_ch: u32,
    ) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, StreamTrait};

        eprintln!("[recorder] Phase 2: batch ringbuf path (post-stop processing)");

        // --- Capture ringbufs (10s each) ---
        let sys_rb = HeapRb::<u8>::new(SYS_RINGBUF_BYTES);
        let (sys_prod, sys_cons) = sys_rb.split();
        let mic_rb = HeapRb::<u8>::new(MIC_RINGBUF_BYTES);
        let (mic_prod, mic_cons) = mic_rb.split();
        let producer_done = Arc::new(AtomicBool::new(false));

        // --- Spawn parec thread ---
        let sys_is_rec = is_recording.clone();
        let sys_thread = std::thread::Builder::new()
            .name("parec-sys".into())
            .spawn(move || {
                Self::parec_record_to_ring(
                    sys_prod,
                    sample_rate,
                    channels,
                    sys_device,
                    &sys_is_rec,
                )
            })
            .map_err(|e| format!("Failed to spawn parec thread: {}", e))?;

        // --- Build cpal mic stream ---
        let mic_stream = {
            let mut scratch: Vec<u8> = Vec::with_capacity(PUMP_CHUNK_BYTES * 4);
            let mut mic_prod = mic_prod;
            mic_device
                .build_input_stream(
                    &mic_cfg.config(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        scratch.clear();
                        for &s in data {
                            let s16 = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
                            let b = s16.to_le_bytes();
                            scratch.push(b[0]);
                            scratch.push(b[1]);
                        }
                        let _ = mic_prod.push_slice(&scratch);
                    },
                    move |err| eprintln!("[recorder] Mic stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Mic stream build failed: {}", e))?
        };

        mic_stream
            .play()
            .map_err(|e| format!("Mic play failed: {}", e))?;
        eprintln!("[recorder] Streams playing");

        // --- Spawn pump threads (drain ringbufs into Vec<u8>) ---
        let sys_pump_done = producer_done.clone();
        let sys_pump_handle = std::thread::Builder::new()
            .name("sys-pump".into())
            .spawn(move || Self::pump_audio(sys_cons, sys_pump_done))
            .map_err(|e| format!("Failed to spawn sys pump: {}", e))?;
        let mic_pump_done = producer_done.clone();
        let mic_pump_handle = std::thread::Builder::new()
            .name("mic-pump".into())
            .spawn(move || Self::pump_audio(mic_cons, mic_pump_done))
            .map_err(|e| format!("Failed to spawn mic pump: {}", e))?;

        // --- Wait for stop signal ---
        while is_recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        eprintln!("[recorder] Stop signal sent, draining capture");

        drop(mic_stream);
        std::thread::sleep(std::time::Duration::from_millis(200));
        let _ = sys_thread.join();
        producer_done.store(true, Ordering::SeqCst);

        let sys_data = sys_pump_handle
            .join()
            .map_err(|_| "sys pump thread panicked".to_string())??;
        let mic_data = mic_pump_handle
            .join()
            .map_err(|_| "mic pump thread panicked".to_string())??;

        eprintln!(
            "[recorder] Captured: sys={} bytes, mic={} bytes (via ringbuf)",
            sys_data.len(),
            mic_data.len()
        );

        let has_sys = sys_data.len() > 1024;
        let has_mic = mic_data.len() > 1024;

        if !has_sys && !has_mic {
            return Err("No audio captured".into());
        }

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
            let mut dsp = AudioDsp::new(4.0);
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

    // ==================== Disk-Backed Chunked Pipeline ====================

    /// Sys capture: writes to files with 3-minute rotation.
    #[cfg(target_os = "linux")]
    fn parec_record_chunked(
        session_dir: &Path,
        sample_rate: u32,
        channels: u32,
        device: Option<String>,
        is_recording: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        use std::io::{Read, Write};
        use std::process::{Command, Stdio};

        eprintln!("[recorder] parec starting (chunked)");

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
            .map_err(|e| format!("Failed to start parec: {}", e))?;

        let mut stdout = child.stdout.take().ok_or("parec stdout not available")?;
        let mut buf = [0u8; 8192];
        let mut bytes_written = 0u64;
        let mut chunk_idx = 0u32;
        // 3 min stereo 48kHz s16le = 3 * 60 * 48000 * 2 * 2 = 34,560,000
        let max_bytes = 34_560_000u64;
        let mut file = std::fs::File::create(session_dir.join(format!("sys_{:04}.raw", chunk_idx)))
            .map_err(|e| format!("Create sys chunk: {}", e))?;

        while is_recording.load(Ordering::SeqCst) {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    file.write_all(&buf[..n]).map_err(|e| format!("Write sys: {}", e))?;
                    bytes_written += n as u64;
                    if bytes_written >= max_bytes {
                        file.flush().ok();
                        chunk_idx += 1;
                        bytes_written = 0;
                        file = std::fs::File::create(
                            session_dir.join(format!("sys_{:04}.raw", chunk_idx)),
                        )
                        .map_err(|e| format!("Create sys chunk: {}", e))?;
                    }
                }
                Err(_) => break,
            }
        }

        file.flush().ok();
        let _ = child.kill();
        let _ = child.wait();

        // Mark sys capture done
        let _ = std::fs::File::create(session_dir.join("sys_done.flag"));
        eprintln!("[recorder] parec stopped (chunked, {} chunks)", chunk_idx + 1);
        Ok(())
    }

    /// Mic capture: writes to files with 3-minute rotation.
    fn cpal_record_chunked(
        session_dir: PathBuf,
        mic_device: cpal::Device,
        mic_cfg: cpal::SupportedStreamConfig,
        is_recording: Arc<AtomicBool>,
    ) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, StreamTrait};
        #[allow(unused_imports)]
use std::io::Write;
        use std::sync::Mutex;

        eprintln!("[recorder] mic starting (chunked)");

        let chunk_state = Arc::new(Mutex::new((
            std::fs::File::create(session_dir.join("mic_0000.raw"))
                .map_err(|e| format!("Create mic chunk: {}", e))?,
            0u64,
            0u32,
        )));
        let chunk_state_c = chunk_state.clone();
        let max_bytes = 17_280_000u64;
        let session_dir_c = session_dir.clone();

        let mic_stream = mic_device
            .build_input_stream(
                &mic_cfg.config(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut state) = chunk_state_c.lock() {
                        let (ref mut file, ref mut bytes_written, ref mut chunk_idx) = *state;
                        for &s in data {
                            let s16 = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
                            let _ = file.write_all(&s16.to_le_bytes());
                        }
                        *bytes_written += data.len() as u64 * 2;
                        if *bytes_written >= max_bytes {
                            let _ = file.flush();
                            *chunk_idx += 1;
                            *bytes_written = 0;
                            if let Ok(new_file) = std::fs::File::create(
                                session_dir_c.join(format!("mic_{:04}.raw", *chunk_idx)),
                            ) {
                                *file = new_file;
                            }
                        }
                    }
                },
                move |err| eprintln!("[recorder] Mic stream error: {}", err),
                None,
            )
            .map_err(|e| format!("Mic stream build failed: {}", e))?;

        mic_stream
            .play()
            .map_err(|e| format!("Mic play failed: {}", e))?;

        while is_recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        drop(mic_stream);
        std::thread::sleep(std::time::Duration::from_millis(200));

        // Flush and mark done
        if let Ok(mut state) = chunk_state.lock() {
            let _ = state.0.flush();
        }
        let _ = std::fs::File::create(session_dir.join("mic_done.flag"));
        eprintln!("[recorder] mic stopped (chunked)");
        Ok(())
    }

    /// Process one chunk: resample, denoise, mix. Returns mixed PCM.
    fn process_chunk_batch(
        sys_data: &[u8],
        mic_data: &[u8],
        mic_sr: u32,
        sample_rate: u32,
        channels: u32,
        mic_ch: u32,
        dsp: &mut AudioDsp,
        denoisers: &mut Vec<Box<nnnoiseless::DenoiseState>>,
    ) -> Vec<i16> {
        let has_sys = sys_data.len() > 1024;
        let has_mic = mic_data.len() > 1024;

        if !has_sys && !has_mic {
            return Vec::new();
        }

        let (sys_final, mic_final, final_sr, final_ch) =
            if has_sys && has_mic && mic_sr != sample_rate {
                let resampled = Self::resample_linear(mic_data, mic_sr, sample_rate, mic_ch);
                (sys_data.to_vec(), resampled, sample_rate, channels)
            } else if has_sys && has_mic {
                (sys_data.to_vec(), mic_data.to_vec(), sample_rate, channels)
            } else if has_sys {
                (sys_data.to_vec(), Vec::new(), sample_rate, channels)
            } else {
                (Vec::new(), mic_data.to_vec(), mic_sr, mic_ch)
            };

        let mic_final = if has_mic {
            Self::denoise_mic_pcm_with_state(&mic_final, final_sr, mic_ch, denoisers)
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

        if !sys_out.is_empty() && !mic_out.is_empty() {
            dsp.process(&sys_out, &mic_out)
        } else if !sys_out.is_empty() {
            sys_out
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect()
        } else if !mic_out.is_empty() {
            mic_out
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect()
        } else {
            Vec::new()
        }
    }

    /// Denoise using persistent DenoiseState (one per channel).
    /// Reuses state across chunks to avoid filter settling transients
    /// and to maintain RNNoise's learned noise profile.
    fn denoise_mic_pcm_with_state(
        pcm: &[u8],
        sample_rate: u32,
        channels: u32,
        denoisers: &mut Vec<Box<nnnoiseless::DenoiseState>>,
    ) -> Vec<u8> {
        let channel_count = channels as usize;
        if sample_rate != 48_000 || !(1..=2).contains(&channel_count) || pcm.len() < 2 {
            return pcm.to_vec();
        }

        // Resize denoiser pool if channel count changed (shouldn't, but safe).
        while denoisers.len() < channel_count {
            denoisers.push(nnnoiseless::DenoiseState::new());
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

    /// Background worker: reads chunk files, processes, encodes to MP3.
    /// DSP state (AGC, filters, gate) and RNNoise DenoiseState are persistent
    /// across chunks to avoid settling transients at chunk boundaries.
    fn chunk_worker(
        session_dir: PathBuf,
        mp3_path: PathBuf,
        sample_rate: u32,
        channels: u32,
        mic_sr: u32,
        mic_ch: u32,
        done: Arc<AtomicBool>,
    ) {
        #[allow(unused_imports)]
use std::io::Write;

        let mut current_chunk = 0u32;
        let mut encoder = match Self::build_cpal_encoder(sample_rate, channels) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[Worker] Encoder init failed: {}", e);
                return;
            }
        };
        let mut mp3_file = match std::fs::File::create(&mp3_path) {
            Ok(f) => std::io::BufWriter::new(f),
            Err(e) => {
                eprintln!("[Worker] Create MP3 failed: {}", e);
                return;
            }
        };
        // Persistent DSP + denoise state across all chunks in this session.
        let mut dsp = AudioDsp::new(4.0);
        let mut denoisers: Vec<Box<nnnoiseless::DenoiseState>> = Vec::new();

        loop {
            let sys_path = session_dir.join(format!("sys_{:04}.raw", current_chunk));
            let mic_path = session_dir.join(format!("mic_{:04}.raw", current_chunk));
            let next_sys = session_dir.join(format!("sys_{:04}.raw", current_chunk + 1));
            let next_mic = session_dir.join(format!("mic_{:04}.raw", current_chunk + 1));

            let sys_done = session_dir.join("sys_done.flag").exists();
            let mic_done = session_dir.join("mic_done.flag").exists();

            let sys_ready = next_sys.exists() || sys_done;
            let mic_ready = next_mic.exists() || mic_done;

            if sys_ready && mic_ready {
                if !sys_path.exists() && !mic_path.exists() {
                    break;
                }

                eprintln!("[Worker] Processing chunk {:04}...", current_chunk);

                let sys_data = std::fs::read(&sys_path).unwrap_or_default();
                let mic_data = std::fs::read(&mic_path).unwrap_or_default();

                let mixed = Self::process_chunk_batch(
                    &sys_data, &mic_data, mic_sr, sample_rate, channels, mic_ch,
                    &mut dsp,
                    &mut denoisers,
                );

                if !mixed.is_empty() {
                    Self::encode_chunk_to_mp3(&mut encoder, &mut mp3_file, &mixed, channels);
                }

                let _ = std::fs::remove_file(&sys_path);
                let _ = std::fs::remove_file(&mic_path);

                current_chunk += 1;

                if sys_done && mic_done && !next_sys.exists() && !next_mic.exists() {
                    break;
                }
            } else if done.load(Ordering::SeqCst) && !sys_path.exists() && !mic_path.exists() {
                break;
            } else {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }

        // Flush encoder
        Self::finalize_chunk_encoder(&mut encoder, &mut mp3_file);
        eprintln!("[Worker] All chunks processed. MP3 ready: {}", mp3_path.display());
    }

    fn encode_chunk_to_mp3(
        encoder: &mut mp3lame_encoder::Encoder,
        file: &mut std::io::BufWriter<std::fs::File>,
        samples: &[i16],
        channels: u32,
    ) {
        use mp3lame_encoder::{InterleavedPcm, MonoPcm};
        #[allow(unused_imports)]
use std::io::Write;

        let chunk_size = 1152 * channels as usize;
        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); chunk_size * 5 / 4 + 7200];

        for chunk in samples.chunks(chunk_size) {
            let encoded = if channels == 1 {
                encoder.encode(MonoPcm(chunk), &mut mp3_buf)
            } else {
                encoder.encode(InterleavedPcm(chunk), &mut mp3_buf)
            };
            if let Ok(w) = encoded {
                if w > 0 {
                    let data = unsafe {
                        std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w)
                    };
                    let _ = file.write_all(data);
                }
            }
        }
    }

    fn finalize_chunk_encoder(
        encoder: &mut mp3lame_encoder::Encoder,
        file: &mut std::io::BufWriter<std::fs::File>,
    ) {
        use mp3lame_encoder::FlushNoGap;
        #[allow(unused_imports)]
use std::io::Write;

        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); 8192];
        if let Ok(w) = encoder.flush::<FlushNoGap>(&mut mp3_buf) {
            if w > 0 {
                let data = unsafe {
                    std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w)
                };
                let _ = file.write_all(data);
            }
        }
        let _ = file.flush();
    }

    /// Orchestrates chunked capture + background processing.
    #[cfg(target_os = "linux")]
    fn record_linux_chunked(
        mp3_path: &Path,
        is_recording: &Arc<AtomicBool>,
        mic_device: &cpal::Device,
        mic_cfg: &cpal::SupportedStreamConfig,
        sample_rate: u32,
        channels: u32,
        sys_device: Option<String>,
        mic_sr: u32,
        mic_ch: u32,
    ) -> Result<(), String> {
        #[allow(unused_imports)]
use cpal::traits::StreamTrait;

        // Create session directory
        let session_id = format!(
            "session_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("SystemTime error: {}", e))?
                .as_millis()
        );
        let session_dir = std::env::temp_dir().join(format!("atok_{}", session_id));
        std::fs::create_dir_all(&session_dir)
            .map_err(|e| format!("Create session dir: {}", e))?;

        eprintln!(
            "[recorder] Chunked capture: session={}",
            session_dir.display()
        );

        let producer_done = Arc::new(AtomicBool::new(false));

        // Spawn parec thread (sys → files)
        let sys_is_rec = is_recording.clone();
        let sys_dir = session_dir.clone();
        let sys_thread = std::thread::Builder::new()
            .name("parec-sys".into())
            .spawn(move || {
                Self::parec_record_chunked(
                    &sys_dir,
                    sample_rate,
                    channels,
                    sys_device,
                    &sys_is_rec,
                )
            })
            .map_err(|e| format!("Failed to spawn parec: {}", e))?;

        // Spawn mic capture thread (mic → files)
        let mic_is_rec = is_recording.clone();
        let mic_dir = session_dir.clone();
        let mic_device_c = mic_device.clone();
        let mic_cfg_c = mic_cfg.clone();
        let mic_thread = std::thread::Builder::new()
            .name("mic-file".into())
            .spawn(move || {
                Self::cpal_record_chunked(
                    mic_dir,
                    mic_device_c,
                    mic_cfg_c,
                    mic_is_rec,
                )
            })
            .map_err(|e| format!("Failed to spawn mic: {}", e))?;

        // Spawn chunk worker (background processing)
        let worker_done = producer_done.clone();
        let worker_dir = session_dir.clone();
        let worker_mp3 = mp3_path.to_path_buf();
        let worker_thread = std::thread::Builder::new()
            .name("chunk-worker".into())
            .spawn(move || {
                Self::chunk_worker(
                    worker_dir,
                    worker_mp3,
                    sample_rate,
                    channels,
                    mic_sr,
                    mic_ch,
                    worker_done,
                )
            })
            .map_err(|e| format!("Failed to spawn worker: {}", e))?;

        eprintln!("[recorder] Streams playing (chunked)");

        // Wait for stop
        while is_recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        eprintln!("[recorder] Stop signal sent");

        // Wait for capture threads
        let _ = sys_thread.join();
        let _ = mic_thread.join();

        // Signal worker to finish
        producer_done.store(true, Ordering::SeqCst);

        // Wait for worker (with timeout)
        let worker_result = Self::spawn_blocking_with_timeout(
            move || worker_thread.join(),
            std::time::Duration::from_secs(300),
        );
        if worker_result.is_none() {
            eprintln!("[recorder] Worker join timed out");
        }

        // Cleanup session dir
        let _ = std::fs::remove_dir_all(&session_dir);

        eprintln!("[recorder] Encoding done");
        Self::verify_output(mp3_path)
    }

    fn spawn_blocking_with_timeout<F, T>(f: F, timeout: std::time::Duration) -> Option<T>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = std::thread::spawn(move || {
            let result = f();
            let _ = tx.send(result);
        });
        rx.recv_timeout(timeout).ok()
    }

    /// Pump thread body: drain a ringbuf consumer into a `Vec<u8>` until the
    /// `done` flag is set AND the ringbuf is empty. Returns the captured bytes
    /// in producer order. Pump is sleep-friendly (no busy-wait).
    ///
    /// Used by the Phase 2 batch fallback path (record_macos) where
    /// `sys` is captured to a file by Swift and only the mic ringbuf is drained.
    #[cfg(target_os = "linux")]
    #[allow(dead_code)]
    fn parec_record_to_ring(
        mut producer: impl Producer<Item = u8>,
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
            .map_err(|e| format!("Failed to start parec: {}", e))?;

        let mut stdout = child.stdout.take().ok_or("parec stdout not available")?;
        let mut buf = [0u8; 8192];

        while is_recording.load(Ordering::SeqCst) {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = producer.push_slice(&buf[..n]);
                }
                Err(_) => break,
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        eprintln!("[recorder] parec stopped");
        Ok(())
    }

    #[allow(dead_code)]
    fn pump_audio(
        mut cons: impl Consumer<Item = u8>,
        done: Arc<AtomicBool>,
    ) -> Result<Vec<u8>, String> {
        let mut buf = Vec::new();
        let mut tmp = [0u8; PUMP_CHUNK_BYTES];
        loop {
            let n = cons.pop_slice(&mut tmp);
            if n > 0 {
                buf.extend_from_slice(&tmp[..n]);
                continue;
            }
            if done.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(PUMP_SLEEP_MS));
        }
        Ok(buf)
    }

    /// Phase 3 DSP worker with VecDeque slack buffers.
    /// Hybrid DSP worker: pops mic from Arc<Mutex<VecDeque>>, sys from
    /// mpsc::Receiver. Never discards popped data — falls back to silence.
    #[cfg(target_os = "linux")]

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

        eprintln!("[recorder] macOS ScreenCaptureKit recording start (Phase 2: ringbuf for mic)");

        let sample_rate = 48000u32;
        let channels = 2u32;

        // Note: ScreenCaptureKit (sys) still writes to a file via Swift.
        // Phase 2 refactors the mic path (cpal) to ringbuf. Sys path will be
        // refactored in a later phase when the Swift side supports streaming.
        let sys_raw = "/tmp/atok_macos_system.raw";
        let _ = std::fs::remove_file(sys_raw);

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

        // --- Phase 2: ringbuf for mic capture ---
        let mic_rb = HeapRb::<u8>::new(MIC_RINGBUF_BYTES);
        let (mic_prod, mic_cons) = mic_rb.split();
        let producer_done = Arc::new(AtomicBool::new(false));

        let mic_stream = {
            let mut scratch: Vec<u8> = Vec::with_capacity(PUMP_CHUNK_BYTES * 4);
            let mut mic_prod = mic_prod;
            mic_device
                .build_input_stream(
                    &mic_cfg.config(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        scratch.clear();
                        for &s in data {
                            let s16 = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
                            let b = s16.to_le_bytes();
                            scratch.push(b[0]);
                            scratch.push(b[1]);
                        }
                        let _ = mic_prod.push_slice(&scratch);
                    },
                    move |err| eprintln!("[recorder] Mic stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Mic stream build failed: {}", e))?
        };

        mic_stream
            .play()
            .map_err(|e| format!("Mic play failed: {}", e))?;
        eprintln!("[recorder] macOS streams playing");

        let mic_pump_handle = std::thread::Builder::new()
            .name("mic-pump".into())
            .spawn(move || Self::pump_audio(mic_cons, producer_done.clone()))
            .map_err(|e| format!("Failed to spawn mic pump: {}", e))?;

        while is_recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        unsafe {
            sc_stop_system_audio();
        }
        drop(mic_stream);
        std::thread::sleep(std::time::Duration::from_millis(200));

        producer_done.store(true, Ordering::SeqCst);

        let mic_data = mic_pump_handle
            .join()
            .map_err(|_| "mic pump thread panicked".to_string())??;
        let sys_data = std::fs::read(sys_raw).unwrap_or_default();
        let _ = std::fs::remove_file(sys_raw);

        eprintln!(
            "[recorder] macOS captured: sys={} bytes, mic={} bytes (mic via ringbuf)",
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
            let mut dsp = AudioDsp::new(4.0);
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

    #[allow(dead_code)]
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

    #[allow(dead_code)]
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
        // Quality intentionally omitted: when both set_quality and set_brate are called,
        // set_quality wins and the encoder uses VBR V0 (~44 min for 1h 45min audio).
        // For batch recordings of 1+ hour, CBR 192 encodes in ~30s while preserving
        // transcription accuracy (Whisper is robust at 192 kbps).
        builder
            .set_brate(mp3lame_encoder::Bitrate::Kbps192)
            .map_err(|e| format!("{:?}", e))?;

        let mut encoder = builder.build().map_err(|e| format!("{:?}", e))?;
        let mp3_file = std::fs::File::create(output)
            .map_err(|e| format!("Failed to create MP3 file: {}", e))?;
        let mut mp3_file = BufWriter::new(mp3_file);

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
            .flush()
            .map_err(|e| format!("Flush failed: {}", e))?;
        mp3_file
            .get_ref()
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
            "[recorder] Fallback cpal: {}Hz, {}ch, F32 (Phase 2: ringbuf)",
            sample_rate, channels
        );

        let mp3_file = Arc::new(Mutex::new(BufWriter::new(
            std::fs::File::create(mp3_path).map_err(|e| format!("Create file failed: {}", e))?,
        )));
        let encoder = Self::build_cpal_encoder(sample_rate, channels)?;
        let encoder = Arc::new(Mutex::new(encoder));

        // --- Phase 2: ringbuf + dedicated encoding thread ---
        // cpal callback only pushes i16 LE bytes to the ringbuf.
        // A separate encoding thread drains the ringbuf, accumulates to
        // Vec<i16>, feeds LAME in chunk_size (1152 samples) blocks, and
        // finalizes the MP3 file on exit. Main thread just joins.
        let mic_rb = HeapRb::<u8>::new(MIC_RINGBUF_BYTES);
        let (mic_prod, mic_cons) = mic_rb.split();
        let producer_done = Arc::new(AtomicBool::new(false));

        let enc_done = producer_done.clone();
        let enc_mp3 = Arc::clone(&mp3_file);
        let enc_channels = channels;
        let enc_encoder = Arc::clone(&encoder);
        let encoding_thread = std::thread::Builder::new()
            .name("cpal-encode".into())
            .spawn(move || {
                Self::cpal_encoding_thread(mic_cons, enc_encoder, enc_mp3, enc_done, enc_channels)
            })
            .map_err(|e| format!("Failed to spawn encoding thread: {}", e))?;

        let stream = {
            let mut scratch: Vec<u8> = Vec::with_capacity(PUMP_CHUNK_BYTES * 4);
            let mut mic_prod = mic_prod;
            mic.build_input_stream(
                &cfg.config(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    scratch.clear();
                    for &s in data {
                        let s16 = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
                        let b = s16.to_le_bytes();
                        scratch.push(b[0]);
                        scratch.push(b[1]);
                    }
                    let _ = mic_prod.push_slice(&scratch);
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

        producer_done.store(true, Ordering::SeqCst);
        encoding_thread
            .join()
            .map_err(|_| "encoding thread panicked".to_string())??;

        // Encoding thread already flushed encoder + file. Just verify.
        Self::verify_output(mp3_path)
    }

    /// Encoding thread for the cpal fallback path. Owns no shared state
    /// (encoder + file are wrapped in `Arc<Mutex<...>>` for the finalize step,
    /// but encoding itself is single-threaded here). Drains i16 LE bytes from
    /// the ringbuf, accumulates to 1152-sample blocks, feeds LAME, and
    /// finalizes the MP3 file on exit.
    fn cpal_encoding_thread(
        mut cons: impl Consumer<Item = u8>,
        encoder: Arc<Mutex<mp3lame_encoder::Encoder>>,
        mp3_file: Arc<Mutex<BufWriter<std::fs::File>>>,
        done: Arc<AtomicBool>,
        channels: u32,
    ) -> Result<(), String> {
        // Pre-allocate 1 second of stereo i16 (96000 samples)
        let mut buf: Vec<i16> = Vec::with_capacity(96_000);
        // FIX: cursor-based encoding avoids O(N) drain on every encode.
        // Previous code did buf.drain(..chunk_size).collect() per chunk,
        // shifting the entire remaining buffer each time — O(N) per encode,
        // causing stuttering on long recordings. Now we use read_idx to
        // track consumed samples and only compact periodically.
        let mut read_idx: usize = 0;
        let mut tmp = [0u8; PUMP_CHUNK_BYTES];
        let chunk_size = 1152 * channels as usize;
        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); chunk_size * 5 / 4 + 7200];

        loop {
            let n = cons.pop_slice(&mut tmp);
            if n > 0 {
                for pair in tmp[..n].chunks_exact(2) {
                    buf.push(i16::from_le_bytes([pair[0], pair[1]]));
                }
                // O(1) encode: slice directly from buf, no allocation.
                while buf.len() - read_idx >= chunk_size {
                    let chunk_slice = &buf[read_idx..read_idx + chunk_size];
                    let encoded = {
                        let mut enc = encoder.lock().map_err(|e| e.to_string())?;
                        if channels == 1 {
                            enc.encode(mp3lame_encoder::MonoPcm(chunk_slice), &mut mp3_buf)
                        } else {
                            enc.encode(
                                mp3lame_encoder::InterleavedPcm(chunk_slice),
                                &mut mp3_buf,
                            )
                        }
                    };
                    if let Ok(w) = encoded {
                        if w > 0 {
                            let data = unsafe {
                                std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w)
                            };
                            let mut f = mp3_file.lock().map_err(|e| e.to_string())?;
                            f.write_all(data).map_err(|e| e.to_string())?;
                        }
                    }
                    read_idx += chunk_size;
                }
                // Compact every 4 chunks to prevent unbounded RAM growth.
                if read_idx > chunk_size * 4 {
                    buf.drain(..read_idx);
                    read_idx = 0;
                }
                continue;
            }
            if done.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(PUMP_SLEEP_MS));
        }

        // Flush trailing samples that didn't form a full chunk.
        let remaining = buf.len() - read_idx;
        if remaining > 0 {
            let channel_count = channels as usize;
            let aligned_len = remaining - (remaining % channel_count);
            if aligned_len > 0 {
                let chunk_slice = &buf[read_idx..read_idx + aligned_len];
                let encoded = {
                    let mut enc = encoder.lock().map_err(|e| e.to_string())?;
                    if channels == 1 {
                        enc.encode(mp3lame_encoder::MonoPcm(chunk_slice), &mut mp3_buf)
                    } else {
                        enc.encode(
                            mp3lame_encoder::InterleavedPcm(chunk_slice),
                            &mut mp3_buf,
                        )
                    }
                };
                if let Ok(w) = encoded {
                    if w > 0 {
                        let data = unsafe {
                            std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w)
                        };
                        let mut f = mp3_file.lock().map_err(|e| e.to_string())?;
                        f.write_all(data).map_err(|e| e.to_string())?;
                    }
                }
            }
        }

        // Finalize encoder + file.
        Self::cpal_finalize_encoder(&encoder, &mp3_file)?;
        Ok(())
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
        // Quality intentionally omitted: see encode_i16_to_mp3.
        b.set_brate(mp3lame_encoder::Bitrate::Kbps192)
            .map_err(|e| format!("{:?}", e))?;
        b.build().map_err(|e| format!("{:?}", e))
    }

    fn cpal_finalize_encoder(
        encoder: &Arc<Mutex<mp3lame_encoder::Encoder>>,
        mp3_file: &Arc<Mutex<BufWriter<std::fs::File>>>,
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
        let mut f = mp3_file.lock().map_err(|e| e.to_string())?;
        f.flush().map_err(|e| format!("Flush failed: {}", e))?;
        f.get_ref()
            .sync_all()
            .map_err(|e| format!("Sync failed: {}", e))?;
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
