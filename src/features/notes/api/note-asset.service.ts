import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { appDataDir, join } from "@tauri-apps/api/path";

// Must mirror note_assets.rs. Executables are deliberately excluded.
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
const OFFICE_EXTENSIONS = ["pdf", "ppt", "pptx", "doc", "docx", "xls", "xlsx", "csv", "txt", "md", "rtf", "odt", "ods", "odp", "json", "xml"];
const MEDIA_EXTENSIONS = ["mp4", "mkv", "webm", "mov", "mp3", "wav", "m4a", "flac", "aac", "ogg"];
const ARCHIVE_EXTENSIONS = ["zip", "rar", "7z", "tar", "gz"];
const DOCUMENT_EXTENSIONS = [...OFFICE_EXTENSIONS, ...MEDIA_EXTENSIONS, ...ARCHIVE_EXTENSIONS];

export interface ImportedAsset {
  saved_path: string;
  kind: "image" | "document";
  display_name: string;
}

export interface RecordingAsset {
  path: string;
  elapsed_ms: number;
}

export interface RecordingAssets {
  assets: RecordingAsset[];
  duration_ms: number;
}

export class NoteAssetService {
  static async assetsDir(): Promise<string> {
    return join(await appDataDir(), "assets");
  }

  // Returns null if the user cancels the picker.
  static async pickAssetFile(): Promise<string | null> {
    const selected = await open({
      multiple: false,
      filters: [
        { name: "All supported", extensions: [...IMAGE_EXTENSIONS, ...DOCUMENT_EXTENSIONS] },
        { name: "Images", extensions: IMAGE_EXTENSIONS },
        { name: "Documents", extensions: OFFICE_EXTENSIONS },
        { name: "Media", extensions: MEDIA_EXTENSIONS },
        { name: "Archives", extensions: ARCHIVE_EXTENSIONS },
      ],
    });
    return typeof selected === "string" ? selected : null;
  }

  static async importAsset(sourcePath: string): Promise<ImportedAsset> {
    return invoke<ImportedAsset>("import_note_asset", {
      sourcePath,
      assetsDir: await this.assetsDir(),
    });
  }

  static async captureScreenshot(): Promise<ImportedAsset> {
    return invoke<ImportedAsset>("capture_screenshot", {
      assetsDir: await this.assetsDir(),
    });
  }

  static async recordScreenshotAsset(
    audioPath: string,
    savedPath: string,
    elapsedMs: number,
  ): Promise<void> {
    await invoke("record_screenshot_asset", {
      audioPath,
      savedPath,
      elapsedMs: Math.round(elapsedMs),
    });
  }

  static async takeRecordingAssets(audioPath: string): Promise<RecordingAssets> {
    return invoke<RecordingAssets>("take_recording_assets", { audioPath });
  }

  static assetMarkdown(asset: ImportedAsset): string {
    return asset.kind === "image"
      ? `![${asset.display_name}](${asset.saved_path})`
      : `[📎 ${asset.display_name}](${asset.saved_path})`;
  }

  // Images go inline at the end of the body; documents live under a single
  // trailing "## Attachments" section.
  static appendAssetToContent(content: string, asset: ImportedAsset): string {
    const base = content.trimEnd();
    if (asset.kind === "image") {
      return `${base}\n\n${this.assetMarkdown(asset)}\n`;
    }
    const line = `- ${this.assetMarkdown(asset)}`;
    if (/^## Attachments\s*$/m.test(base)) {
      return `${base}\n${line}\n`;
    }
    return `${base}\n\n## Attachments\n\n${line}\n`;
  }
}

export const noteAssetService = NoteAssetService;
