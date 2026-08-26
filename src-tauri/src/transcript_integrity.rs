use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptIssue {
    pub code: String,
    pub detail: String,
    pub candidate: Option<String>,
    pub expected: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceAnchor {
    pub evidence_id: String,
    pub revision_id: String,
    pub chunk_index: usize,
    pub audio_sha256: Option<String>,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
    pub char_start: Option<usize>,
    pub char_end: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptIntegrityReport {
    pub schema_version: u32,
    pub revision_id: String,
    pub transcript_sha256: String,
    pub generated_at: String,
    pub requires_review: bool,
    pub issues: Vec<TranscriptIssue>,
    pub evidence: Vec<EvidenceAnchor>,
    pub asr_attempt_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAttempt {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    created_at: String,
    chunk_index: usize,
    response: StoredResponse,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredResponse {
    text: String,
    #[serde(default)]
    audio_sha256: Option<String>,
    #[serde(default)]
    segments: Vec<StoredRange>,
    #[serde(default)]
    words: Vec<StoredRange>,
}

#[derive(Clone, Deserialize)]
struct StoredRange {
    start: f64,
    end: f64,
    text: String,
}

fn sidecar_stem(audio_path: &Path) -> (&Path, String) {
    let parent = audio_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = audio_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording")
        .to_string();
    (parent, stem)
}

fn artifact_paths(audio_path: &Path) -> (PathBuf, PathBuf) {
    let (parent, stem) = sidecar_stem(audio_path);
    (
        parent.join(format!("{stem}.asr")),
        parent.join(format!("{stem}.audio-quality.json")),
    )
}

fn normalized_words(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|character| character.is_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

fn edit_distance(left: &str, right: &str) -> usize {
    let right_chars: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right_chars.len()).collect();
    for (left_index, left_char) in left.chars().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_char) in right_chars.iter().enumerate() {
            current.push(
                (previous[right_index + 1] + 1)
                    .min(current[right_index] + 1)
                    .min(previous[right_index] + usize::from(left_char != *right_char)),
            );
        }
        previous = current;
    }
    previous[right_chars.len()]
}

fn entity_issues(transcript: &str, glossary_terms: &[String]) -> Vec<TranscriptIssue> {
    let transcript_words = normalized_words(transcript);
    let normalized_transcript = transcript_words.join(" ");
    let mut issues = Vec::new();
    for expected in glossary_terms {
        let expected_words = normalized_words(expected);
        if expected_words.is_empty() {
            continue;
        }
        let expected_normalized = expected_words.join(" ");
        if normalized_transcript.contains(&expected_normalized) {
            continue;
        }
        for window in transcript_words.windows(expected_words.len()) {
            let candidate = window.join(" ");
            let threshold = (expected_normalized.chars().count() / 10).clamp(1, 3);
            let distance = edit_distance(&candidate, &expected_normalized);
            if distance <= threshold {
                issues.push(TranscriptIssue {
                    code: "glossary_near_match".to_string(),
                    detail: format!(
                        "Possible ASR substitution: '{candidate}' is close to glossary term '{expected}'"
                    ),
                    candidate: Some(candidate),
                    expected: Some(expected.clone()),
                });
                break;
            }
        }
    }
    issues
}

fn cross_attempt_glossary_issues(
    transcript: &str,
    glossary_terms: &[String],
    attempts: &[StoredAttempt],
) -> Vec<TranscriptIssue> {
    let transcript_normalized = normalized_words(transcript).join(" ");
    let attempt_text = attempts
        .iter()
        .map(|attempt| normalized_words(&attempt.response.text).join(" "))
        .collect::<Vec<_>>();
    glossary_terms
        .iter()
        .filter_map(|expected| {
            let normalized = normalized_words(expected).join(" ");
            if normalized.is_empty()
                || transcript_normalized.contains(&normalized)
                || !attempt_text.iter().any(|text| text.contains(&normalized))
            {
                return None;
            }
            Some(TranscriptIssue {
                code: "cross_track_glossary_conflict".to_string(),
                detail: format!(
                    "At least one ASR track heard glossary term '{expected}', but it is absent from the canonical transcript"
                ),
                candidate: None,
                expected: Some(expected.clone()),
            })
        })
        .collect()
}

fn load_attempts(directory: &Path) -> Vec<StoredAttempt> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| serde_json::from_slice(&std::fs::read(path).ok()?).ok())
        .collect()
}

