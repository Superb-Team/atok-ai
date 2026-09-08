//! Note assets: file attachments (images/documents) and screenshots taken
//! during recording.
//!
//! Storage model is Obsidian-like: assets are plain files under the app-data
//! assets directory and notes reference them by absolute path in markdown.
//! Screenshots taken while recording are additionally logged (with their
//! elapsed-time offset) to a JSON sidecar next to the recording MP3 so the
//! processing pipeline can place them at the right position in the transcript.

use std::path::{Path, PathBuf};

// Executables (exe/msi/sh/bat/apk/...) are deliberately excluded.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf", "ppt", "pptx", "doc", "docx", "xls", "xlsx", "csv", "txt", "md", "rtf", "odt", "ods",
    "odp", "json", "xml", "zip", "rar", "7z", "tar", "gz", "mp4", "mkv", "webm", "mov", "mp3",
    "wav", "m4a", "flac", "aac", "ogg",
];

/// Recording MP3s are CBR 192kbps (both the recorder and audio_import encode
/// at this rate), so duration is derivable from the byte count alone.
const MP3_CBR_BYTES_PER_SECOND: u64 = 192_000 / 8;

#[derive(serde::Serialize, Clone, Debug)]
pub struct ImportedAsset {
    pub saved_path: String,
    pub kind: String,
    pub display_name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RecordingAsset {
    pub path: String,
    pub elapsed_ms: u64,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct RecordingAssets {
    pub assets: Vec<RecordingAsset>,
    pub duration_ms: u64,
}

// ==================== Import (file picker) ====================

/// Copy a user-picked file into the assets directory so the note references a
/// path the app owns (the original may live on removable media, Downloads that
/// get cleaned, etc.). Returns the stored path plus how to embed it.
#[tauri::command]
pub async fn import_note_asset(
    source_path: String,
    assets_dir: String,
) -> Result<ImportedAsset, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let kind = asset_kind(&ext).ok_or_else(|| {
        format!(
            "Unsupported file type '.{}'. Supported: {} (images), {} (documents)",
            ext,
            IMAGE_EXTENSIONS.join("/"),
            DOCUMENT_EXTENSIONS.join("/")
        )
    })?;

    let display_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("asset")
        .to_string();

    let dest = unique_asset_path(Path::new(&assets_dir), &display_name);

    let src_c = source.clone();
    let dest_c = dest.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if let Some(parent) = dest_c.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Create assets dir: {}", e))?;
        }
        std::fs::copy(&src_c, &dest_c).map_err(|e| format!("Copy asset: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(ImportedAsset {
        saved_path: dest.to_string_lossy().into_owned(),
        kind: kind.to_string(),
        display_name,
    })
}

// ==================== Screenshot (recording popup) ====================

