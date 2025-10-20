// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use tauri::Manager;
use std::sync::{Arc, Mutex};

mod auth;
mod database;
mod models;
mod notes;
mod tasks;
mod mcp_auth;

#[cfg(windows)]
mod windows_audio;

#[cfg(windows)]
use windows_audio::DesktopAudioRecorder;

// Global recorder instance for Windows
#[cfg(windows)]
lazy_static::lazy_static! {
    static ref RECORDER: Arc<Mutex<DesktopAudioRecorder>> = Arc::new(Mutex::new(DesktopAudioRecorder::new()));
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg(windows)]
#[tauri::command]
async fn start_desktop_recording(output_path: String) -> Result<String, String> {
    println!("📝 Received desktop recording request");
    println!("📁 Output path: {}", output_path);
    
    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    recorder.start_recording(std::path::PathBuf::from(output_path))
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    
    Ok("Desktop recording started".to_string())
}

#[cfg(not(windows))]
#[tauri::command]
async fn start_desktop_recording(_output_path: String) -> Result<String, String> {
    Err("Recording only supported on Windows".to_string())
}

#[cfg(windows)]
#[tauri::command]
async fn stop_desktop_recording() -> Result<String, String> {
    println!("⏹️ Received stop desktop recording request");
    
    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    recorder.stop_recording()
        .map_err(|e| format!("Failed to stop recording: {}", e))?;
    
    Ok("Recording stopped successfully".to_string())
}

#[cfg(not(windows))]
#[tauri::command]
async fn stop_desktop_recording() -> Result<String, String> {
    Err("Recording only supported on Windows".to_string())
}

#[cfg(windows)]
#[tauri::command]
async fn is_recording() -> Result<bool, String> {
    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    Ok(recorder.is_recording())
}

#[cfg(not(windows))]
#[tauri::command]
async fn is_recording() -> Result<bool, String> {
    Ok(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_mic_recorder::init())
        .setup(|app| {
            // Initialize database synchronously in a blocking context
            tauri::async_runtime::block_on(async {
                match database::init_database().await {
                    Ok(db) => {
                        app.handle().manage(db);
                        Ok(())
                    }
                    Err(e) => {
                        eprintln!("Failed to initialize database: {}", e);
                        Err(Box::new(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!("Database initialization failed: {}", e),
                        )) as Box<dyn std::error::Error>)
                    }
                }
            })
        })
        .invoke_handler(tauri::generate_handler![
            greet,
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
            start_desktop_recording,
            stop_desktop_recording,
            is_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
