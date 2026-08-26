use fs2::FileExt;
use serde_json::Value;
use std::path::{Path, PathBuf};

static MANIFEST_IO_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

lazy_static::lazy_static! {
    static ref ACTIVE_JOB_CLAIMS: std::sync::Mutex<
        std::collections::HashMap<PathBuf, ActiveJobClaim>,
    > = std::sync::Mutex::new(std::collections::HashMap::new());
}

struct ActiveJobClaim {
    run_id: String,
    _lock_file: std::fs::File,
}

fn canonical_audio_key(audio_path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(audio_path).map_err(|error| {
        format!(
            "Resolve recording path '{}': {}",
            audio_path.display(),
            error
        )
    })
}

fn claim(audio_path: &Path, run_id: &str) -> Result<bool, String> {
    if run_id.trim().is_empty() {
        return Err("Processing runId cannot be empty".to_string());
    }
    let key = canonical_audio_key(audio_path)?;
    let mut claims = ACTIVE_JOB_CLAIMS
        .lock()
        .map_err(|error| format!("Lock active processing jobs: {}", error))?;
    if claims.contains_key(&key) {
        return Ok(false);
    }
    let lock_path = processing_lock_path(&key);
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| {
            format!(
                "Open processing ownership lock '{}': {}",
                lock_path.display(),
                error
            )
        })?;
    match lock_file.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Acquire processing ownership lock '{}': {}",
                lock_path.display(),
                error
            ));
        }
    }
    claims.insert(
        key,
        ActiveJobClaim {
            run_id: run_id.to_string(),
            _lock_file: lock_file,
        },
    );
    Ok(true)
}

fn release_claim(audio_path: &Path, run_id: &str) -> Result<bool, String> {
    let key = canonical_audio_key(audio_path)?;
    let mut claims = ACTIVE_JOB_CLAIMS
        .lock()
        .map_err(|error| format!("Lock active processing jobs: {}", error))?;
    if claims.get(&key).map(|claim| claim.run_id.as_str()) != Some(run_id) {
        return Ok(false);
    }
    claims.remove(&key);
    Ok(true)
}

fn processing_lock_path(audio_path: &Path) -> PathBuf {
    let file_name = audio_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recording.mp3");
    audio_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".{file_name}.processing.lock"))
}

fn has_active_claim(audio_path: &Path) -> Result<bool, String> {
    let key = canonical_audio_key(audio_path)?;
    let claims = ACTIVE_JOB_CLAIMS
        .lock()
        .map_err(|error| format!("Lock active processing jobs: {}", error))?;
    Ok(claims.contains_key(&key))
}

#[cfg(test)]
fn clear_claim_for_test(audio_path: &Path) {
    if let Ok(key) = canonical_audio_key(audio_path) {
        if let Ok(mut claims) = ACTIVE_JOB_CLAIMS.lock() {
            claims.remove(&key);
        }
    }
}

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
    if manifest["schemaVersion"].as_u64() != Some(1) {
        return Err("Unsupported processing manifest schemaVersion".to_string());
    }
    for field in ["jobId", "audioPath", "status"] {
        if manifest
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(format!(
                "Processing manifest requires non-empty '{}'",
                field
            ));
        }
    }
    if let Some(generation) = manifest.get("generation") {
        if !generation.is_u64() {
            return Err(
                "Processing manifest generation must be a non-negative integer".to_string(),
            );
        }
    }
    Ok(())
}

fn save_atomic(path: &Path, manifest: &Value) -> Result<(), String> {
    validate_manifest(manifest)?;
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Serialize processing manifest: {}", error))?;
    crate::durable_io::atomic_replace(path, &bytes)
        .map_err(|error| format!("Commit processing manifest: {}", error))
}

#[cfg(test)]
fn save_serialized(path: &Path, manifest: &Value) -> Result<(), String> {
    let _guard = MANIFEST_IO_LOCK
        .lock()
        .map_err(|error| format!("Lock processing manifest: {}", error))?;
    save_atomic(path, manifest)
}