/// Take a full-screen screenshot via the XDG desktop portal and store it in the
/// assets directory. Linux-only: the portal is the one mechanism that works on
/// both Wayland and X11 with zero external tools.
#[tauri::command]
pub async fn capture_screenshot(assets_dir: String) -> Result<ImportedAsset, String> {
    #[cfg(target_os = "linux")]
    {
        let uri = portal_screenshot().await?;
        let portal_file = uri
            .to_file_path()
            .map_err(|_| format!("Portal returned a non-file URI: {}", uri))?;

        let display_name = "screenshot.png".to_string();
        let dest = unique_asset_path(Path::new(&assets_dir), &display_name);

        let dest_c = dest.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            if let Some(parent) = dest_c.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("Create assets dir: {}", e))?;
            }
            std::fs::copy(&portal_file, &dest_c).map_err(|e| format!("Copy screenshot: {}", e))?;
            // The portal leaves its copy in the user's Pictures dir; remove it so
            // screenshots don't pile up outside the app's storage.
            let _ = std::fs::remove_file(&portal_file);
            Ok(())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

        Ok(ImportedAsset {
            saved_path: dest.to_string_lossy().into_owned(),
            kind: "image".to_string(),
            display_name,
        })
    }

    #[cfg(target_os = "macos")]
    {
        let display_name = "screenshot.png".to_string();
        let dest = unique_asset_path(Path::new(&assets_dir), &display_name);
        let dest_c = dest.clone();

        tokio::task::spawn_blocking(move || -> Result<(), String> {
            if let Some(parent) = dest_c.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Create assets dir: {}", e))?;
            }

            // `screencapture` uses the app's native Screen Recording permission,
            // works without an extra dependency, and `-m` captures the main
            // display as one deterministic file on multi-monitor Macs.
            let output = std::process::Command::new("/usr/sbin/screencapture")
                .args(["-x", "-m", "-t", "png"])
                .arg(&dest_c)
                .output()
                .map_err(|e| format!("Start macOS screenshot capture: {}", e))?;

            if !output.status.success() || !dest_c.is_file() {
                let _ = std::fs::remove_file(&dest_c);
                return Err(
                    "macOS could not capture the screen. Allow Screen Recording for atok-ai in System Settings > Privacy & Security > Screen Recording, then try again."
                        .to_string(),
                );
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

        Ok(ImportedAsset {
            saved_path: dest.to_string_lossy().into_owned(),
            kind: "image".to_string(),
            display_name,
        })
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = assets_dir;
        Err("Screenshot capture is not supported on this OS yet".to_string())
    }
}

#[cfg(target_os = "linux")]
async fn portal_screenshot() -> Result<url::Url, String> {
    use ashpd::desktop::screenshot::Screenshot;

    let response = Screenshot::request()
        .interactive(false)
        .modal(false)
        .send()
        .await
        .map_err(|e| format!("Screenshot portal request failed: {}", e))?
        .response()
        .map_err(|e| format!("Screenshot denied or failed: {}", e))?;

    Ok(response.uri().clone())
}

// ==================== Recording sidecar manifest ====================

fn manifest_path(audio_path: &str) -> PathBuf {
    let mp3 = PathBuf::from(audio_path);
    let stem = mp3
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording")
        .to_string();
    mp3.parent()
        .unwrap_or(Path::new("."))
        .join(format!("{}.assets.json", stem))
}

/// Append a screenshot entry to the recording's `.assets.json` sidecar so the
/// processing pipeline can place it at the matching transcript position.
#[tauri::command]
pub async fn record_screenshot_asset(
    audio_path: String,
    saved_path: String,
    elapsed_ms: u64,
) -> Result<(), String> {
    let manifest = manifest_path(&audio_path);
    let mut entries: Vec<RecordingAsset> = match std::fs::read_to_string(&manifest) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    entries.push(RecordingAsset {
        path: saved_path,
        elapsed_ms,
    });
    let json =
        serde_json::to_string_pretty(&entries).map_err(|e| format!("Serialize manifest: {}", e))?;
    std::fs::write(&manifest, json).map_err(|e| format!("Write manifest: {}", e))
}

/// Read the durable screenshot manifest for a finished recording. Returns the
/// entries sorted by elapsed time plus the MP3 duration (derived from the CBR
/// byte rate) so retries can reproduce the same note after a restart.
#[tauri::command]
pub async fn take_recording_assets(audio_path: String) -> Result<RecordingAssets, String> {
    let manifest = manifest_path(&audio_path);
    let mut assets: Vec<RecordingAsset> = match std::fs::read_to_string(&manifest) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    assets.sort_by_key(|a| a.elapsed_ms);
    // Drop entries whose file vanished (e.g. user cleaned the assets dir).
    assets.retain(|a| Path::new(&a.path).is_file());

    let duration_ms = std::fs::metadata(&audio_path)
        .map(|m| mp3_duration_ms(m.len()))
        .unwrap_or(0);

    Ok(RecordingAssets {
        assets,
        duration_ms,
    })
}

// ==================== Helpers ====================

fn asset_kind(ext: &str) -> Option<&'static str> {
    if IMAGE_EXTENSIONS.contains(&ext) {
        Some("image")
    } else if DOCUMENT_EXTENSIONS.contains(&ext) {
        Some("document")
    } else {
        None
    }
}

fn mp3_duration_ms(byte_len: u64) -> u64 {
    byte_len * 1000 / MP3_CBR_BYTES_PER_SECOND
}

