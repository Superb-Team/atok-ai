use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const QUALITY_SCHEMA_VERSION: u32 = 4;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArtifact {
    pub kind: String,
    pub chunk_index: u32,
    pub relative_path: String,
    pub sha256: String,
    pub bytes: u64,
    pub sample_rate: u32,
    pub channels: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityWindow {
    pub chunk_index: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub mic_clipped_ratio: f32,
    #[serde(default = "silence_dbfs")]
    pub mic_rms_dbfs: f32,
    #[serde(default = "silence_dbfs")]
    pub system_rms_dbfs: f32,
    #[serde(default = "silence_dbfs")]
    pub mixed_rms_dbfs: f32,
    #[serde(default)]
    pub mixed_clipped_ratio: f32,
    pub mic_bytes: u64,
    pub system_bytes: u64,
}

fn silence_dbfs() -> f32 {
    -120.0
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioQualityReport {
    pub schema_version: u32,
    pub created_at: String,
    pub sample_rate: u32,
    pub output_channels: u32,
    pub mic_sample_rate: u32,
    pub mic_channels: u32,
    pub windows: Vec<QualityWindow>,
    pub source_artifacts: Vec<SourceArtifact>,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub mic_dropped_bytes: u64,
    pub requires_review: bool,
}

impl AudioQualityReport {
    pub fn new(
        sample_rate: u32,
        output_channels: u32,
        mic_sample_rate: u32,
        mic_channels: u32,
    ) -> Self {
        Self {
            schema_version: QUALITY_SCHEMA_VERSION,
            created_at: chrono::Utc::now().to_rfc3339(),
            sample_rate,
            output_channels,
            mic_sample_rate,
            mic_channels,
            windows: Vec::new(),
            source_artifacts: Vec::new(),
            warnings: Vec::new(),
            mic_dropped_bytes: 0,
            requires_review: false,
        }
    }

    pub fn record_mic_overrun(&mut self, dropped_bytes: u64) {
        if dropped_bytes == 0 {
            return;
        }
        self.mic_dropped_bytes = self.mic_dropped_bytes.saturating_add(dropped_bytes);
        self.requires_review = true;
        self.warnings.push(format!(
            "mic_overrun: {} input bytes were dropped before durable capture",
            dropped_bytes
        ));
    }

    pub fn add_window(&mut self, window: QualityWindow) {
        if window.mic_clipped_ratio > 0.01 {
            self.requires_review = true;
            self.warnings.push(format!(
                "mic_clipping: chunk {} has {:.2}% near-full-scale samples",
                window.chunk_index,
                window.mic_clipped_ratio * 100.0
            ));
        } else if window.mic_clipped_ratio > 0.005 {
            self.warnings.push(format!(
                "mic_clipping_advisory: chunk {} has {:.2}% near-full-scale samples",
                window.chunk_index,
                window.mic_clipped_ratio * 100.0
            ));
        }
        if window.mic_bytes == 0 {
            self.requires_review = true;
            self.warnings.push(format!(
                "mic_missing: chunk {} has no microphone samples",
                window.chunk_index
            ));
        }
        if window.mixed_clipped_ratio > 0.005 {
            self.requires_review = true;
            self.warnings.push(format!(
                "mixed_clipping: chunk {} has {:.2}% near-full-scale output samples",
                window.chunk_index,
                window.mixed_clipped_ratio * 100.0
            ));
        }
        if window.mic_rms_dbfs > -60.0
            && window.system_rms_dbfs > -80.0
            && (window.mic_rms_dbfs - window.system_rms_dbfs).abs() > 24.0
        {
            let difference = (window.mic_rms_dbfs - window.system_rms_dbfs).abs();
            self.warnings.push(format!(
                "track_imbalance: chunk {} microphone/system RMS differs by {:.1}dB ({:.1} vs {:.1}dBFS)",
                window.chunk_index, difference, window.mic_rms_dbfs, window.system_rms_dbfs
            ));
        }
        self.windows.push(window);
    }
}

pub fn source_directory(audio_path: &Path) -> PathBuf {
    let stem = audio_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    audio_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}.sources"))
}

pub fn quality_report_path(audio_path: &Path) -> PathBuf {
    let stem = audio_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    audio_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}.audio-quality.json"))
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("Read source artifact: {error}"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub fn persist_report(audio_path: &Path, report: &AudioQualityReport) -> Result<(), String> {
    let path = quality_report_path(audio_path);
    crate::durable_io::atomic_replace(
        &path,
        &serde_json::to_vec_pretty(report).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Commit quality report: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipping_and_missing_mic_require_review() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1);
        report.add_window(QualityWindow {
            chunk_index: 0,
            start_ms: 0,
            end_ms: 1_000,
            mic_clipped_ratio: 0.011,
            mic_rms_dbfs: -12.0,
            system_rms_dbfs: -18.0,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 96_000,
            system_bytes: 192_000,
        });
        report.add_window(QualityWindow {
            chunk_index: 1,
            start_ms: 1_000,
            end_ms: 2_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -90.0,
            system_rms_dbfs: -18.0,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 0,
            system_bytes: 192_000,
        });
        assert!(report.requires_review);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_clipping:")));
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_missing:")));
    }

    #[test]
    fn marginal_mic_clipping_is_advisory_only() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1);
        report.add_window(QualityWindow {
            chunk_index: 0,
            start_ms: 0,
            end_ms: 1_000,
            mic_clipped_ratio: 0.006,
            mic_rms_dbfs: -12.0,
            system_rms_dbfs: -18.0,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 96_000,
            system_bytes: 192_000,
        });

        assert!(!report.requires_review);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_clipping_advisory:")));
    }

    #[test]
    fn large_track_level_imbalance_is_advisory_only() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1);
        report.add_window(QualityWindow {
            chunk_index: 8,
            start_ms: 0,
            end_ms: 180_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -15.8,
            system_rms_dbfs: -55.8,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 17_280_000,
            system_bytes: 34_560_000,
        });

        assert!(!report.requires_review);
        assert!(report.warnings.iter().any(|warning| {
            warning.starts_with("track_imbalance:") && warning.contains("40.0dB")
        }));
    }

    #[test]
    fn quiet_system_audio_does_not_make_a_valid_mic_capture_review_required() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1);
        report.add_window(QualityWindow {
            chunk_index: 0,
            start_ms: 0,
            end_ms: 180_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -12.0,
            system_rms_dbfs: -49.0,
            mixed_rms_dbfs: -18.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 17_280_000,
            system_bytes: 34_560_000,
        });

        assert!(!report.requires_review);
        assert_eq!(report.warnings.len(), 1);
    }

    #[test]
    fn mic_ring_overrun_requires_review() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1);

        report.record_mic_overrun(512);

        assert!(report.requires_review);
        assert_eq!(report.mic_dropped_bytes, 512);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_overrun:")));
    }

    #[test]
    fn mixed_output_clipping_requires_review() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1);
        report.add_window(QualityWindow {
            chunk_index: 0,
            start_ms: 0,
            end_ms: 1_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -20.0,
            system_rms_dbfs: -20.0,
            mixed_rms_dbfs: -1.0,
            mixed_clipped_ratio: 0.006,
            mic_bytes: 96_000,
            system_bytes: 192_000,
        });

        assert!(report.requires_review);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mixed_clipping:")));
    }

    #[test]
    fn report_is_atomic_and_source_hash_is_stable() {
        let root = std::env::temp_dir().join(format!("atok-quality-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let audio = root.join("meeting.mp3");
        let source = root.join("source.bin");
        std::fs::write(&source, b"source audio").unwrap();
        assert_eq!(sha256_file(&source).unwrap().len(), 64);

        let report = AudioQualityReport::new(48_000, 2, 48_000, 1);
        persist_report(&audio, &report).unwrap();
        let restored: AudioQualityReport =
            serde_json::from_slice(&std::fs::read(quality_report_path(&audio)).unwrap()).unwrap();
        assert_eq!(restored, report);
        assert!(!root.read_dir().unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp")
        }));
        std::fs::remove_dir_all(root).unwrap();
    }
}
