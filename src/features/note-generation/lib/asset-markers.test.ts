import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyAssetMarkers, formatElapsed, insertAssetMarkers } from "./asset-markers.ts";

const asset = (elapsed_ms: number, path: string) => ({ elapsed_ms, path }) as never;

describe("insertAssetMarkers", () => {
  it("places a marker at the word position proportional to capture time", () => {
    const marked = insertAssetMarkers("one two three four", [asset(5_000, "/a.png")], 10_000);
    assert.equal(marked, "one two\n\n[[ATOK_ASSET_1]]\n\n three four");
  });

  it("appends markers when the transcript or duration is empty", () => {
    assert.equal(insertAssetMarkers("", [asset(0, "/a.png")], 0), "[[ATOK_ASSET_1]]");
  });
});

describe("applyAssetMarkers", () => {
  it("embeds each asset once and drops duplicate markers", () => {
    const text = "[[ATOK_ASSET_1]]\nbody\n[[ATOK_ASSET_1]]";
    assert.equal(applyAssetMarkers(text, [asset(65_000, "/a.png")]), "![Screenshot 01:05](/a.png)\nbody\n");
  });

  it("appends screenshots whose marker the model dropped", () => {
    const result = applyAssetMarkers("# Note", [asset(0, "/a.png")]);
    assert.equal(result, "# Note\n\n## Screenshots\n\n![Screenshot 00:00](/a.png)\n");
  });
});

describe("formatElapsed", () => {
  it("formats milliseconds as mm:ss", () => {
    assert.equal(formatElapsed(125_999), "02:05");
  });
});
