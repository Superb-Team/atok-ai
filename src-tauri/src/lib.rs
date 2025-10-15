mod windows_audio;

use std::sync::{Arc, Mutex};
use windows_audio::DesktopAudioRecorder;

// Global recorder instance
lazy_static::lazy_static! {
    static ref RECORDER: Arc<Mutex<DesktopAudioRecorder>> = Arc::new(Mutex::new(DesktopAudioRecorder::new()));
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn start_desktop_recording(output_path: String) -> Result<String, String> {
    println!("📝 Received desktop recording request");
    println!("📁 Output path: {}", output_path);
    
    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    recorder.start_recording(std::path::PathBuf::from(output_path))
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    
    Ok("Desktop recording started".to_string())
}

#[tauri::command]
async fn stop_desktop_recording() -> Result<String, String> {
    println!("⏹️ Received stop desktop recording request");
    
    let recorder = RECORDER.lock().map_err(|e| e.to_string())?;
    recorder.stop_recording()
        .map_err(|e| format!("Failed to stop recording: {}", e))?;
    
    Ok("Recording stopped successfully".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_mic_recorder::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            start_desktop_recording,
            stop_desktop_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
