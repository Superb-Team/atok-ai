use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const QUALITY_SCHEMA_VERSION: u32 = 5;

const ADVISORY_WARNING_PREFIXES: &[&str] = &[
    "track_imbalance:",
    "mic_clipping_advisory:",
    "mic_overrun_advisory:",
    "mic_missing_advisory:",
];

// Speech peaks clip on a hot but usable headset; only sustained clipping costs words.
const MIC_CLIPPING_ADVISORY_RATIO: f32 = 0.005;
const MIC_CLIPPING_REVIEW_RATIO: f32 = 0.03;
const MIXED_CLIPPING_REVIEW_RATIO: f32 = 0.01;
// A drain-thread stall on a busy machine drops milliseconds, not words.
const MIC_DROP_REVIEW_MS: u64 = 250;
// A capture can close on a fraction of a second of system-only audio.
const TRAILING_GAP_ADVISORY_MS: u64 = 5_000;

pub fn is_advisory_warning(warning: &str) -> bool {
    ADVISORY_WARNING_PREFIXES
        .iter()
        .any(|prefix| warning.starts_with(prefix))
}

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
    #[serde(default)]
    pub aec_enabled: bool,
    pub requires_review: bool,
}

impl AudioQualityReport {
    pub fn new(
        sample_rate: u32,
        output_channels: u32,
        mic_sample_rate: u32,
        mic_channels: u32,
        aec_enabled: bool,
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
            aec_enabled,
            requires_review: false,
        }
    }

    pub fn add_window(&mut self, window: QualityWindow) {
        if window.mic_clipped_ratio > MIC_CLIPPING_REVIEW_RATIO {
            self.warnings.push(format!(
                "mic_clipping: chunk {} has {:.2}% near-full-scale samples",
                window.chunk_index,
                window.mic_clipped_ratio * 100.0
            ));
        } else if window.mic_clipped_ratio > MIC_CLIPPING_ADVISORY_RATIO {
            self.warnings.push(format!(
                "mic_clipping_advisory: chunk {} has {:.2}% near-full-scale samples",
                window.chunk_index,
                window.mic_clipped_ratio * 100.0
            ));
        }
        if window.mixed_clipped_ratio > MIXED_CLIPPING_REVIEW_RATIO {
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
        self.refresh_review_state();
    }

    pub fn record_source_artifact_failure(&mut self, error: &str) {
        self.warnings
            .push(format!("source_artifact_failed: {error}"));
        self.refresh_review_state();
    }

    /// Runs after the last window: only then is a trailing mic gap distinguishable.
    pub fn finalize(&mut self, mic_dropped_bytes: u64) {
        self.record_mic_overrun(mic_dropped_bytes);
        self.evaluate_microphone_coverage();
        self.refresh_review_state();
    }

    fn record_mic_overrun(&mut self, dropped_bytes: u64) {
        if dropped_bytes == 0 {
            return;
        }
        self.mic_dropped_bytes = self.mic_dropped_bytes.saturating_add(dropped_bytes);
        let dropped_ms = self.dropped_microphone_ms(dropped_bytes);
        let label = if dropped_ms > MIC_DROP_REVIEW_MS {
            "mic_overrun"
        } else {
            "mic_overrun_advisory"
        };
        self.warnings.push(format!(
            "{label}: {dropped_bytes} input bytes (~{dropped_ms}ms) were dropped before durable capture"
        ));
    }

    fn evaluate_microphone_coverage(&mut self) {
        let Some((last_index, last_span_ms)) = self.windows.last().map(|window| {
            (
                window.chunk_index,
                window.end_ms.saturating_sub(window.start_ms),
            )
        }) else {
            return;
        };
        // Excusable only for a brief closing remnant of a capture that did record
        // the microphone: a longer gap, or no microphone audio at all, is a real
        // capture failure.
        let remnant_is_excusable = last_span_ms <= TRAILING_GAP_ADVISORY_MS
            && self.windows.iter().any(|window| window.mic_bytes > 0);
        let gaps: Vec<(u32, bool)> = self
            .windows
            .iter()
            .filter(|window| window.mic_bytes == 0)
            .map(|window| {
                (
                    window.chunk_index,
                    remnant_is_excusable && window.chunk_index == last_index,
                )
            })
            .collect();
        for (chunk_index, is_remnant) in gaps {
            let label = if is_remnant {
                "mic_missing_advisory"
            } else {
                "mic_missing"
            };
            self.warnings.push(format!(
                "{label}: chunk {chunk_index} has no microphone samples"
            ));
        }
    }

    fn dropped_microphone_ms(&self, dropped_bytes: u64) -> u64 {
        let bytes_per_second = self.mic_sample_rate as u64 * self.mic_channels as u64 * 2;
        if bytes_per_second == 0 {
            return 0;
        }
        dropped_bytes * 1_000 / bytes_per_second
    }

    fn refresh_review_state(&mut self) {
        self.requires_review = self
            .warnings
            .iter()
            .any(|warning| !is_advisory_warning(warning));
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
    fn sustained_clipping_and_a_mid_recording_mic_gap_require_review() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);
        report.add_window(QualityWindow {
            chunk_index: 0,
            start_ms: 0,
            end_ms: 1_000,
            mic_clipped_ratio: 0.04,
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
        report.add_window(QualityWindow {
            chunk_index: 2,
            start_ms: 2_000,
            end_ms: 3_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -14.0,
            system_rms_dbfs: -18.0,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 96_000,
            system_bytes: 192_000,
        });
        report.finalize(0);

        assert!(report.requires_review);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_clipping:")));
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_missing: chunk 1")));
    }

    #[test]
    fn a_trailing_chunk_without_microphone_samples_is_advisory_only() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);
        report.add_window(QualityWindow {
            chunk_index: 0,
            start_ms: 0,
            end_ms: 180_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -14.0,
            system_rms_dbfs: -18.0,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 17_280_000,
            system_bytes: 34_560_000,
        });
        report.add_window(QualityWindow {
            chunk_index: 1,
            start_ms: 180_000,
            end_ms: 180_400,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -120.0,
            system_rms_dbfs: -18.0,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 0,
            system_bytes: 76_800,
        });
        report.finalize(0);

        assert!(!report.requires_review);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_missing_advisory: chunk 1")));
    }

    #[test]
    fn a_capture_that_never_recorded_the_microphone_requires_review() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);
        report.add_window(QualityWindow {
            chunk_index: 0,
            start_ms: 0,
            end_ms: 120_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -120.0,
            system_rms_dbfs: -18.0,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 0,
            system_bytes: 192_000,
        });
        report.finalize(0);

        assert!(report.requires_review);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_missing: chunk 0")));
    }

    #[test]
    fn a_microphone_that_dies_during_the_final_full_chunk_requires_review() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);
        report.add_window(QualityWindow {
            chunk_index: 0,
            start_ms: 0,
            end_ms: 180_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -14.0,
            system_rms_dbfs: -18.0,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 17_280_000,
            system_bytes: 34_560_000,
        });
        report.add_window(QualityWindow {
            chunk_index: 1,
            start_ms: 180_000,
            end_ms: 360_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -120.0,
            system_rms_dbfs: -18.0,
            mixed_rms_dbfs: -20.0,
            mixed_clipped_ratio: 0.0,
            mic_bytes: 0,
            system_bytes: 34_560_000,
        });
        report.finalize(0);

        assert!(report.requires_review);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_missing: chunk 1")));
    }

    #[test]
    fn marginal_mic_clipping_is_advisory_only() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);
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
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);
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
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);
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
    fn a_brief_mic_ring_overrun_is_advisory_only() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);

        // 512 bytes of 48kHz mono S16 is about 5ms of audio.
        report.finalize(512);

        assert!(!report.requires_review);
        assert_eq!(report.mic_dropped_bytes, 512);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_overrun_advisory:")));
    }

    #[test]
    fn a_sustained_mic_ring_overrun_requires_review() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);

        // One second of 48kHz mono S16 is far past the reviewable drop budget.
        report.finalize(96_000);

        assert!(report.requires_review);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.starts_with("mic_overrun:")));
    }

    #[test]
    fn mixed_output_clipping_requires_review() {
        let mut report = AudioQualityReport::new(48_000, 2, 48_000, 1, false);
        report.add_window(QualityWindow {
            chunk_index: 0,
            start_ms: 0,
            end_ms: 1_000,
            mic_clipped_ratio: 0.0,
            mic_rms_dbfs: -20.0,
            system_rms_dbfs: -20.0,
            mixed_rms_dbfs: -1.0,
            mixed_clipped_ratio: 0.02,
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

        let report = AudioQualityReport::new(48_000, 2, 48_000, 1, true);
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
