use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

mod audio;
pub use audio::{AudioDeviceInfo, DeviceStatus};

mod agent;
mod audio_aec;
mod audio_dsp;
mod audio_import;
mod auth;
mod config;
mod database;
mod mcp_auth;
mod models;
mod note_assets;
mod notes;
mod processing_jobs;
mod tasks;

// Platform-specific audio recording — captures system audio + mic (like Google Meet/Zoom/Discord)
// Windows: WASAPI loopback + mic (windows_audio.rs)
// Linux:   PulseAudio native API (audio_recorder.rs)
// macOS:   ScreenCaptureKit native API (audio_recorder.rs)
#[cfg(windows)]
mod windows_audio;

#[cfg(not(windows))]
mod audio_recorder;

#[cfg(target_os = "linux")]
mod linux_pulse;

#[cfg(windows)]
use windows_audio::DesktopAudioRecorder;

#[cfg(not(windows))]
use audio_recorder::DesktopAudioRecorder;

lazy_static::lazy_static! {
    static ref RECORDER: Arc<Mutex<DesktopAudioRecorder>> = Arc::new(Mutex::new(DesktopAudioRecorder::new()));
}

#[tauri::command]
async fn start_desktop_recording(
    output_path: String,
    mic_device: Option<String>,
    language: Option<String>,
) -> Result<String, String> {
    let aec = AEC_ENABLED.load(AtomicOrdering::Relaxed);
    let language = language.unwrap_or_else(|| "id".to_string());

    // Build the transcript sidecar path alongside the final MP3. The chunked
    // Linux pipeline sends each per-chunk MP3 path on this channel, and
    // transcribe_chunks_live uploads + stitches them while recording continues.
    // transcribe_audio checks for this file first and returns it instantly.
    let mp3_path = {
        let p = std::path::PathBuf::from(&output_path);
        if p.extension().map(|e| e == "mp3").unwrap_or(false) {
            p
        } else {
            p.with_extension("mp3")
        }
    };
    let transcript_path = mp3_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(format!(
            "{}.transcript.txt",
            mp3_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("recording")
        ));

    let (chunk_tx, chunk_rx) = tokio::sync::mpsc::unbounded_channel::<std::path::PathBuf>();

    let api_key = std::env::var("DEEPINFRA_API_KEY").unwrap_or_default();
    let handle = tokio::spawn(agent::transcribe_chunks_live(
        chunk_rx,
        api_key,
        transcript_path,
        language,
    ));
    // Register so transcribe_audio awaits this live job instead of racing it into
    // a redundant second full-file split (double Whisper cost / 429 risk).
    agent::register_live_job(&mp3_path, handle);

    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    recorder
        .start_recording_with_aec(
            std::path::PathBuf::from(output_path),
            aec,
            mic_device,
            Some(chunk_tx),
        )
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    Ok("Desktop recording started".to_string())
}

#[tauri::command]
async fn stop_desktop_recording() -> Result<String, String> {
    let result = tokio::task::spawn_blocking(move || {
        let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
        recorder
            .stop_recording()
            .map_err(|e| format!("Failed to stop recording: {}", e))
    })
    .await;
    match result {
        Ok(Ok(())) => Ok("Recording stopped successfully".to_string()),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("Task join error: {}", e)),
    }
}

// ==================== Cross-window settings (in-memory) ====================

use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

// On by default: the mic must not re-record speaker playback. WebRTC AEC degrades
// to near-passthrough when there is no echo, so default-on is safe.
static AEC_ENABLED: AtomicBool = AtomicBool::new(true);

#[tauri::command]
async fn get_aec_enabled() -> Result<bool, String> {
    Ok(AEC_ENABLED.load(AtomicOrdering::Relaxed))
}

#[tauri::command]
async fn set_aec_enabled(enabled: bool) -> Result<(), String> {
    AEC_ENABLED.store(enabled, AtomicOrdering::Relaxed);
    eprintln!("[settings] AEC enabled = {}", enabled);
    Ok(())
}

#[tauri::command]
async fn notify_recording_started(
    app: tauri::AppHandle,
    note_title: String,
    audio_path: Option<String>,
    language: Option<String>,
    timestamp: Option<i64>,
    recorded_at: Option<String>,
    timezone: Option<String>,
) -> Result<(), String> {
    // audio_path lets the main window start processing immediately off this
    // event; without it the listener can only show the loading card and the
    // actual work waits for the 500ms localStorage poll.
    app.emit(
        "recording-started",
        serde_json::json!({
            "noteTitle": note_title,
            "audioPath": audio_path,
            "language": language,
            "timestamp": timestamp,
            "recordedAt": recorded_at,
            "timezone": timezone,
        }),
    )
    .map_err(|e| format!("Failed to emit recording-started event: {}", e))?;
    Ok(())
}

// ==================== Device enumeration ====================

#[tauri::command]
async fn list_audio_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    recorder.list_input_devices()
}

#[tauri::command]
async fn get_audio_device_status() -> Result<DeviceStatus, String> {
    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    recorder.check_device_status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            match config::load_environment(app)? {
                Some(path) => println!("Loaded environment from {}", path.display()),
                None => println!("WARNING: no environment file found"),
            }
            // If DB is unreachable, commands return clear errors rather than failing setup.
            let db = tauri::async_runtime::block_on(database::init_database());
            app.handle().manage(db);
            Ok(())
        })
        .on_window_event(|window, event| {
            // The recording popup is alwaysOnTop + skipTaskbar + undecorated: if the
            // main window goes away while it's still alive, it becomes an unclosable
            // floating pill and keeps the whole app running. Tear it down with main,
            // finalizing any in-flight recording first so the MP3 isn't corrupt.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Ok(recorder) = RECORDER.lock() {
                        let _ = recorder.stop_recording();
                    }
                    if let Some(popup) = window.app_handle().get_webview_window("recording-popup") {
                        let _ = popup.destroy();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            auth::register,
            auth::login,
            auth::forgot_password,
            auth::reset_password,
            auth::get_current_user,
            notes::get_notes,
            notes::get_note,
            notes::create_note,
            notes::create_recording_note,
            notes::update_note,
            notes::delete_note,
            notes::toggle_favorite,
            tasks::get_tasks,
            tasks::create_task,
            tasks::update_task,
            tasks::delete_task,
            tasks::toggle_task_completion,
            tasks::update_task_positions,
            tasks::clear_column_tasks,
            mcp_auth::get_mcp_connections,
            mcp_auth::get_mcp_connection,
            mcp_auth::create_mcp_connection,
            mcp_auth::update_mcp_connection,
            mcp_auth::delete_mcp_connection,
            mcp_auth::test_mcp_connection,
            agent::transcribe_audio,
            agent::ensure_recordings_dir,
            agent::ai_chat,
            agent::ai_chat_detailed,
            agent::get_ai_model_limits,
            agent::ai_chat_stream,
            agent::agent_insert_document,
            agent::agent_check_collection,
            agent::agent_create_collection,
            agent::agent_ensure_collection,
            audio_import::import_audio_file,
            agent::describe_image,
            note_assets::import_note_asset,
            note_assets::capture_screenshot,
            note_assets::record_screenshot_asset,
            note_assets::take_recording_assets,
            processing_jobs::save_processing_manifest,
            processing_jobs::load_processing_manifest,
            processing_jobs::list_processing_manifests,
            processing_jobs::claim_processing_job,
            processing_jobs::release_processing_job,
            start_desktop_recording,
            stop_desktop_recording,
            get_aec_enabled,
            set_aec_enabled,
            notify_recording_started,
            list_audio_input_devices,
            get_audio_device_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