fn save_serialized_with_generation(path: &Path, manifest: &Value) -> Result<Value, String> {
    let _guard = MANIFEST_IO_LOCK
        .lock()
        .map_err(|error| format!("Lock processing manifest: {}", error))?;
    let expected = manifest
        .get("generation")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let current = load(path)?;
    let actual = current
        .as_ref()
        .and_then(|value| value.get("generation"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if current.is_some() && expected != actual {
        return Err(format!(
            "Processing manifest generation conflict: expected {}, actual {}",
            expected, actual
        ));
    }
    if current.is_none() && expected != 0 {
        return Err(format!(
            "Processing manifest generation conflict: expected initial generation 0, got {}",
            expected
        ));
    }
    let mut next = manifest.clone();
    next["generation"] = serde_json::json!(actual.saturating_add(u64::from(current.is_some())));
    save_atomic(path, &next)?;
    Ok(next)
}

fn load(path: &Path) -> Result<Option<Value>, String> {
    let backup = crate::durable_io::backup_path(path);
    let legacy_backup = path.with_extension("json.backup");
    if !path.is_file() {
        if backup.is_file() {
            crate::durable_io::recover_backup(path)
                .map_err(|error| format!("Recover processing manifest backup: {}", error))?;
        } else if legacy_backup.is_file() {
            std::fs::rename(&legacy_backup, path)
                .map_err(|error| format!("Recover legacy processing manifest backup: {}", error))?;
        }
    }
    if !path.is_file() {
        return Ok(None);
    }
    match read_validated(path) {
        Ok(manifest) => Ok(Some(manifest)),
        Err(primary_error) if backup.is_file() => {
            let corrupt = path.with_extension(format!("corrupt-{}", uuid::Uuid::new_v4()));
            std::fs::rename(path, &corrupt)
                .map_err(|error| format!("Quarantine corrupt processing manifest: {}", error))?;
            if let Err(error) = crate::durable_io::recover_backup(path) {
                let _ = std::fs::rename(&corrupt, path);
                return Err(format!(
                    "Recover processing manifest backup after '{}': {}",
                    primary_error, error
                ));
            }
            match read_validated(path) {
                Ok(manifest) => Ok(Some(manifest)),
                Err(backup_error) => Err(format!(
                    "Processing manifest invalid ('{}'); backup invalid ('{}')",
                    primary_error, backup_error
                )),
            }
        }
        Err(error) => Err(error),
    }
}

fn read_validated(path: &Path) -> Result<Value, String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("Read processing manifest: {}", error))?;
    let manifest: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Parse processing manifest: {}", error))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn load_serialized(path: &Path) -> Result<Option<Value>, String> {
    let _guard = MANIFEST_IO_LOCK
        .lock()
        .map_err(|error| format!("Lock processing manifest: {}", error))?;
    load(path)
}

#[tauri::command]
pub async fn save_processing_manifest(
    audio_path: String,
    manifest: Value,
) -> Result<Value, String> {
    if manifest.get("audioPath").and_then(Value::as_str) != Some(audio_path.as_str()) {
        return Err("Processing manifest audioPath does not match command audioPath".to_string());
    }
    if !has_active_claim(Path::new(&audio_path))? {
        return Err("Processing manifest write requires an active ownership claim".to_string());
    }
    let path = manifest_path(Path::new(&audio_path));
    tokio::task::spawn_blocking(move || save_serialized_with_generation(&path, &manifest))
        .await
        .map_err(|error| format!("Manifest task failed: {}", error))?
}

#[tauri::command]
pub async fn claim_processing_job(audio_path: String, run_id: String) -> Result<bool, String> {
    claim(Path::new(&audio_path), &run_id)
}

#[tauri::command]
pub async fn release_processing_job(audio_path: String, run_id: String) -> Result<bool, String> {
    release_claim(Path::new(&audio_path), &run_id)
}

