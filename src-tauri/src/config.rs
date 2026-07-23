use std::io;
use std::path::PathBuf;

use tauri::Manager;

pub fn load_environment(app: &tauri::App) -> Result<Option<PathBuf>, io::Error> {
    let mut candidates = Vec::new();

    if let Some(path) = std::env::var_os("ATOK_ENV_FILE").map(PathBuf::from) {
        candidates.push(path);
    }

    let project_paths = project_env_paths();
    let app_config_path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join(".env"));

    if cfg!(debug_assertions) {
        candidates.extend(project_paths);
        candidates.extend(app_config_path);
    } else {
        candidates.extend(app_config_path);
        candidates.extend(project_paths);
    }

    for path in candidates {
        if !path.is_file() {
            continue;
        }
        dotenvy::from_path(&path).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Load environment '{}': {error}", path.display()),
            )
        })?;
        return Ok(Some(path));
    }

    Ok(None)
}

fn project_env_paths() -> Vec<PathBuf> {
    let Ok(mut directory) = std::env::current_dir() else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    loop {
        paths.push(directory.join(".env"));
        if !directory.pop() {
            return paths;
        }
    }
}
