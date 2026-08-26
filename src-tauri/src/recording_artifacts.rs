use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MANIFEST_FILE: &str = "manifest.v2.json";

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RecordingId(String);

impl RecordingId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    pub fn parse(value: &str) -> Result<Self, ManifestStoreError> {
        let parsed = uuid::Uuid::parse_str(value)
            .map_err(|_| ManifestStoreError::InvalidRecordingId(value.to_string()))?;
        Ok(Self(parsed.hyphenated().to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecordingState {
    Created,
    Capturing,
    FinalizingCapture,
    Transcribing,
    TranscriptDraft,
    TranscriptReviewRequired,
    GeneratingNote,
    NoteReviewRequired,
    Ready,
    Degraded,
    Failed,
}

impl RecordingState {
    pub fn can_transition_to(self, next: Self) -> bool {
        use RecordingState::*;
        matches!(
            (self, next),
            (Created, Capturing)
                | (Capturing, FinalizingCapture)
                | (FinalizingCapture, Transcribing)
                | (
                    Transcribing,
                    TranscriptDraft | TranscriptReviewRequired | Degraded | Failed
                )
                | (TranscriptDraft, GeneratingNote | TranscriptReviewRequired)
                | (TranscriptReviewRequired, GeneratingNote | Failed)
                | (
                    GeneratingNote,
                    NoteReviewRequired | Ready | Degraded | Failed
                )
                | (NoteReviewRequired, Ready | GeneratingNote | Failed)
                | (Degraded, Transcribing | GeneratingNote | Failed)
        ) || self == next
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingManifestV2 {
    pub schema_version: u32,
    pub generation: u64,
    pub recording_id: RecordingId,
    pub state: RecordingState,
    pub language: String,
    pub timezone: String,
    pub created_at: String,
    pub updated_at: String,
}

impl RecordingManifestV2 {
    pub fn new(recording_id: RecordingId, language: &str, timezone: &str) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            schema_version: 2,
            generation: 0,
            recording_id,
            state: RecordingState::Created,
            language: language.to_string(),
            timezone: timezone.to_string(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn transition(&mut self, next: RecordingState) -> Result<(), ManifestStoreError> {
        if !self.state.can_transition_to(next) {
            return Err(ManifestStoreError::IllegalTransition {
                from: self.state,
                to: next,
            });
        }
        if self.state != next {
            self.state = next;
            self.generation = self.generation.saturating_add(1);
            self.updated_at = chrono::Utc::now().to_rfc3339();
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestStoreError {
    #[error("invalid recording id: {0}")]
    InvalidRecordingId(String),
    #[error("illegal recording transition from {from:?} to {to:?}")]
    IllegalTransition {
        from: RecordingState,
        to: RecordingState,
    },
    #[error("recording manifest already exists: {0}")]
    AlreadyExists(String),
    #[error("manifest generation conflict: expected {expected}, actual {actual}")]
    GenerationConflict { expected: u64, actual: u64 },
    #[error("invalid recording manifest: {0}")]
    InvalidManifest(String),
    #[error("recording artifact I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("recording manifest JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

pub struct RecordingManifestStore {
    root: PathBuf,
}

impl RecordingManifestStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn bundle_path(&self, recording_id: &RecordingId) -> PathBuf {
        self.root.join(recording_id.as_str())
    }

    fn manifest_path(&self, recording_id: &RecordingId) -> PathBuf {
        self.bundle_path(recording_id).join(MANIFEST_FILE)
    }

    pub fn create(&self, manifest: &RecordingManifestV2) -> Result<(), ManifestStoreError> {
        self.validate(manifest)?;
        let path = self.manifest_path(&manifest.recording_id);
        if path.exists() {
            return Err(ManifestStoreError::AlreadyExists(
                manifest.recording_id.as_str().to_string(),
            ));
        }
        self.commit(&path, manifest)
    }

    pub fn load(
        &self,
        recording_id: &RecordingId,
    ) -> Result<Option<RecordingManifestV2>, ManifestStoreError> {
        let path = self.manifest_path(recording_id);
        if !path.is_file() {
            return Ok(None);
        }
        let manifest: RecordingManifestV2 = serde_json::from_slice(&std::fs::read(path)?)?;
        self.validate(&manifest)?;
        if &manifest.recording_id != recording_id {
            return Err(ManifestStoreError::InvalidManifest(
                "recordingId does not match its managed directory".into(),
            ));
        }
        Ok(Some(manifest))
    }

    pub fn save_if_generation(
        &self,
        manifest: &RecordingManifestV2,
        expected_generation: u64,
    ) -> Result<(), ManifestStoreError> {
        self.validate(manifest)?;
        let current = self.load(&manifest.recording_id)?.ok_or_else(|| {
            ManifestStoreError::InvalidManifest("cannot update a missing manifest".into())
        })?;
        if current.generation != expected_generation {
            return Err(ManifestStoreError::GenerationConflict {
                expected: expected_generation,
                actual: current.generation,
            });
        }
        if manifest.generation != expected_generation.saturating_add(1) {
            return Err(ManifestStoreError::InvalidManifest(format!(
                "next generation must be {}, got {}",
                expected_generation.saturating_add(1),
                manifest.generation
            )));
        }
        self.commit(&self.manifest_path(&manifest.recording_id), manifest)
    }

    fn validate(&self, manifest: &RecordingManifestV2) -> Result<(), ManifestStoreError> {
        RecordingId::parse(manifest.recording_id.as_str())?;
        if manifest.schema_version != 2 {
            return Err(ManifestStoreError::InvalidManifest(format!(
                "unsupported schema version {}",
                manifest.schema_version
            )));
        }
        if manifest.language.trim().is_empty() || manifest.timezone.trim().is_empty() {
            return Err(ManifestStoreError::InvalidManifest(
                "language and timezone are required".into(),
            ));
        }
        Ok(())
    }

    fn commit(
        &self,
        path: &Path,
        manifest: &RecordingManifestV2,
    ) -> Result<(), ManifestStoreError> {
        let parent = path.parent().ok_or_else(|| {
            ManifestStoreError::InvalidManifest("manifest path has no parent".into())
        })?;
        std::fs::create_dir_all(parent)?;
        crate::durable_io::atomic_replace(path, &serde_json::to_vec_pretty(manifest)?)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecordingLocation {
    ManagedV2 {
        recording_id: RecordingId,
        root: PathBuf,
    },
    LegacyFlat {
        audio_path: PathBuf,
    },
}

pub fn resolve_recording_location(
    managed_root: &Path,
    audio_path: &Path,
) -> Result<RecordingLocation, ManifestStoreError> {
    let canonical_audio = std::fs::canonicalize(audio_path)?;
    let canonical_root = std::fs::canonicalize(managed_root).ok();
    if canonical_root
        .as_ref()
        .is_some_and(|root| canonical_audio.starts_with(root))
    {
        if let Some(bundle) = canonical_audio.parent() {
            let manifest_path = bundle.join(MANIFEST_FILE);
            if manifest_path.is_file() {
                let manifest: RecordingManifestV2 =
                    serde_json::from_slice(&std::fs::read(manifest_path)?)?;
                return Ok(RecordingLocation::ManagedV2 {
                    recording_id: manifest.recording_id,
                    root: bundle.to_path_buf(),
                });
            }
        }
    }
    Ok(RecordingLocation::LegacyFlat {
        audio_path: canonical_audio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_ids_are_generated_and_round_trip() {
        let id = RecordingId::new();
        assert_eq!(RecordingId::parse(id.as_str()).unwrap(), id);
        assert!(RecordingId::parse("../../recording").is_err());
    }

    #[test]
    fn state_machine_rejects_skipping_capture_finalization() {
        assert!(RecordingState::Capturing.can_transition_to(RecordingState::FinalizingCapture));
        assert!(!RecordingState::Capturing.can_transition_to(RecordingState::Ready));
        assert!(RecordingState::TranscriptReviewRequired
            .can_transition_to(RecordingState::GeneratingNote));
    }

    #[test]
    fn stale_manifest_generation_cannot_replace_newer_state() {
        let root = std::env::temp_dir().join(format!(
            "atok-recording-v2-generation-{}",
            uuid::Uuid::new_v4()
        ));
        let store = RecordingManifestStore::new(root.clone());
        let mut manifest = RecordingManifestV2::new(RecordingId::new(), "id", "Asia/Jakarta");
        store.create(&manifest).unwrap();

        manifest.transition(RecordingState::Capturing).unwrap();
        store.save_if_generation(&manifest, 0).unwrap();

        let mut stale = manifest.clone();
        stale.generation = 1;
        stale.state = RecordingState::Failed;
        assert!(matches!(
            store.save_if_generation(&stale, 0),
            Err(ManifestStoreError::GenerationConflict { .. })
        ));

        assert_eq!(
            store.load(&manifest.recording_id).unwrap().unwrap().state,
            RecordingState::Capturing
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_paths_remain_resolvable_without_becoming_identity() {
        let root =
            std::env::temp_dir().join(format!("atok-recording-v2-legacy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let audio = root.join("meeting.mp3");
        std::fs::write(&audio, b"audio").unwrap();

        let resolved = resolve_recording_location(&root.join("managed"), &audio).unwrap();
        assert!(matches!(resolved, RecordingLocation::LegacyFlat { .. }));

        std::fs::remove_dir_all(root).unwrap();
    }
}
