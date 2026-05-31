// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use tauri::{Manager, Emitter};
use std::sync::{Arc, Mutex};

mod auth;
mod database;
mod models;
mod notes;
mod tasks;
mod mcp_auth;
mod agent;

// Platform-specific audio recording
// Windows: mic + desktop audio via WASAPI
// Linux/macOS: mic input via cpal (ALSA/PulseAudio/PipeWire/CoreAudio)
#[cfg(windows)]
mod windows_audio;

#[cfg(not(windows))]
mod audio_recorder;

#[cfg(windows)]
use windows_audio::DesktopAudioRecorder;

#[cfg(not(windows))]
use audio_recorder::DesktopAudioRecorder;

// Global recorder instance
lazy_static::lazy_static! {
    static ref RECORDER: Arc<Mutex<DesktopAudioRecorder>> = Arc::new(Mutex::new(DesktopAudioRecorder::new()));
}

#[tauri::command]
async fn start_desktop_recording(output_path: String) -> Result<String, String> {
    println!("Received desktop recording request");
    println!("Output path: {}", output_path);

    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    recorder.start_recording(std::path::PathBuf::from(output_path))
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    Ok("Desktop recording started".to_string())
}

#[tauri::command]
async fn stop_desktop_recording() -> Result<String, String> {
    println!("Received stop desktop recording request");

    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    recorder.stop_recording()
        .map_err(|e| format!("Failed to stop recording: {}", e))?;

    Ok("Recording stopped successfully".to_string())
}

#[tauri::command]
async fn is_recording() -> Result<bool, String> {
    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    Ok(recorder.is_recording())
}

#[tauri::command]
async fn read_audio_file(path: String) -> Result<String, String> {
    use std::fs;
    use base64::{Engine as _, engine::general_purpose};

    println!("Reading audio file: {}", path);

    let bytes = fs::read(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    println!("File read: {} bytes", bytes.len());

    let base64_data = general_purpose::STANDARD.encode(&bytes);
    Ok(base64_data)
}

#[tauri::command]
async fn write_temp_audio(path: String, data: String) -> Result<(), String> {
    use base64::{Engine as _, engine::general_purpose};

    let bytes = general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }

    std::fs::write(&path, &bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    println!("Temp audio written: {} bytes to {}", bytes.len(), path);
    Ok(())
}

#[tauri::command]
async fn notify_recording_started(app: tauri::AppHandle, note_title: String) -> Result<(), String> {
    println!("Emitting recording-started event to all windows: {}", note_title);

    app.emit("recording-started", serde_json::json!({
        "noteTitle": note_title
    })).map_err(|e| format!("Failed to emit event: {}", e))?;

    println!("Event emitted successfully");
    Ok(())
}

#[tauri::command]
async fn notify_note_created(app: tauri::AppHandle, note_title: String) -> Result<(), String> {
    println!("Emitting note-created event to all windows: {}", note_title);

    app.emit("note-created", serde_json::json!({
        "noteTitle": note_title
    })).map_err(|e| format!("Failed to emit event: {}", e))?;

    println!("Event emitted successfully");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Muat env variables dari file .env, cari dari CWD dan parent directories
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut path = cwd.clone();
    loop {
        let env_path = path.join(".env");
        if env_path.exists() {
            let _ = dotenvy::from_filename(env_path);
            break;
        }
        if !path.pop() {
            println!("WARNING: .env file not found, using system environment only");
            break;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_mic_recorder::init())
        .setup(|app| {
            // Initialize database asynchronously — never fails setup
            // If DB is unreachable, commands will return clear error messages
            let db = tauri::async_runtime::block_on(database::init_database());
            app.handle().manage(db);
            Ok(())
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
            agent::ai_chat_stream,
            agent::agent_insert_document,
            agent::agent_check_collection,
            agent::agent_create_collection,
            agent::agent_ensure_collection,
            start_desktop_recording,
            stop_desktop_recording,
            is_recording,
            read_audio_file,
            write_temp_audio,
            notify_recording_started,
            notify_note_created,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ==================== Tests ====================

#[cfg(test)]
mod tests {
    use super::*;

    // ─── read_audio_file path validation ──────────────────

    #[tokio::test]
    async fn test_read_audio_file_nonexistent_path_returns_error() {
        let result = read_audio_file("/nonexistent/path/audio.mp3".to_string()).await;
        assert!(result.is_err(), "should error on nonexistent file");
        let err = result.unwrap_err();
        assert!(err.contains("Failed to read file"), "error message should mention file read failure");
    }

    #[tokio::test]
    async fn test_read_audio_file_empty_path() {
        let result = read_audio_file("".to_string()).await;
        assert!(result.is_err(), "should error on empty path");
    }
}
