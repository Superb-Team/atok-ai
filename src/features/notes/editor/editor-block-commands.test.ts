import test from "node:test";
import assert from "node:assert/strict";
import {
  filterEditorBlockCommands,
  moveCommandSelection,
} from "./editor-block-commands.ts";

test("returns every command for an empty query", () => {
  assert.equal(filterEditorBlockCommands("").length, 10);
});

test("filters commands using English and Indonesian keywords", () => {
  assert.deepEqual(
    filterEditorBlockCommands("tab").map(({ id }) => id),
    ["table"],
  );
  assert.deepEqual(
    filterEditorBlockCommands("judul").map(({ id }) => id),
    ["heading2", "heading3"],
  );
  assert.deepEqual(
    filterEditorBlockCommands("kode").map(({ id }) => id),
    ["codeBlock"],
  );
});

test("prioritizes label prefixes before keyword and substring matches", () => {
  assert.equal(filterEditorBlockCommands("sub")[0]?.id, "heading3");
});

test("wraps keyboard selection in both directions", () => {
  assert.equal(moveCommandSelection(0, -1, 4), 3);
  assert.equal(moveCommandSelection(3, 1, 4), 0);
  assert.equal(moveCommandSelection(-1, 1, 4), 0);
  assert.equal(moveCommandSelection(-1, -1, 4), 3);
  assert.equal(moveCommandSelection(0, 1, 0), -1);
});
