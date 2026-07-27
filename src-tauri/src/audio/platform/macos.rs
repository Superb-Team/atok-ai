//! macOS audio capture orchestration.
//!
//! ScreenCaptureKit owns system audio, while cpal owns microphone capture.
//! Both sources write bounded, rotating PCM chunks into one unique session.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::DeviceTrait;
use cpal::SampleFormat;

use crate::audio::macos_bridge::MacSystemCapture;
use crate::audio::session::RecordingSession;
use crate::audio_aec::AEC_SAMPLE_RATE;
use crate::audio_recorder::DesktopAudioRecorder;

pub(crate) fn record(
    mp3_path: &Path,
    is_recording: &Arc<AtomicBool>,
    is_paused: &Arc<AtomicBool>,
    aec_enabled: bool,
    mic_name: Option<&str>,
    chunk_tx: Option<tokio::sync::mpsc::UnboundedSender<std::path::PathBuf>>,
) -> Result<(), String> {
    let sample_rate = AEC_SAMPLE_RATE;
    let channels = 2u32;
    let host = cpal::default_host();
    let mic_device = DesktopAudioRecorder::resolve_input_device(&host, mic_name)?;

    let mic_cfg_range = mic_device
        .supported_input_configs()
        .map_err(|error| format!("Mic supported_input_configs: {error}"))?
        .find(|config| config.sample_format() == SampleFormat::F32)
        .ok_or("Mic does not support F32")?;

    let mic_cfg = DesktopAudioRecorder::with_preferred_sample_rate(mic_cfg_range, sample_rate);
    let mic_sr = mic_cfg.sample_rate().0;
    let mic_ch = mic_cfg.channels() as u32;

    let session = RecordingSession::create(mp3_path)?;
    let session_path = session.path().to_path_buf();

    eprintln!(
        "[recorder] macOS chunked capture: session={}, mic={}Hz/{}ch",
        session_path.display(),
        mic_sr,
        mic_ch
    );

    let system_capture = MacSystemCapture::start(&session_path)?;
    DesktopAudioRecorder::write_start_meta(&session_path, "sys_start.meta");

    let mic_is_recording = Arc::clone(is_recording);
    let mic_is_paused = Arc::clone(is_paused);
    let mic_dir = session_path.clone();
    let mic_thread = match std::thread::Builder::new()
        .name("macos-mic-file".into())
        .spawn(move || {
            DesktopAudioRecorder::cpal_record_chunked(
                mic_dir,
                mic_device,
                mic_cfg,
                mic_is_recording,
                mic_is_paused,
            )
        }) {
        Ok(thread) => thread,
        Err(error) => {
            drop(system_capture);
            let _ = session.cleanup();
            return Err(format!("Failed to spawn macOS mic capture: {error}"));
        }
    };

    let worker_done = Arc::new(AtomicBool::new(false));
    let worker_done_signal = Arc::clone(&worker_done);
    let worker_dir = session_path.clone();
    let worker_mp3 = mp3_path.to_path_buf();
    let worker_thread = match std::thread::Builder::new()
        .name("macos-chunk-worker".into())
        .spawn(move || {
            DesktopAudioRecorder::chunk_worker(
                worker_dir,
                worker_mp3,
                sample_rate,
                channels,
                mic_sr,
                mic_ch,
                worker_done_signal,
                aec_enabled,
                chunk_tx,
            )
        }) {
        Ok(thread) => thread,
        Err(error) => {
            is_recording.store(false, Ordering::SeqCst);
            drop(system_capture);
            let _ = mic_thread.join();
            let _ = session.cleanup();
            return Err(format!("Failed to spawn macOS chunk worker: {error}"));
        }
    };

    while is_recording.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(100));
    }

    let system_result = system_capture.finish();
    let system_marker_result = session.mark_done("sys");
    let mic_result = match mic_thread.join() {
        Ok(result) => result,
        Err(_) => Err("macOS mic capture thread panicked".to_string()),
    };
    worker_done.store(true, Ordering::SeqCst);

    let worker_result = DesktopAudioRecorder::spawn_blocking_with_timeout(
        move || worker_thread.join(),
        Duration::from_secs(300),
    );
    match worker_result {
        Some(Ok(())) => {}
        Some(Err(_)) => {
            return Err(format!(
                "macOS chunk worker panicked; session retained at {}",
                session_path.display()
            ));
        }
        None => {
            return Err(format!(
                "macOS chunk worker timed out; session retained at {}",
                session_path.display()
            ));
        }
    }

    system_result?;
    system_marker_result?;
    mic_result?;
    DesktopAudioRecorder::verify_output(mp3_path)?;
    session.cleanup()
}