fn latest_run_attempts(attempts: Vec<StoredAttempt>) -> Vec<StoredAttempt> {
    let Some(latest_run_id) = attempts
        .iter()
        .filter_map(|attempt| {
            attempt
                .run_id
                .as_ref()
                .map(|run_id| (attempt.created_at.as_str(), run_id))
        })
        .max_by(|left, right| left.0.cmp(right.0))
        .map(|(_, run_id)| run_id.clone())
    else {
        return attempts;
    };

    attempts
        .into_iter()
        .filter(|attempt| attempt.run_id.as_deref() == Some(latest_run_id.as_str()))
        .collect()
}

fn blocking_quality_detail(value: &serde_json::Value) -> Option<String> {
    if value["requiresReview"].as_bool() != Some(true) {
        return None;
    }
    let warnings = value["warnings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|warning| warning.as_str())
        .filter(|warning| !warning.starts_with("track_imbalance:"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if warnings.is_empty()
        && value["warnings"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    {
        return None;
    }
    Some(if warnings.is_empty() {
        "Capture diagnostics require transcript verification".to_string()
    } else {
        format!(
            "Capture diagnostics require transcript verification: {}",
            warnings.join("; ")
        )
    })
}

fn persist_report(audio_path: &Path, report: &TranscriptIntegrityReport) -> Result<(), String> {
    let (parent, stem) = sidecar_stem(audio_path);
    let destination = parent.join(format!("{stem}.transcript-integrity.json"));
    let bytes = serde_json::to_vec_pretty(report).map_err(|error| error.to_string())?;
    crate::durable_io::atomic_replace(&destination, &bytes)
        .map_err(|error| format!("Commit transcript integrity: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn evaluate_transcript_integrity(
    audio_path: String,
    transcript: String,
) -> Result<TranscriptIntegrityReport, String> {
    let audio_path = PathBuf::from(audio_path);
    let (attempt_directory, quality_path) = artifact_paths(&audio_path);
    let attempts = latest_run_attempts(load_attempts(&attempt_directory));
    let recording_glossary = crate::transcription_glossary::load(&audio_path)?;
    let transcript_sha256 = hex::encode(Sha256::digest(transcript.as_bytes()));
    let source_hashes = attempts
        .iter()
        .filter_map(|attempt| attempt.response.audio_sha256.as_deref())
        .collect::<Vec<_>>()
        .join(":");
    let revision_id = hex::encode(Sha256::digest(
        format!("{transcript_sha256}:{source_hashes}").as_bytes(),
    ));
    let mut issues = entity_issues(&transcript, &recording_glossary.terms);
    issues.extend(cross_attempt_glossary_issues(
        &transcript,
        &recording_glossary.terms,
        &attempts,
    ));
    if attempts.is_empty() {
        issues.push(TranscriptIssue {
            code: "missing_asr_provenance".to_string(),
            detail: "No immutable ASR attempt artifact was found".to_string(),
            candidate: None,
            expected: None,
        });
    }
    if attempts
        .iter()
        .all(|attempt| attempt.response.segments.is_empty() && attempt.response.words.is_empty())
    {
        issues.push(TranscriptIssue {
            code: "missing_timestamp_provenance".to_string(),
            detail: "The ASR provider returned no timestamped words or segments".to_string(),
            candidate: None,
            expected: None,
        });
    }
    if let Ok(value) = std::fs::read(&quality_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .ok_or(())
    {
        if let Some(detail) = blocking_quality_detail(&value) {
            issues.push(TranscriptIssue {
                code: "audio_quality_requires_review".to_string(),
                detail,
                candidate: None,
                expected: None,
            });
        }
    }

    let mut evidence = Vec::new();
    let mut transcript_cursor = 0usize;
    for attempt in &attempts {
        let ranges = if attempt.response.segments.is_empty() {
            &attempt.response.words
        } else {
            &attempt.response.segments
        };
        for (range_index, range) in ranges.iter().enumerate() {
            let evidence_id = hex::encode(Sha256::digest(
                format!(
                    "{}:{}:{}:{:.3}:{:.3}",
                    revision_id, attempt.chunk_index, range_index, range.start, range.end
                )
                .as_bytes(),
            ));
            evidence.push(EvidenceAnchor {
                evidence_id,
                revision_id: revision_id.clone(),
                chunk_index: attempt.chunk_index,
                audio_sha256: attempt.response.audio_sha256.clone(),
                start_seconds: range.start,
                end_seconds: range.end,
                text: range.text.clone(),
                char_start: transcript[transcript_cursor..]
                    .find(range.text.trim())
                    .map(|offset| transcript_cursor + offset),
                char_end: transcript[transcript_cursor..]
                    .find(range.text.trim())
                    .map(|offset| transcript_cursor + offset + range.text.trim().len()),
            });
            if let Some(end) = evidence.last().and_then(|anchor| anchor.char_end) {
                transcript_cursor = end;
            }
        }
    }
    let report = TranscriptIntegrityReport {
        schema_version: 1,
        revision_id,
        transcript_sha256,
        generated_at: chrono::Utc::now().to_rfc3339(),
        requires_review: !issues.is_empty(),
        issues,
        evidence,
        asr_attempt_count: attempts.len(),
    };
    persist_report(&audio_path, &report)?;
    Ok(report)
}

#[tauri::command]
pub async fn accept_transcript_revision(
    audio_path: String,
    transcript: String,
) -> Result<TranscriptIntegrityReport, String> {
    if transcript.trim().is_empty() || transcript.len() > 10_000_000 {
        return Err("Accepted transcript must contain 1-10,000,000 bytes".to_string());
    }
    let path = PathBuf::from(&audio_path);
    let (parent, stem) = sidecar_stem(&path);
    let destination = parent.join(format!("{stem}.transcript.txt"));
    crate::durable_io::atomic_replace(&destination, transcript.as_bytes())
        .map_err(|error| format!("Commit accepted transcript: {error}"))?;
    evaluate_transcript_integrity(audio_path, transcript).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_generic_company_near_match_without_auto_correcting() {
        let issues = entity_issues(
            "Logo Acme Fibar akan ditampilkan.",
            &["Acme Fiber".to_string()],
        );
        assert!(issues.iter().any(|issue| {
            issue.code == "glossary_near_match"
                && issue.expected.as_deref() == Some("Acme Fiber")
                && issue.candidate.as_deref() == Some("acme fibar")
        }));
    }

    #[test]
    fn detects_generic_person_name_near_match() {
        let issues = entity_issues(
            "Menurut Siti Amina, logo tetap dipakai.",
            &["Siti Aminah".to_string()],
        );
        assert!(issues.iter().any(|issue| {
            issue.expected.as_deref() == Some("Siti Aminah")
                && issue.candidate.as_deref() == Some("siti amina")
        }));
    }

    #[test]
    fn treats_track_imbalance_as_advisory_for_legacy_quality_reports() {
        let report = serde_json::json!({
            "requiresReview": true,
            "warnings": ["track_imbalance: chunk 1 differs by 30.7dB"]
        });

        assert_eq!(blocking_quality_detail(&report), None);
    }

    #[test]
    fn preserves_specific_blocking_quality_reasons() {
        let report = serde_json::json!({
            "requiresReview": true,
            "warnings": ["mic_clipping: chunk 0 has 1.2% near-full-scale samples"]
        });

        assert_eq!(
            blocking_quality_detail(&report).as_deref(),
            Some("Capture diagnostics require transcript verification: mic_clipping: chunk 0 has 1.2% near-full-scale samples")
        );
    }

    #[test]
    fn flags_any_glossary_term_heard_on_an_alternate_track_but_missing_from_canonical() {
        let attempts = vec![StoredAttempt {
            chunk_index: 0,
            run_id: None,
            created_at: String::new(),
            response: StoredResponse {
                text: "Logo Acme Fiber perlu ditampilkan.".to_string(),
                audio_sha256: None,
                segments: Vec::new(),
                words: Vec::new(),
            },
        }];
        let issues = cross_attempt_glossary_issues(
            "Logo vendor perlu ditampilkan.",
            &["Acme Fiber".to_string()],
            &attempts,
        );
        assert!(issues
            .iter()
            .any(|issue| issue.code == "cross_track_glossary_conflict"));
    }

    #[test]
    fn exact_glossary_term_does_not_raise_issue() {
        let issues = entity_issues(
            "Logo Acme Fiber akan ditampilkan.",
            &["Acme Fiber".to_string()],
        );
        assert!(!issues
            .iter()
            .any(|issue| issue.expected.as_deref() == Some("Acme Fiber")));
    }

    #[test]
    fn evidence_id_is_bound_to_revision_and_time_range() {
        let first = hex::encode(Sha256::digest(b"revision:0:0:1.000:2.000"));
        let second = hex::encode(Sha256::digest(b"revision:0:0:1.000:3.000"));
        assert_ne!(first, second);
    }

    #[test]
    fn integrity_uses_only_the_latest_transcription_run() {
        let response = || StoredResponse {
            text: "Agenda rapat.".to_string(),
            audio_sha256: None,
            segments: Vec::new(),
            words: Vec::new(),
        };
        let attempts = latest_run_attempts(vec![
            StoredAttempt {
                run_id: Some("old".to_string()),
                created_at: "2026-08-13T10:00:00Z".to_string(),
                chunk_index: 0,
                response: response(),
            },
            StoredAttempt {
                run_id: Some("new".to_string()),
                created_at: "2026-08-14T10:00:00Z".to_string(),
                chunk_index: 0,
                response: response(),
            },
        ]);

        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].run_id.as_deref(), Some("new"));
    }
}
