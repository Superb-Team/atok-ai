use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

fn manifest_path(audio_path: &Path) -> PathBuf {
    let stem = audio_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    audio_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{}.processing.json", stem))
}

fn validate_manifest(manifest: &Value) -> Result<(), String> {
    if !manifest.is_object() {
        return Err("Processing manifest must be a JSON object".to_string());
    }
    for field in ["schemaVersion", "jobId", "audioPath", "status"] {
        if manifest.get(field).is_none() {
            return Err(format!("Processing manifest is missing '{}'", field));
        }
    }
    Ok(())
}

fn save_atomic(path: &Path, manifest: &Value) -> Result<(), String> {
    validate_manifest(manifest)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Create manifest directory: {}", error))?;
    }
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Serialize processing manifest: {}", error))?;
    let mut file = std::fs::File::create(&temp)
        .map_err(|error| format!("Create processing manifest temp file: {}", error))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Write processing manifest temp file: {}", error))?;
    file.sync_all()
        .map_err(|error| format!("Sync processing manifest temp file: {}", error))?;

    // Windows cannot rename over an existing file. Move the prior committed
    // value aside first, then restore it if committing the new value fails.
    let backup = path.with_extension("json.backup");
    if backup.exists() {
        std::fs::remove_file(&backup)
            .map_err(|error| format!("Remove stale processing manifest backup: {}", error))?;
    }
    let had_previous = path.exists();
    if had_previous {
        std::fs::rename(path, &backup)
            .map_err(|error| format!("Back up processing manifest: {}", error))?;
    }
    if let Err(error) = std::fs::rename(&temp, path) {
        if had_previous {
            let _ = std::fs::rename(&backup, path);
        }
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Commit processing manifest: {}", error));
    }
    if had_previous {
        std::fs::remove_file(&backup)
            .map_err(|error| format!("Remove processing manifest backup: {}", error))?;
    }
    Ok(())
}

fn load(path: &Path) -> Result<Option<Value>, String> {
    let backup = path.with_extension("json.backup");
    if !path.is_file() && backup.is_file() {
        std::fs::rename(&backup, path)
            .map_err(|error| format!("Recover processing manifest backup: {}", error))?;
    }
    if !path.is_file() {
        return Ok(None);
    }
    let bytes =
        std::fs::read(path).map_err(|error| format!("Read processing manifest: {}", error))?;
    let manifest: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Parse processing manifest: {}", error))?;
    validate_manifest(&manifest)?;
    Ok(Some(manifest))
}

#[tauri::command]
pub async fn save_processing_manifest(audio_path: String, manifest: Value) -> Result<(), String> {
    if manifest.get("audioPath").and_then(Value::as_str) != Some(audio_path.as_str()) {
        return Err("Processing manifest audioPath does not match command audioPath".to_string());
    }
    let path = manifest_path(Path::new(&audio_path));
    tokio::task::spawn_blocking(move || save_atomic(&path, &manifest))
        .await
        .map_err(|error| format!("Manifest task failed: {}", error))?
}

#[tauri::command]
pub async fn load_processing_manifest(audio_path: String) -> Result<Option<Value>, String> {
    let path = manifest_path(Path::new(&audio_path));
    tokio::task::spawn_blocking(move || load(&path))
        .await
        .map_err(|error| format!("Manifest task failed: {}", error))?
}

#[tauri::command]
pub async fn list_processing_manifests(directory: String) -> Result<Vec<Value>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = PathBuf::from(directory);
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut manifests = Vec::new();
        let entries = std::fs::read_dir(&dir)
            .map_err(|error| format!("Read processing manifest directory: {}", error))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let is_manifest = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.ends_with(".processing.json"))
                .unwrap_or(false);
            if is_manifest {
                if let Ok(Some(manifest)) = load(&path) {
                    manifests.push(manifest);
                }
            }
        }
        manifests.sort_by(|a, b| {
            a["updatedAt"]
                .as_str()
                .unwrap_or_default()
                .cmp(b["updatedAt"].as_str().unwrap_or_default())
        });
        Ok(manifests)
    })
    .await
    .map_err(|error| format!("Manifest task failed: {}", error))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("atok-processing-{}-{}", tag, uuid::Uuid::new_v4()))
    }

    fn manifest(audio_path: &Path, status: &str) -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "jobId": "job-1",
            "audioPath": audio_path,
            "status": status,
            "updatedAt": "2026-07-15T00:00:00Z"
        })
    }

    #[test]
    fn atomic_manifest_roundtrip() {
        let dir = temp_dir("roundtrip");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        let path = manifest_path(&audio);
        let expected = manifest(&audio, "extracting");

        save_atomic(&path, &expected).unwrap();
        assert_eq!(load(&path).unwrap(), Some(expected));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_manifest_never_replaces_valid_file() {
        let dir = temp_dir("invalid");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        let path = manifest_path(&audio);
        let expected = manifest(&audio, "extracting");
        save_atomic(&path, &expected).unwrap();

        assert!(save_atomic(&path, &serde_json::json!({"bad": true})).is_err());
        assert_eq!(load(&path).unwrap(), Some(expected));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn existing_manifest_is_replaced_without_leaving_a_backup() {
        let dir = temp_dir("replace");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        let path = manifest_path(&audio);
        save_atomic(&path, &manifest(&audio, "extracting")).unwrap();
        let expected = manifest(&audio, "complete");

        save_atomic(&path, &expected).unwrap();

        assert_eq!(load(&path).unwrap(), Some(expected));
        assert!(!path.with_extension("json.backup").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn load_recovers_interrupted_backup_swap() {
        let dir = temp_dir("recover");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        let path = manifest_path(&audio);
        let expected = manifest(&audio, "extracting");
        save_atomic(&path, &expected).unwrap();
        std::fs::rename(&path, path.with_extension("json.backup")).unwrap();

        assert_eq!(load(&path).unwrap(), Some(expected));
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
