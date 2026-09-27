import { describeImage } from "@/features/note-generation/api/ai";
import { mapWithConcurrency } from "@/features/note-generation/lib/concurrency";
import { noteAssetService, type RecordingAssets } from "@/features/notes/api/note-asset.service";
import { errorMessage, logger } from "@/lib/logger";

export interface LoadedRecordingAssets {
  taken: RecordingAssets;
  descriptions: string[];
  elapsed: number;
}

// Screenshots + vision descriptions only need audioPath, so run them
// concurrently with Whisper instead of after it. Best-effort: any failure
// resolves to null and the note simply has no assets.
export function loadRecordingAssets(
  audioPath: string,
  langName: string,
  skipVision: boolean,
): Promise<LoadedRecordingAssets | null> {
  return (async () => {
    const started = performance.now();
    const taken = await noteAssetService.takeRecordingAssets(audioPath);
    const descriptions = await mapWithConcurrency(taken.assets, 2, async (a) => {
      try {
        return skipVision ? "" : await describeImage(a.path, langName);
      } catch {
        return "";
      }
    });
    return { taken, descriptions, elapsed: Math.round(performance.now() - started) };
  })().catch((assetErr) => {
    logger.error("note_generation.assets_load_failed", { error: errorMessage(assetErr) });
    return null;
  });
}
