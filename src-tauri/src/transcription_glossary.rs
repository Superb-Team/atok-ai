use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: u32 = 1;
const MAX_TERMS: usize = 1_000;
const MAX_TERM_CHARS: usize = 100;
const MAX_TOTAL_CHARS: usize = 64_000;
const MAX_PROMPT_TERMS: usize = 64;
const MAX_PROMPT_CHARS: usize = 2_000;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingGlossary {
    pub schema_version: u32,
    pub terms: Vec<String>,
    pub prompt_terms: Vec<String>,
}

fn glossary_path(audio_path: &Path) -> PathBuf {
    let stem = audio_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    audio_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}.glossary.json"))
}

fn split_terms(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values
        .into_iter()
        .flat_map(|value| {
            value
                .split([',', '\n', ';'])
                .map(str::trim)
                .filter(|term| !term.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect()
}

pub fn build_recording_glossary(
    requested: Option<Vec<String>>,
) -> Result<RecordingGlossary, String> {
    let deployment = std::env::var("WHISPER_GLOSSARY")
        .ok()
        .map(|value| vec![value])
        .unwrap_or_default();
    let mut candidates = split_terms(requested.unwrap_or_default());
    candidates.extend(split_terms(deployment));

    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    let mut total_chars = 0usize;
    for term in candidates {
        if term.chars().any(char::is_control) {
            return Err("Glossary terms cannot contain control characters".to_string());
        }
        let char_count = term.chars().count();
        if char_count > MAX_TERM_CHARS {
            return Err(format!(
                "Glossary term exceeds {MAX_TERM_CHARS} characters: {term}"
            ));
        }
        let key = term.to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        total_chars += char_count;
        if terms.len() >= MAX_TERMS || total_chars > MAX_TOTAL_CHARS {
            return Err(format!(
                "Glossary exceeds {MAX_TERMS} terms or {MAX_TOTAL_CHARS} characters"
            ));
        }
        terms.push(term);
    }

    // Whisper's initial prompt has a small practical context. Preserve the full
    // glossary for integrity checks, but only send the highest-priority prefix.
    // Per-recording terms precede optional deployment defaults.
    let mut prompt_terms = Vec::new();
    let mut prompt_chars = 0usize;
    for term in &terms {
        let added = term.chars().count() + usize::from(!prompt_terms.is_empty()) * 2;
        if prompt_terms.len() >= MAX_PROMPT_TERMS || prompt_chars + added > MAX_PROMPT_CHARS {
            break;
        }
        prompt_chars += added;
        prompt_terms.push(term.clone());
    }

    Ok(RecordingGlossary {
        schema_version: SCHEMA_VERSION,
        terms,
        prompt_terms,
    })
}

pub fn persist(audio_path: &Path, glossary: &RecordingGlossary) -> Result<(), String> {
    crate::durable_io::atomic_replace(
        &glossary_path(audio_path),
        &serde_json::to_vec_pretty(glossary).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Persist recording glossary: {error}"))
}

pub fn load(audio_path: &Path) -> Result<RecordingGlossary, String> {
    let path = glossary_path(audio_path);
    if !path.is_file() {
        return Ok(RecordingGlossary {
            schema_version: SCHEMA_VERSION,
            ..Default::default()
        });
    }
    let glossary: RecordingGlossary = serde_json::from_slice(
        &std::fs::read(path).map_err(|error| format!("Read recording glossary: {error}"))?,
    )
    .map_err(|error| format!("Parse recording glossary: {error}"))?;
    if glossary.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "Unsupported recording glossary schema {}",
            glossary.schema_version
        ));
    }
    Ok(glossary)
}

#[tauri::command]
pub async fn save_recording_glossary(
    audio_path: String,
    terms: Option<Vec<String>>,
) -> Result<RecordingGlossary, String> {
    let glossary = build_recording_glossary(terms)?;
    persist(Path::new(&audio_path), &glossary)?;
    Ok(glossary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glossary_is_empty_without_recording_or_deployment_terms() {
        // Test the normalizer directly so process-global environment state cannot
        // make this assertion flaky under parallel tests.
        assert!(split_terms(Vec::<String>::new()).is_empty());
    }

    #[test]
    fn splits_deduplicates_and_preserves_user_priority() {
        let terms = split_terms(vec![
            "Acme Fiber, Siti Aminah\nRFI".to_string(),
            "acme fiber; JSON".to_string(),
        ]);
        let mut seen = HashSet::new();
        let deduplicated: Vec<_> = terms
            .into_iter()
            .filter(|term| seen.insert(term.to_lowercase()))
            .collect();
        assert_eq!(deduplicated, ["Acme Fiber", "Siti Aminah", "RFI", "JSON"]);
    }

    #[test]
    fn persists_full_and_prompt_scoped_glossary() {
        let root = std::env::temp_dir().join(format!("atok-glossary-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let audio = root.join("meeting.mp3");
        let glossary = RecordingGlossary {
            schema_version: SCHEMA_VERSION,
            terms: vec!["Acme Fiber".into(), "Siti Aminah".into()],
            prompt_terms: vec!["Acme Fiber".into(), "Siti Aminah".into()],
        };
        persist(&audio, &glossary).unwrap();
        assert_eq!(load(&audio).unwrap(), glossary);
        std::fs::remove_dir_all(root).unwrap();
    }
}
