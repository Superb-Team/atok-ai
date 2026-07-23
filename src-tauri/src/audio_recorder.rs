//! Cross-platform audio recorder.
//!
//! - Windows: WASAPI loopback + mic (windows_audio.rs)
//! - Linux:   parec (PulseAudio/PipeWire) + cpal mic → disk-backed chunked pipeline
//! - macOS:   ScreenCaptureKit + cpal mic → disk-backed chunked pipeline
//! - Fallback: cpal mic only → ringbuf batch encoding

use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;

#[cfg(target_os = "linux")]
use crate::audio_aec::AEC_SAMPLE_RATE;
use crate::audio_aec::{AecConfig, AudioAec};
use crate::audio_dsp::AudioDsp;

type RecordingResult = Result<PathBuf, String>;
type CompletionReceiver = oneshot::Receiver<RecordingResult>;

#[cfg(not(target_os = "macos"))]
const MIC_RINGBUF_BYTES: usize = 960_000; // 10s of 48kHz mono i16 LE
const CHUNK_SECONDS: u64 = 180;
const PUMP_CHUNK_BYTES: usize = 8192;
// Seconds of the previous chunk's audio prepended to each live ASR chunk so a word
// straddling the hard CHUNK_SECONDS cut is never lost; the duplicated transcript is
// de-duped when the live parts are stitched (see agent::stitch_overlapping).
const LIVE_OVERLAP_SECONDS: u64 = 5;
const PUMP_SLEEP_MS: u64 = 5;

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

    pub fn start_recording_with_aec(
        &self,
        output_path: PathBuf,
        aec_enabled: bool,
        mic_device: Option<String>,
        chunk_tx: Option<tokio::sync::mpsc::UnboundedSender<std::path::PathBuf>>,
    ) -> Result<(), String> {
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
            let result = Self::record(output_path, is_recording, aec_enabled, mic_device, chunk_tx);
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

    fn record(
        output_path: PathBuf,
        is_recording: Arc<AtomicBool>,
        aec_enabled: bool,
        mic_device: Option<String>,
        chunk_tx: Option<tokio::sync::mpsc::UnboundedSender<std::path::PathBuf>>,
    ) -> Result<PathBuf, String> {
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

        let mic_name = mic_device.as_deref();

        #[cfg(target_os = "linux")]
        {
            match Self::record_linux(&mp3_path, &is_recording, aec_enabled, mic_name, chunk_tx) {
                Ok(()) => return Ok(mp3_path),
                Err(e) => eprintln!("Linux recording failed: {}, falling back", e),
            }
        }

        #[cfg(target_os = "macos")]
        {
            crate::audio::platform::macos::record(
                &mp3_path,
                &is_recording,
                aec_enabled,
                mic_name,
                chunk_tx,
            )?;
            Ok(mp3_path)
        }

        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        drop(chunk_tx);

        #[cfg(not(target_os = "macos"))]
        {
            Self::record_with_cpal(&mp3_path, &is_recording, mic_name)?;
            Ok(mp3_path)
        }
    }

    // ==================== Linux: parec (system) + cpal (mic) ====================

    #[cfg(target_os = "linux")]
    fn record_linux(
        mp3_path: &Path,
        is_recording: &Arc<AtomicBool>,
        aec_enabled: bool,
        mic_name: Option<&str>,
        chunk_tx: Option<tokio::sync::mpsc::UnboundedSender<std::path::PathBuf>>,
    ) -> Result<(), String> {
        use cpal::traits::DeviceTrait;
        use cpal::SampleFormat;

        eprintln!("[recorder] Linux capture starting");

        let sample_rate = AEC_SAMPLE_RATE;
        let channels = 2u32;
        let sys_device = Self::linux_default_monitor_source();
        if let Some(device) = &sys_device {
            eprintln!("[recorder] System monitor: {}", device);
        }

        let host = cpal::default_host();
        // The picker shows PulseAudio source names, which don't map to cpal/ALSA
        // device names; routing the default capture through PULSE_SOURCE is how
        // the selection takes effect. Process-global, so clear it when unset or a
        // later default recording inherits a previously-selected source.
        match mic_name.filter(|n| !n.is_empty()) {
            Some(name) => std::env::set_var("PULSE_SOURCE", name),
            None => std::env::remove_var("PULSE_SOURCE"),
        }

        // Mic boost above 100% is a device-level digital pre-gain that clips loud
        // speech before capture; cap it so the DSP leveler receives a clean signal.
        let mic_source = mic_name
            .filter(|n| !n.is_empty())
            .map(String::from)
            .or_else(|| crate::linux_pulse::default_sink_and_source().map(|(_, src)| src));
        if let Some(source) = mic_source {
            if crate::linux_pulse::clamp_source_volume_to_norm(&source) == Some(true) {
                eprintln!(
                    "[recorder] Mic source '{}' volume was >100% — clamped to 100% to prevent clipping",
                    source
                );
            }
        }

        let mic_device = Self::resolve_input_device(&host, mic_name)?;

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

        eprintln!("[recorder] Chunked capture path (progressive processing)");
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
            aec_enabled,
            chunk_tx,
        )
    }

    // ==================== Disk-Backed Chunked Pipeline ====================

    /// System-audio capture via libpulse. Writes the sink monitor to chunk files
    /// with 3-minute rotation at the same sample spec.
    #[cfg(target_os = "linux")]
    fn pulse_record_chunked(
        session_dir: &Path,
        sample_rate: u32,
        channels: u32,
        device: Option<String>,
        is_recording: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        use std::io::Write;

        // No default sink monitor → skip system audio and let mic-only proceed.
        // Opening with None would capture the default *source* (mic), not system
        // audio. Signal the worker so it doesn't wait on a sys stream that never arrives.
        let Some(device) = device else {
            eprintln!("[recorder] No sink monitor; recording mic only");
            let _ = std::fs::File::create(session_dir.join("sys_done.flag"));
            return Ok(());
        };

        eprintln!("[recorder] pulse capture starting (chunked): {}", device);

        let mut capture = crate::linux_pulse::MonitorCapture::open(Some(&device))
            .map_err(|e| format!("Failed to open pulse monitor: {}", e))?;

        // The server starts buffering at open, so this is when byte 0 of the sys
        // stream happened. The worker uses it to time-align sys against mic.
        Self::write_start_meta(session_dir, "sys_start.meta");

        let mut buf = [0u8; 8192];
        let mut bytes_written = 0u64;
        let mut chunk_idx = 0u32;
        let max_bytes = sample_rate as u64 * channels as u64 * 2 * CHUNK_SECONDS;
        let mut file = std::fs::File::create(session_dir.join(format!("sys_{:04}.raw", chunk_idx)))
            .map_err(|e| format!("Create sys chunk: {}", e))?;

        while is_recording.load(Ordering::SeqCst) {
            if let Err(e) = capture.read(&mut buf) {
                eprintln!("[recorder] pulse read error: {}", e);
                break;
            }
            file.write_all(&buf)
                .map_err(|e| format!("Write sys: {}", e))?;
            bytes_written += buf.len() as u64;
            if bytes_written >= max_bytes {
                file.flush().ok();
                chunk_idx += 1;
                bytes_written = 0;
                file = std::fs::File::create(session_dir.join(format!("sys_{:04}.raw", chunk_idx)))
                    .map_err(|e| format!("Create sys chunk: {}", e))?;
            }
        }

        file.flush().ok();
        let _ = std::fs::File::create(session_dir.join("sys_done.flag"));
        eprintln!(
            "[recorder] pulse capture stopped (chunked, {} chunks)",
            chunk_idx + 1
        );
        Ok(())
    }

    /// Mic capture into 3-minute rotating chunk files. The cpal callback is
    /// wait-free — it only converts to i16 LE and pushes to a ring buffer; a
    /// dedicated drain thread does all file I/O and rotation off the audio thread.
    pub(crate) fn cpal_record_chunked(
        session_dir: PathBuf,
        mic_device: cpal::Device,
        mic_cfg: cpal::SupportedStreamConfig,
        is_recording: Arc<AtomicBool>,
    ) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, StreamTrait};

        eprintln!("[recorder] mic starting (chunked, ringbuf)");

        let mic_sr = mic_cfg.sample_rate().0;
        let mic_ch = mic_cfg.channels() as u32;

        // ~10s of headroom sized for the real channel count, so a brief disk
        // stall in the drain thread can't overflow the ring.
        let ring_bytes = (mic_sr as usize * mic_ch as usize * 2 * 10).max(PUMP_CHUNK_BYTES * 8);
        let (mut prod, mut cons) = HeapRb::<u8>::new(ring_bytes).split();
        let producer_done = Arc::new(AtomicBool::new(false));
        let overruns = Arc::new(std::sync::atomic::AtomicU64::new(0));

        let cb_overruns = overruns.clone();
        let mic_stream = {
            let mut scratch: Vec<u8> = Vec::with_capacity(PUMP_CHUNK_BYTES * 4);
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
                        let pushed = prod.push_slice(&scratch);
                        if pushed < scratch.len() {
                            cb_overruns
                                .fetch_add((scratch.len() - pushed) as u64, Ordering::Relaxed);
                        }
                    },
                    move |err| eprintln!("[recorder] Mic stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Mic stream build failed: {}", e))?
        };
        mic_stream
            .play()
            .map_err(|e| format!("Mic play failed: {}", e))?;

        // Byte 0 of the mic stream corresponds to when the stream went live; the
        // worker uses this to time-align mic against the sys capture for AEC.
        Self::write_start_meta(&session_dir, "mic_start.meta");

        let drain_done = producer_done.clone();
        let drain_dir = session_dir.clone();
        let drain = std::thread::Builder::new()
            .name("mic-drain".into())
            .spawn(move || -> Result<(), String> {
                let max_bytes = mic_sr as u64 * mic_ch as u64 * 2 * CHUNK_SECONDS;
                let mut chunk_idx = 0u32;
                let mut written = 0u64;
                let mut file = BufWriter::new(
                    std::fs::File::create(drain_dir.join("mic_0000.raw"))
                        .map_err(|e| format!("Create mic chunk: {}", e))?,
                );
                let mut tmp = [0u8; PUMP_CHUNK_BYTES];
                loop {
                    let n = cons.pop_slice(&mut tmp);
                    if n > 0 {
                        file.write_all(&tmp[..n])
                            .map_err(|e| format!("Write mic: {}", e))?;
                        written += n as u64;
                        if written >= max_bytes {
                            file.flush().ok();
                            chunk_idx += 1;
                            written = 0;
                            file = BufWriter::new(
                                std::fs::File::create(
                                    drain_dir.join(format!("mic_{:04}.raw", chunk_idx)),
                                )
                                .map_err(|e| format!("Create mic chunk: {}", e))?,
                            );
                        }
                        continue;
                    }
                    if drain_done.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(PUMP_SLEEP_MS));
                }
                file.flush().ok();
                Ok(())
            })
            .map_err(|e| format!("Failed to spawn mic drain: {}", e))?;

        while is_recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        drop(mic_stream);
        std::thread::sleep(std::time::Duration::from_millis(200));
        producer_done.store(true, Ordering::SeqCst);
        drain
            .join()
            .map_err(|_| "mic drain thread panicked".to_string())??;

        let dropped = overruns.load(Ordering::Relaxed);
        if dropped > 0 {
            eprintln!(
                "[recorder] WARNING: mic ring overran, dropped {} bytes",
                dropped
            );
        }
        let _ = std::fs::File::create(session_dir.join("mic_done.flag"));
        eprintln!("[recorder] mic stopped (chunked)");
        Ok(())
    }

    /// Process one chunk: resample, denoise, mix. Returns mixed PCM.
    #[allow(clippy::too_many_arguments)]
    fn process_chunk_batch(
        sys_data: &[u8],
        mic_data: &[u8],
        mic_sr: u32,
        sample_rate: u32,
        channels: u32,
        mic_ch: u32,
        dsp: &mut AudioDsp,
        denoisers: &mut Vec<Box<nnnoiseless::DenoiseState>>,
        apply_denoise: bool,
    ) -> Vec<i16> {
        let has_sys = sys_data.len() > 1024;
        let has_mic = mic_data.len() > 1024;

        if !has_sys && !has_mic {
            return Vec::new();
        }

        let (sys_final, mic_final, final_sr) = if has_sys && has_mic && mic_sr != sample_rate {
            let resampled = Self::resample_linear(mic_data, mic_sr, sample_rate, mic_ch);
            (sys_data.to_vec(), resampled, sample_rate)
        } else if has_sys && has_mic {
            (sys_data.to_vec(), mic_data.to_vec(), sample_rate)
        } else if has_sys {
            (sys_data.to_vec(), Vec::new(), sample_rate)
        } else {
            (Vec::new(), mic_data.to_vec(), mic_sr)
        };

        let mic_final = if has_mic && apply_denoise {
            Self::denoise_mic_pcm_with_state(&mic_final, final_sr, mic_ch, denoisers)
        } else {
            mic_final
        };

        // The chunk encoder is fixed at `channels`; deliver mic as stereo whenever
        // the session is stereo so a mono-mic chunk isn't encoded at 2x speed.
        let sys_out = sys_final;
        let mic_out = if mic_ch == 1 && channels == 2 && !mic_final.is_empty() {
            Self::mono_to_stereo(&mic_final)
        } else {
            mic_final
        };

        if !sys_out.is_empty() && !mic_out.is_empty() {
            dsp.process(&sys_out, &mic_out)
        } else if !sys_out.is_empty() {
            dsp.process(&sys_out, &[])
        } else if !mic_out.is_empty() {
            dsp.process(&[], &mic_out)
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

    /// Write the current wall-clock (epoch millis) to `session_dir/{name}` so the
    /// chunk worker can compute the start offset between the sys and mic streams.
    pub(crate) fn write_start_meta(session_dir: &Path, name: &str) {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let _ = std::fs::write(session_dir.join(name), millis.to_string());
    }

    /// Bytes of S16LE PCM covering `offset_ms` at the given format, rounded down
    /// to a whole interleaved frame so a trim never splits a sample pair.
    fn trim_lead_bytes(offset_ms: u64, sample_rate: u32, channels: u32) -> usize {
        let frames = (offset_ms * sample_rate as u64) / 1000;
        frames as usize * channels as usize * 2
    }

    /// Compute how many leading bytes to drop from the sys and mic streams so both
    /// start at the same wall-clock instant. The captures start in separate threads
    /// at different times (pulse open vs cpal play, often 100ms+ apart); pairing
    /// chunk files by index without this trim feeds the AEC misaligned
    /// render/capture, which its delay-agnostic filter converges on slowly or not
    /// at all — echo then leaks into the transcript. Returns (sys_trim, mic_trim).
    fn compute_start_trims(
        session_dir: &Path,
        sample_rate: u32,
        channels: u32,
        mic_sr: u32,
        mic_ch: u32,
        done: &Arc<AtomicBool>,
    ) -> (usize, usize) {
        let sys_meta = session_dir.join("sys_start.meta");
        let mic_meta = session_dir.join("mic_start.meta");
        let sys_flag = session_dir.join("sys_done.flag");
        let mic_flag = session_dir.join("mic_done.flag");

        // The metas appear within milliseconds of the capture threads starting;
        // the done-flags cover streams that never start (e.g. mic-only sessions).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            let sys_known = sys_meta.exists() || sys_flag.exists();
            let mic_known = mic_meta.exists() || mic_flag.exists();
            if (sys_known && mic_known) || done.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let read_millis =
            |p: &Path| -> Option<u64> { std::fs::read_to_string(p).ok()?.trim().parse().ok() };
        let (Some(sys_start), Some(mic_start)) = (read_millis(&sys_meta), read_millis(&mic_meta))
        else {
            return (0, 0);
        };

        if sys_start < mic_start {
            let offset = mic_start - sys_start;
            let trim = Self::trim_lead_bytes(offset, sample_rate, channels);
            eprintln!(
                "[Worker] Stream alignment: sys leads by {}ms, trimming {} bytes from sys",
                offset, trim
            );
            (trim, 0)
        } else {
            let offset = sys_start - mic_start;
            let trim = Self::trim_lead_bytes(offset, mic_sr, mic_ch);
            eprintln!(
                "[Worker] Stream alignment: mic leads by {}ms, trimming {} bytes from mic",
                offset, trim
            );
            (0, trim)
        }
    }

    /// Fraction of S16LE samples at (or within a hair of) full scale. A clipped
    /// capture cannot be repaired downstream, so the worker only reports it.
    fn clipped_ratio(pcm: &[u8]) -> f32 {
        let total = pcm.len() / 2;
        if total == 0 {
            return 0.0;
        }
        let clipped = pcm
            .chunks_exact(2)
            .filter(|c| i16::from_le_bytes([c[0], c[1]]).unsigned_abs() >= 32700)
            .count();
        clipped as f32 / total as f32
    }

    /// Background worker: reads chunk files, processes, encodes to MP3.
    /// DSP state (HPF filters, noise gate, limiter) and RNNoise DenoiseState are
    /// persistent across chunks to avoid settling transients at chunk boundaries.
    ///
    /// When `chunk_tx` is Some, each processed chunk is also encoded to a
    /// standalone MP3 file (`{mp3_stem}_chunk_{N}.mp3`) alongside the main MP3,
    /// and its path is sent on the channel so `transcribe_chunks_live` can
    /// upload and transcribe it while recording continues.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn chunk_worker(
        session_dir: PathBuf,
        mp3_path: PathBuf,
        sample_rate: u32,
        channels: u32,
        mic_sr: u32,
        mic_ch: u32,
        done: Arc<AtomicBool>,
        aec_enabled: bool,
        chunk_tx: Option<tokio::sync::mpsc::UnboundedSender<std::path::PathBuf>>,
    ) {
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
        let mut dsp = AudioDsp::new(0.0);
        let mut denoisers: Vec<Box<nnnoiseless::DenoiseState>> = Vec::new();

        // Separate gentle chain for the live ASR branch (no RNNoise, soft gate) so
        // Whisper sees natural speech while the saved MP3 keeps the firm playback
        // chain. `prev_asr_tail` carries a few seconds of audio across the hard cut so
        // a word straddling the boundary isn't lost (de-duped on transcript merge).
        let mut dsp_asr = AudioDsp::new_for_asr(0.0);
        let mut prev_asr_tail: Vec<i16> = Vec::new();
        let overlap_samples =
            sample_rate as usize * channels as usize * LIVE_OVERLAP_SECONDS as usize;

        let live_stem: String = mp3_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("recording")
            .to_string();

        let mut aec = AudioAec::new(AecConfig {
            enabled: aec_enabled,
            capture_channels: mic_ch as i32,
            render_channels: channels as i32,
            ..Default::default()
        });

        let (mut pending_sys_trim, mut pending_mic_trim) =
            Self::compute_start_trims(&session_dir, sample_rate, channels, mic_sr, mic_ch, &done);

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

                let mut sys_data = std::fs::read(&sys_path).unwrap_or_default();
                let mut mic_data = std::fs::read(&mic_path).unwrap_or_default();
                let mut effective_mic_sr = mic_sr;

                if pending_sys_trim > 0 && !sys_data.is_empty() {
                    let n = pending_sys_trim.min(sys_data.len());
                    sys_data.drain(..n);
                    pending_sys_trim -= n;
                }
                if pending_mic_trim > 0 && !mic_data.is_empty() {
                    let n = pending_mic_trim.min(mic_data.len());
                    mic_data.drain(..n);
                    pending_mic_trim -= n;
                }

                let clip = Self::clipped_ratio(&mic_data);
                if clip > 0.005 {
                    eprintln!(
                        "[Worker] Mic input clipping ({:.1}% of samples) — audio may sound distorted; lower the mic input gain",
                        clip * 100.0
                    );
                }

                if !sys_data.is_empty() && !mic_data.is_empty() && effective_mic_sr != sample_rate {
                    mic_data =
                        Self::resample_linear(&mic_data, effective_mic_sr, sample_rate, mic_ch);
                    effective_mic_sr = sample_rate;
                }

                // AEC: remove echo from mic using sys as reference.
                // Must run before denoising, with both streams normalized to 48kHz s16le.
                if aec.is_enabled() && !sys_data.is_empty() && !mic_data.is_empty() {
                    mic_data = aec.process_chunk(&sys_data, &mic_data);
                }

                let mixed = Self::process_chunk_batch(
                    &sys_data,
                    &mic_data,
                    effective_mic_sr,
                    sample_rate,
                    channels,
                    mic_ch,
                    &mut dsp,
                    &mut denoisers,
                    true,
                );

                if !mixed.is_empty() {
                    Self::encode_chunk_to_mp3(&mut encoder, &mut mp3_file, &mixed, channels);
                }

                // Live ASR: prepend the previous chunk's overlap tail so the 3-min
                // cut never drops a word. Written to temp (not session_dir, which
                // may be removed while uploads still read); the live pipeline
                // deletes each file once uploaded.
                if let Some(tx) = &chunk_tx {
                    let mixed_asr = Self::process_chunk_batch(
                        &sys_data,
                        &mic_data,
                        effective_mic_sr,
                        sample_rate,
                        channels,
                        mic_ch,
                        &mut dsp_asr,
                        &mut denoisers,
                        false,
                    );
                    if !mixed_asr.is_empty() {
                        let mut overlapped =
                            Vec::with_capacity(prev_asr_tail.len() + mixed_asr.len());
                        overlapped.extend_from_slice(&prev_asr_tail);
                        overlapped.extend_from_slice(&mixed_asr);
                        let tail_start = mixed_asr.len().saturating_sub(overlap_samples);
                        prev_asr_tail = mixed_asr[tail_start..].to_vec();

                        let chunk_mp3 = std::env::temp_dir().join(format!(
                            "atok_live_{}_chunk_{:04}.mp3",
                            live_stem, current_chunk
                        ));
                        match Self::encode_chunk_standalone(
                            &overlapped,
                            &chunk_mp3,
                            sample_rate,
                            channels,
                        ) {
                            Ok(()) => {
                                let _ = tx.send(chunk_mp3);
                            }
                            Err(e) => eprintln!(
                                "[Worker] Chunk {:04} standalone encode failed: {}",
                                current_chunk, e
                            ),
                        }
                    }
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

        Self::finalize_chunk_encoder(&mut encoder, &mut mp3_file);
        eprintln!(
            "[Worker] All chunks processed. MP3 ready: {}",
            mp3_path.display()
        );
    }

    /// Encode `samples` to a self-contained MP3 file at `path` using a fresh
    /// LAME encoder. Used by the chunk_worker to produce per-chunk MP3 files
    /// that the live transcription pipeline uploads while recording continues.
    fn encode_chunk_standalone(
        samples: &[i16],
        path: &Path,
        sample_rate: u32,
        channels: u32,
    ) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        let mut encoder = Self::build_cpal_encoder(sample_rate, channels)?;
        let file = std::fs::File::create(path)
            .map_err(|e| format!("Create chunk MP3 '{}': {}", path.display(), e))?;
        let mut writer = std::io::BufWriter::new(file);
        Self::encode_chunk_to_mp3(&mut encoder, &mut writer, samples, channels);
        Self::finalize_chunk_encoder(&mut encoder, &mut writer);
        Ok(())
    }

    fn encode_chunk_to_mp3(
        encoder: &mut mp3lame_encoder::Encoder,
        file: &mut std::io::BufWriter<std::fs::File>,
        samples: &[i16],
        channels: u32,
    ) {
        use mp3lame_encoder::{InterleavedPcm, MonoPcm};

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
                    let data =
                        unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w) };
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

        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); 8192];
        if let Ok(w) = encoder.flush::<FlushNoGap>(&mut mp3_buf) {
            if w > 0 {
                let data = unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w) };
                let _ = file.write_all(data);
            }
        }
        let _ = file.flush();
    }

    /// Orchestrates chunked capture + background processing.
    #[cfg(target_os = "linux")]
    #[allow(clippy::too_many_arguments)]
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
        aec_enabled: bool,
        chunk_tx: Option<tokio::sync::mpsc::UnboundedSender<std::path::PathBuf>>,
    ) -> Result<(), String> {
        let session_id = format!(
            "session_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("SystemTime error: {}", e))?
                .as_millis()
        );
        let session_dir = std::env::temp_dir().join(format!("atok_{}", session_id));
        std::fs::create_dir_all(&session_dir).map_err(|e| format!("Create session dir: {}", e))?;

        eprintln!(
            "[recorder] Chunked capture: session={}",
            session_dir.display()
        );

        let producer_done = Arc::new(AtomicBool::new(false));

        let sys_is_rec = is_recording.clone();
        let sys_dir = session_dir.clone();
        let sys_thread = std::thread::Builder::new()
            .name("pulse-sys".into())
            .spawn(move || {
                Self::pulse_record_chunked(&sys_dir, sample_rate, channels, sys_device, &sys_is_rec)
            })
            .map_err(|e| format!("Failed to spawn pulse capture: {}", e))?;

        let mic_is_rec = is_recording.clone();
        let mic_dir = session_dir.clone();
        let mic_device_c = mic_device.clone();
        let mic_cfg_c = mic_cfg.clone();
        let mic_thread = std::thread::Builder::new()
            .name("mic-file".into())
            .spawn(move || Self::cpal_record_chunked(mic_dir, mic_device_c, mic_cfg_c, mic_is_rec))
            .map_err(|e| format!("Failed to spawn mic: {}", e))?;

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
                    aec_enabled,
                    chunk_tx,
                )
            })
            .map_err(|e| format!("Failed to spawn worker: {}", e))?;

        eprintln!("[recorder] Streams playing (chunked)");

        while is_recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        eprintln!("[recorder] Stop signal sent");

        let _ = sys_thread.join();
        let _ = mic_thread.join();

        producer_done.store(true, Ordering::SeqCst);

        let worker_result = Self::spawn_blocking_with_timeout(
            move || worker_thread.join(),
            std::time::Duration::from_secs(300),
        );

        // Only clean up once the worker has finished. If it timed out it may still
        // be reading/writing chunk files, so deleting the dir would corrupt its
        // in-flight work; leak the temp dir instead (the MP3 lives elsewhere).
        if worker_result.is_some() {
            let _ = std::fs::remove_dir_all(&session_dir);
        } else {
            eprintln!(
                "[recorder] Worker join timed out; leaving session dir intact: {}",
                session_dir.display()
            );
        }

        eprintln!("[recorder] Encoding done");
        Self::verify_output(mp3_path)
    }

    pub(crate) fn spawn_blocking_with_timeout<F, T>(f: F, timeout: std::time::Duration) -> Option<T>
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

    #[cfg(target_os = "linux")]
    fn linux_default_monitor_source() -> Option<String> {
        crate::linux_pulse::default_sink_and_source().map(|(sink, _)| format!("{}.monitor", sink))
    }

    // ==================== Shared: Encoding & Utils ====================

    #[cfg(test)]
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

    /// One-shot mic denoise (fresh RNNoise state per call) for unit coverage.
    /// Runtime chunking uses the state-persisting
    /// [`Self::denoise_mic_pcm_with_state`] instead.
    #[cfg(test)]
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

    /// Resolve the cpal input device whose name matches `name`, falling back to
    /// the system default. Note: on Linux the device picker may show PulseAudio
    /// source names that don't match cpal/ALSA names — those fall back to default.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(crate) fn resolve_input_device(
        host: &cpal::Host,
        name: Option<&str>,
    ) -> Result<cpal::Device, String> {
        use cpal::traits::{DeviceTrait, HostTrait};
        if let Some(want) = name.filter(|n| !n.is_empty()) {
            if let Ok(mut devices) = host.input_devices() {
                if let Some(dev) = devices.find(|d| d.name().map(|n| n == want).unwrap_or(false)) {
                    eprintln!("[recorder] Using selected mic: {}", want);
                    return Ok(dev);
                }
            }
            eprintln!(
                "[recorder] Mic '{}' not found via cpal; using default",
                want
            );
        }
        host.default_input_device()
            .ok_or_else(|| "No default input device (mic)".to_string())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(crate) fn with_preferred_sample_rate(
        config: cpal::SupportedStreamConfigRange,
        preferred_sample_rate: u32,
    ) -> cpal::SupportedStreamConfig {
        let sample_rate =
            preferred_sample_rate.clamp(config.min_sample_rate().0, config.max_sample_rate().0);
        config.with_sample_rate(cpal::SampleRate(sample_rate))
    }

    // ==================== Device enumeration (Linux/macOS) ====================

    /// Clean technical PulseAudio/ALSA device names into human-readable display names.
    #[cfg(target_os = "linux")]
    fn clean_device_name(raw: &str) -> String {
        let lower = raw.to_lowercase();

        if lower == "default" || lower == "pulse" || lower == "pipewire" {
            return "Default Mic".to_string();
        }

        if lower.ends_with(".monitor") {
            return "System Audio".to_string();
        }

        if let Some(rest) = lower.strip_prefix("alsa_input.") {
            if rest.contains("pci") {
                return "Built-in Mic".to_string();
            }
            if rest.contains("usb") {
                return Self::extract_usb_device_name(raw);
            }
        }

        if lower.starts_with("alsa_output.") {
            if lower.contains("usb") {
                return "USB Audio".to_string();
            }
            return "Built-in Audio".to_string();
        }

        if lower.starts_with("bluez_source.") {
            return Self::extract_bluetooth_device_name(raw);
        }

        if lower.contains("hdmi") || lower.contains("dp") {
            return "Display Audio".to_string();
        }

        if raw.len() > 25 {
            format!("{}…", &raw[..23])
        } else {
            raw.to_string()
        }
    }

    #[cfg(target_os = "linux")]
    fn extract_usb_device_name(raw: &str) -> String {
        let lower = raw.to_lowercase();
        if lower.contains("headset") || lower.contains("headphone") {
            return "USB Headset".to_string();
        }
        "USB Mic".to_string()
    }

    #[cfg(target_os = "linux")]
    fn extract_bluetooth_device_name(raw: &str) -> String {
        let lower = raw.to_lowercase();
        if lower.contains("headset") || lower.contains("headphone") {
            return "BT Headset".to_string();
        }
        if lower.contains("speaker") {
            return "BT Speaker".to_string();
        }
        "BT Device".to_string()
    }

    /// Sources via libpulse introspection (no external `pactl`).
    /// Returns Vec of (pa_name, display_name, is_default).
    #[cfg(target_os = "linux")]
    fn pulse_list_sources() -> Vec<(String, String, bool)> {
        let default_source = crate::linux_pulse::default_sink_and_source()
            .map(|(_, source)| source)
            .unwrap_or_default();

        crate::linux_pulse::list_sources()
            .into_iter()
            .filter(|s| !s.is_monitor)
            .map(|s| {
                let is_default = s.name == default_source;
                let display = Self::clean_device_name(&s.name);
                (s.name, display, is_default)
            })
            .collect()
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn list_input_devices(&self) -> Result<Vec<crate::AudioDeviceInfo>, String> {
        use cpal::traits::{DeviceTrait, HostTrait};

        let host = cpal::default_host();
        let default_name = host
            .default_input_device()
            .and_then(|d| d.name().ok())
            .unwrap_or_default();

        #[cfg(target_os = "linux")]
        {
            let pa_devices = Self::pulse_list_sources();
            if !pa_devices.is_empty() {
                let mut seen_display = std::collections::HashSet::new();
                let mut devices: Vec<crate::AudioDeviceInfo> = pa_devices
                    .into_iter()
                    .filter(|(name, _, _)| !name.ends_with(".monitor"))
                    .filter(|(_, display, _)| seen_display.insert(display.clone()))
                    .map(|(pa_name, display, is_default)| {
                        let is_def = is_default || pa_name == default_name;
                        crate::AudioDeviceInfo {
                            raw_name: pa_name,
                            display_name: display,
                            device_type: "mic".to_string(),
                            is_default: is_def,
                        }
                    })
                    .collect();

                devices.sort_by(|a, b| {
                    b.is_default
                        .cmp(&a.is_default)
                        .then_with(|| a.display_name.cmp(&b.display_name))
                });

                return Ok(devices);
            }
        }

        let mut seen_display = std::collections::HashSet::new();
        let mut devices: Vec<crate::AudioDeviceInfo> = host
            .input_devices()
            .map_err(|e| format!("Failed to enumerate input devices: {}", e))?
            .filter_map(|d| d.name().ok().map(|n| n.to_string()))
            .filter_map(|name| {
                let is_default = name == default_name;
                #[cfg(target_os = "linux")]
                let display = Self::clean_device_name(&name);
                #[cfg(target_os = "macos")]
                let display = name.clone();
                if seen_display.insert(display.clone()) {
                    Some(crate::AudioDeviceInfo {
                        raw_name: name,
                        display_name: display,
                        device_type: "mic".to_string(),
                        is_default,
                    })
                } else {
                    None
                }
            })
            .collect();

        devices.sort_by(|a, b| {
            b.is_default
                .cmp(&a.is_default)
                .then_with(|| a.display_name.cmp(&b.display_name))
        });

        Ok(devices)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn check_device_status(&self) -> Result<crate::DeviceStatus, String> {
        use cpal::traits::{DeviceTrait, HostTrait};

        let host = cpal::default_host();

        let mic_raw = host
            .default_input_device()
            .and_then(|d| d.name().ok().map(|n| n.to_string()));

        let mic_available = mic_raw.is_some();

        #[cfg(target_os = "linux")]
        let (mic_display, sys_available, sys_display) = {
            let mic_disp = mic_raw.as_deref().map(Self::clean_device_name);
            match Self::linux_default_monitor_source() {
                Some(raw) => (mic_disp, true, Some(Self::clean_device_name(&raw))),
                None => (mic_disp, false, None),
            }
        };

        #[cfg(target_os = "macos")]
        let (mic_display, sys_available, sys_display) = {
            let mic_disp = mic_raw.as_deref().map(|n| n.to_string());
            (mic_disp, true, Some("ScreenCaptureKit".to_string()))
        };

        Ok(crate::DeviceStatus {
            mic_available,
            mic_name: mic_raw,
            mic_display_name: mic_display,
            system_audio_available: sys_available,
            system_audio_name: sys_display.clone(),
            system_audio_display_name: sys_display,
        })
    }

    // ==================== cpal Fallback (mic only, all platforms) ====================

    #[cfg(not(target_os = "macos"))]
    fn record_with_cpal(
        mp3_path: &Path,
        is_recording: &Arc<AtomicBool>,
        mic_name: Option<&str>,
    ) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, StreamTrait};
        use cpal::SampleFormat;

        let host = cpal::default_host();
        let mic = Self::resolve_input_device(&host, mic_name)?;

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

        let mp3_file = Arc::new(Mutex::new(BufWriter::new(
            std::fs::File::create(mp3_path).map_err(|e| format!("Create file failed: {}", e))?,
        )));
        let encoder = Self::build_cpal_encoder(sample_rate, channels)?;
        let encoder = Arc::new(Mutex::new(encoder));

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
    #[cfg(not(target_os = "macos"))]
    fn cpal_encoding_thread(
        mut cons: impl Consumer<Item = u8>,
        encoder: Arc<Mutex<mp3lame_encoder::Encoder>>,
        mp3_file: Arc<Mutex<BufWriter<std::fs::File>>>,
        done: Arc<AtomicBool>,
        channels: u32,
    ) -> Result<(), String> {
        let mut buf: Vec<i16> = Vec::with_capacity(96_000);
        // Cursor-based encoding avoids an O(N) buf.drain(..chunk_size) per chunk,
        // which shifted the whole remaining buffer each time and caused
        // stuttering on long recordings.
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
                while buf.len() - read_idx >= chunk_size {
                    let chunk_slice = &buf[read_idx..read_idx + chunk_size];
                    let encoded = {
                        let mut enc = encoder.lock().map_err(|e| e.to_string())?;
                        if channels == 1 {
                            enc.encode(mp3lame_encoder::MonoPcm(chunk_slice), &mut mp3_buf)
                        } else {
                            enc.encode(mp3lame_encoder::InterleavedPcm(chunk_slice), &mut mp3_buf)
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
                        enc.encode(mp3lame_encoder::InterleavedPcm(chunk_slice), &mut mp3_buf)
                    }
                };
                if let Ok(w) = encoded {
                    if w > 0 {
                        let data =
                            unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w) };
                        let mut f = mp3_file.lock().map_err(|e| e.to_string())?;
                        f.write_all(data).map_err(|e| e.to_string())?;
                    }
                }
            }
        }

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

    #[cfg(not(target_os = "macos"))]
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

    pub(crate) fn verify_output(path: &Path) -> Result<(), String> {
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
    fn trim_lead_bytes_covers_offset_in_whole_frames() {
        // 250ms @ 48kHz stereo S16 = 12_000 frames * 4 bytes.
        assert_eq!(
            DesktopAudioRecorder::trim_lead_bytes(250, 48_000, 2),
            48_000
        );
        assert_eq!(DesktopAudioRecorder::trim_lead_bytes(0, 48_000, 2), 0);
        // 1ms @ 44.1kHz mono rounds down to 44 frames * 2 bytes.
        assert_eq!(DesktopAudioRecorder::trim_lead_bytes(1, 44_100, 1), 88);
        // Result is always a multiple of the frame size.
        assert_eq!(DesktopAudioRecorder::trim_lead_bytes(7, 48_000, 2) % 4, 0);
    }

    #[test]
    fn clipped_ratio_flags_full_scale_samples() {
        let clean: Vec<u8> = test_pcm_samples(1000)
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        assert_eq!(DesktopAudioRecorder::clipped_ratio(&clean), 0.0);

        let half_clipped: Vec<u8> = (0..1000)
            .map(|i| if i % 2 == 0 { i16::MAX } else { 100 })
            .flat_map(|s: i16| s.to_le_bytes())
            .collect();
        let ratio = DesktopAudioRecorder::clipped_ratio(&half_clipped);
        assert!((ratio - 0.5).abs() < 1e-6, "ratio={}", ratio);

        assert_eq!(DesktopAudioRecorder::clipped_ratio(&[]), 0.0);
    }

    #[test]
    fn compute_start_trims_prefers_meta_files() {
        let dir = std::env::temp_dir().join(format!(
            "atok-align-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // sys started 100ms before mic → trim sys head, leave mic alone.
        std::fs::write(dir.join("sys_start.meta"), "1000").unwrap();
        std::fs::write(dir.join("mic_start.meta"), "1100").unwrap();

        let done = Arc::new(AtomicBool::new(false));
        let (sys_trim, mic_trim) =
            DesktopAudioRecorder::compute_start_trims(&dir, 48_000, 2, 44_100, 1, &done);
        assert_eq!(
            sys_trim,
            DesktopAudioRecorder::trim_lead_bytes(100, 48_000, 2)
        );
        assert_eq!(mic_trim, 0);

        // Missing metas (e.g. mic-only session) → no trim, no waiting forever.
        std::fs::remove_file(dir.join("sys_start.meta")).unwrap();
        std::fs::write(dir.join("sys_done.flag"), "").unwrap();
        let (sys_trim, mic_trim) =
            DesktopAudioRecorder::compute_start_trims(&dir, 48_000, 2, 44_100, 1, &done);
        assert_eq!((sys_trim, mic_trim), (0, 0));

        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn encode_chunk_standalone_produces_valid_mp3() {
        let path = temp_mp3_path("standalone");
        let samples: Vec<i16> = (0..96_000)
            .map(|i| ((i as f32 * 0.01_f32).sin() * 8000.0) as i16)
            .collect();
        let result = DesktopAudioRecorder::encode_chunk_standalone(&samples, &path, 48000, 2);
        assert!(result.is_ok(), "{result:?}");
        assert!(std::fs::metadata(&path).unwrap().len() > 100);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn mono_mic_only_chunk_outputs_stereo_length() {
        // A mono mic-only chunk must be up-converted to stereo so the fixed stereo
        // encoder doesn't replay it at 2x speed (regression for the mono-mic bug).
        let mic_samples = 4096usize;
        let mic: Vec<u8> = (0..mic_samples)
            .map(|i| ((i as f32 * 0.05).sin() * 8000.0) as i16)
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let mut dsp = AudioDsp::new(0.0);
        let mut denoisers: Vec<Box<nnnoiseless::DenoiseState>> = Vec::new();

        let out = DesktopAudioRecorder::process_chunk_batch(
            &[],
            &mic,
            48_000,
            48_000,
            2,
            1,
            &mut dsp,
            &mut denoisers,
            true,
        );

        assert_eq!(out.len() % 2, 0, "output must be stereo-interleaved");
        assert!(
            out.len() >= mic_samples * 2 - 64,
            "expected ~stereo length (~{}), got {}",
            mic_samples * 2,
            out.len()
        );
    }

    #[test]
    fn system_only_chunk_preserves_stereo_frame_count() {
        let stereo_frames = 4096usize;
        let system: Vec<u8> = (0..stereo_frames * 2)
            .map(|index| ((index as f32 * 0.03).sin() * 6000.0) as i16)
            .flat_map(i16::to_le_bytes)
            .collect();
        let mut dsp = AudioDsp::new(0.0);
        let mut denoisers: Vec<Box<nnnoiseless::DenoiseState>> = Vec::new();

        let out = DesktopAudioRecorder::process_chunk_batch(
            &system,
            &[],
            48_000,
            48_000,
            2,
            1,
            &mut dsp,
            &mut denoisers,
            true,
        );

        assert_eq!(out.len(), stereo_frames * 2);
    }
}