/// `{unix_millis}_{sanitized_name}` under `assets_dir` — unique per call and
/// safe for markdown links (no spaces/parentheses that would break `![](...)`).
fn unique_asset_path(assets_dir: &Path, original_name: &str) -> PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    assets_dir.join(format!("{}_{}", millis, sanitize_file_name(original_name)))
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.trim_matches(['_', '.']).is_empty() {
        "asset".to_string()
    } else {
        cleaned
    }
}

// ==================== Tests ====================

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("atok-assets-test-{}-{}", tag, nanos));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn classifies_asset_kinds() {
        assert_eq!(asset_kind("png"), Some("image"));
        assert_eq!(asset_kind("webp"), Some("image"));
        assert_eq!(asset_kind("svg"), Some("image"));
        assert_eq!(asset_kind("pdf"), Some("document"));
        assert_eq!(asset_kind("pptx"), Some("document"));
        assert_eq!(asset_kind("xlsx"), Some("document"));
        assert_eq!(asset_kind("csv"), Some("document"));
        assert_eq!(asset_kind("zip"), Some("document"));
        assert_eq!(asset_kind("mp4"), Some("document"));
        assert_eq!(asset_kind("exe"), None);
        assert_eq!(asset_kind("sh"), None);
        assert_eq!(asset_kind(""), None);
    }

    #[test]
    fn sanitizes_file_names_for_markdown() {
        assert_eq!(sanitize_file_name("slide (final).png"), "slide__final_.png");
        assert_eq!(sanitize_file_name("rapat 2026.pdf"), "rapat_2026.pdf");
        assert_eq!(sanitize_file_name("///"), "asset");
    }

    #[test]
    fn cbr_duration_matches_rate() {
        // 60s of CBR 192kbps = 1_440_000 bytes.
        assert_eq!(mp3_duration_ms(1_440_000), 60_000);
        assert_eq!(mp3_duration_ms(0), 0);
    }

    #[tokio::test]
    async fn import_rejects_unsupported_extension() {
        let dir = temp_dir("reject");
        let src = dir.join("payload.exe");
        std::fs::write(&src, b"x").unwrap();

        let err = import_note_asset(
            src.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("Unsupported file type"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_copies_image_with_unique_name() {
        let dir = temp_dir("copy");
        let src = dir.join("photo one.png");
        std::fs::write(&src, b"pngdata").unwrap();

        let asset = import_note_asset(
            src.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();

        assert_eq!(asset.kind, "image");
        assert_eq!(asset.display_name, "photo one.png");
        assert!(asset.saved_path.ends_with("photo_one.png"));
        assert_eq!(std::fs::read(&asset.saved_path).unwrap(), b"pngdata");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn manifest_appends_and_takes_sorted() {
        let dir = temp_dir("manifest");
        let mp3 = dir.join("recording-1.mp3");
        // 30s of CBR 192kbps.
        std::fs::write(&mp3, vec![0u8; 720_000]).unwrap();
        let shot_a = dir.join("a.png");
        let shot_b = dir.join("b.png");
        std::fs::write(&shot_a, b"a").unwrap();
        std::fs::write(&shot_b, b"b").unwrap();

        let mp3_str = mp3.to_string_lossy().into_owned();
        record_screenshot_asset(
            mp3_str.clone(),
            shot_b.to_string_lossy().into_owned(),
            20_000,
        )
        .await
        .unwrap();
        record_screenshot_asset(
            mp3_str.clone(),
            shot_a.to_string_lossy().into_owned(),
            5_000,
        )
        .await
        .unwrap();

        let taken = take_recording_assets(mp3_str.clone()).await.unwrap();
        assert_eq!(taken.duration_ms, 30_000);
        assert_eq!(taken.assets.len(), 2);
        assert_eq!(taken.assets[0].elapsed_ms, 5_000);
        assert_eq!(taken.assets[1].elapsed_ms, 20_000);

        // Durable: retries and restart recovery see the same ordered assets.
        let again = take_recording_assets(mp3_str).await.unwrap();
        assert_eq!(again.assets.len(), 2);
        assert_eq!(again.assets[0].elapsed_ms, 5_000);
        assert_eq!(again.assets[1].elapsed_ms, 20_000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
