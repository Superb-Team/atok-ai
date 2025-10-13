// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use tauri::Manager;

mod auth;
mod database;
mod models;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
