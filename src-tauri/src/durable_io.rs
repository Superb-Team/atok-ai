use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

lazy_static::lazy_static! {
    static ref DURABLE_WRITE_LOCK: Mutex<()> = Mutex::new(());
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("artifact");
    path.parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".{name}.{suffix}"))
}

pub fn backup_path(path: &Path) -> PathBuf {
    sibling(path, "backup")
}

pub fn recover_backup(path: &Path) -> Result<(), std::io::Error> {
    let backup = backup_path(path);
    if !path.exists() && backup.is_file() {
        std::fs::rename(backup, path)?;
    }
    Ok(())
}

pub fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let _guard = DURABLE_WRITE_LOCK
        .lock()
        .map_err(|_| std::io::Error::other("durable write lock poisoned"))?;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("artifact path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    recover_backup(path)?;

    let temporary = sibling(path, &format!("{}.tmp", uuid::Uuid::new_v4()));
    let backup = backup_path(path);
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);

        if backup.exists() {
            std::fs::remove_file(&backup)?;
        }
        let had_previous = path.exists();
        if had_previous {
            std::fs::rename(path, &backup)?;
        }
        if let Err(error) = std::fs::rename(&temporary, path) {
            if had_previous {
                let _ = std::fs::rename(&backup, path);
            }
            return Err(error);
        }
        if had_previous {
            let _ = std::fs::remove_file(backup);
        }
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_existing_artifact_and_recovers_backup() {
        let root = std::env::temp_dir().join(format!("atok-durable-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("artifact.json");
        atomic_replace(&path, b"one").unwrap();
        atomic_replace(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");

        let backup = sibling(&path, "backup");
        std::fs::rename(&path, &backup).unwrap();
        recover_backup(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        std::fs::remove_dir_all(root).unwrap();
    }
}