#[tauri::command]
pub async fn load_processing_manifest(audio_path: String) -> Result<Option<Value>, String> {
    let path = manifest_path(Path::new(&audio_path));
    tokio::task::spawn_blocking(move || load_serialized(&path))
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
                match load_serialized(&path) {
                    Ok(Some(manifest)) => manifests.push(manifest),
                    Ok(None) => {}
                    Err(error) => eprintln!(
                        "[processing] Skipping invalid manifest '{}': {}",
                        path.display(),
                        error
                    ),
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
    fn generation_cas_rejects_a_stale_manifest_writer() {
        let dir = temp_dir("generation");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        let path = manifest_path(&audio);
        let initial = manifest(&audio, "extracting");
        let saved = save_serialized_with_generation(&path, &initial).unwrap();
        assert_eq!(saved["generation"], 0);

        let mut next = initial.clone();
        next["generation"] = serde_json::json!(0);
        next["status"] = serde_json::json!("synthesizing");
        let saved = save_serialized_with_generation(&path, &next).unwrap();
        assert_eq!(saved["generation"], 1);

        let mut stale = initial;
        stale["generation"] = serde_json::json!(0);
        stale["status"] = serde_json::json!("failed");
        assert!(save_serialized_with_generation(&path, &stale)
            .unwrap_err()
            .contains("generation conflict"));

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

    #[test]
    fn load_quarantines_corrupt_manifest_when_backup_is_valid() {
        let dir = temp_dir("corrupt-recover");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        let path = manifest_path(&audio);
        let expected = manifest(&audio, "extracting");
        save_atomic(&path, &expected).unwrap();
        std::fs::copy(&path, crate::durable_io::backup_path(&path)).unwrap();
        std::fs::write(&path, b"{not-json").unwrap();

        assert_eq!(load(&path).unwrap(), Some(expected));
        assert!(std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn concurrent_manifest_saves_are_serialized_and_leave_valid_json() {
        let dir = temp_dir("concurrent");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        let path = manifest_path(&audio);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(32));

        let writers: Vec<_> = (0..32)
            .map(|index| {
                let audio = audio.clone();
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut value = manifest(&audio, "extracting");
                    value["generation"] = serde_json::json!(index);
                    barrier.wait();
                    save_serialized(&path, &value)
                })
            })
            .collect();

        for writer in writers {
            writer.join().unwrap().unwrap();
        }

        let saved = load_serialized(&path).unwrap().unwrap();
        assert_eq!(saved["status"], "extracting");
        assert!(saved["generation"].as_i64().is_some());
        assert_eq!(
            std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
                .count(),
            0
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn concurrent_job_claims_have_exactly_one_owner() {
        let dir = temp_dir("claims");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        std::fs::write(&audio, b"audio").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(32));

        let claimers: Vec<_> = (0..32)
            .map(|index| {
                let audio = audio.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    claim(&audio, &format!("run-{index}"))
                })
            })
            .collect();

        let results: Vec<_> = claimers
            .into_iter()
            .map(|claimer| claimer.join().unwrap().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|claimed| **claimed).count(), 1);

        clear_claim_for_test(&audio);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_owner_can_release_a_processing_claim() {
        let dir = temp_dir("claim-release");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        std::fs::write(&audio, b"audio").unwrap();

        assert!(claim(&audio, "owner").unwrap());
        assert!(!release_claim(&audio, "not-owner").unwrap());
        assert!(!claim(&audio, "next").unwrap());
        assert!(release_claim(&audio, "owner").unwrap());
        assert!(claim(&audio, "next").unwrap());

        clear_claim_for_test(&audio);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn processing_claim_holds_an_os_lock_until_release() {
        let dir = temp_dir("os-lock");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("take.mp3");
        std::fs::write(&audio, b"audio").unwrap();

        assert!(claim(&audio, "owner").unwrap());
        let lock_path = processing_lock_path(&canonical_audio_key(&audio).unwrap());
        let second_handle = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock_path)
            .unwrap();
        assert!(second_handle.try_lock_exclusive().is_err());

        assert!(release_claim(&audio, "owner").unwrap());
        assert!(second_handle.try_lock_exclusive().is_ok());
        second_handle.unlock().unwrap();

        let _ = std::fs::remove_dir_all(dir);
    }
}
