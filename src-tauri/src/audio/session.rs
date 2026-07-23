use std::path::{Path, PathBuf};

pub struct RecordingSession {
    root: PathBuf,
}

impl RecordingSession {
    pub fn create(output_path: &Path) -> Result<Self, String> {
        let parent = output_path
            .parent()
            .ok_or_else(|| format!("Recording output has no parent: {}", output_path.display()))?;
        let root = parent
            .join(".sessions")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("Create recording session '{}': {}", root.display(), error))?;
        Ok(Self { root })
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn mark_done(&self, source: &str) -> Result<(), String> {
        let path = self.root.join(format!("{}_done.flag", source));
        std::fs::File::create(&path)
            .map(|_| ())
            .map_err(|error| format!("Create completion marker '{}': {}", path.display(), error))
    }

    pub fn cleanup(self) -> Result<(), String> {
        std::fs::remove_dir_all(&self.root).map_err(|error| {
            format!(
                "Remove recording session '{}': {}",
                self.root.display(),
                error
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_are_unique_and_live_beside_the_output() {
        let parent =
            std::env::temp_dir().join(format!("atok-session-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        let output = parent.join("recording.mp3");
        let first = RecordingSession::create(&output).unwrap();
        let second = RecordingSession::create(&output).unwrap();

        assert_ne!(first.path(), second.path());
        assert_eq!(
            first.path().parent(),
            Some(parent.join(".sessions").as_path())
        );
        assert!(first.path().is_dir());
        assert!(second.path().is_dir());

        first.cleanup().unwrap();
        second.cleanup().unwrap();
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn completion_markers_are_source_scoped() {
        let parent =
            std::env::temp_dir().join(format!("atok-session-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        let session = RecordingSession::create(&parent.join("recording.mp3")).unwrap();

        session.mark_done("sys").unwrap();
        assert!(session.path().join("sys_done.flag").is_file());
        assert!(!session.path().join("mic_done.flag").exists());

        session.cleanup().unwrap();
        std::fs::remove_dir_all(parent).unwrap();
    }
}
