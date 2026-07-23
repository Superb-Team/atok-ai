import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMarkdownAction,
  insertMarkdownAtSelection,
} from "./markdown-editing.ts";

test("wraps selected text without changing the source around it", () => {
  const edit = applyMarkdownAction("hello world", 6, 11, "bold");
  assert.equal(edit.value, "hello **world**");
  assert.deepEqual([edit.selectionStart, edit.selectionEnd], [8, 13]);
});

test("adds a markdown prefix to every selected line", () => {
  const edit = applyMarkdownAction("one\ntwo\nthree", 0, 7, "checklist");
  assert.equal(edit.value, "- [ ] one\n- [ ] two\nthree");
});

test("inserts attachment markdown on a clean paragraph boundary", () => {
  const edit = insertMarkdownAtSelection("BeforeAfter", 6, 6, "![shot](/tmp/shot.png)");
  assert.equal(edit.value, "Before\n\n![shot](/tmp/shot.png)\n\nAfter");
});
