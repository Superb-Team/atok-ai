import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMarkdownAction,
  getSlashCommandContext,
  insertMarkdownBlock,
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

test("detects a slash command only at the start of the active line", () => {
  assert.deepEqual(getSlashCommandContext("Intro\n/hea", 10), {
    start: 6,
    end: 10,
    query: "hea",
  });
  assert.equal(getSlashCommandContext("Use /hea here", 13), null);
});

test("replaces a slash query with a ready-to-edit block", () => {
  const context = getSlashCommandContext("Intro\n/tab", 10);
  const edit = insertMarkdownBlock("Intro\n/tab", 10, 10, "table", context);
  assert.match(edit.value, /Intro\n\| Column 1 \| Column 2 \|/);
  assert.equal(edit.value.slice(edit.selectionStart, edit.selectionEnd), "Column 1");
});
