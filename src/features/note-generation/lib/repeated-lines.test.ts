import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collapseRepeatedLines } from "./repeated-lines.ts";

describe("collapseRepeatedLines", () => {
  it("drops a content line after its second occurrence, case-insensitively", () => {
    assert.equal(collapseRepeatedLines("- a\n- A\n- a\n- b"), "- a\n- A\n- b");
  });

  it("keeps repeated headings and asset markers", () => {
    const text = "## X\n[[ATOK_ASSET_1]]\n## X\n[[ATOK_ASSET_1]]\n## X\n[[ATOK_ASSET_1]]";
    assert.equal(collapseRepeatedLines(text), text);
  });
});
