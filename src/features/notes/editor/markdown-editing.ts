export type MarkdownAction =
  | "bold"
  | "italic"
  | "strikethrough"
  | "inlineCode"
  | "heading2"
  | "heading3"
  | "bullet"
  | "ordered"
  | "checklist"
  | "quote"
  | "link";

export interface MarkdownEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

const INLINE_WRAPPERS: Partial<Record<MarkdownAction, [string, string, string]>> = {
  bold: ["**", "**", "bold text"],
  italic: ["*", "*", "italic text"],
  strikethrough: ["~~", "~~", "strikethrough"],
  inlineCode: ["`", "`", "code"],
  link: ["[", "](https://)", "link text"],
};

const LINE_PREFIXES: Partial<Record<MarkdownAction, string>> = {
  heading2: "## ",
  heading3: "### ",
  bullet: "- ",
  ordered: "1. ",
  checklist: "- [ ] ",
  quote: "> ",
};

export function applyMarkdownAction(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  action: MarkdownAction,
): MarkdownEdit {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const wrapper = INLINE_WRAPPERS[action];

  if (wrapper) {
    const [before, after, placeholder] = wrapper;
    const selected = value.slice(start, end) || placeholder;
    const replacement = `${before}${selected}${after}`;
    return {
      value: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
      selectionStart: start + before.length,
      selectionEnd: start + before.length + selected.length,
    };
  }

  const prefix = LINE_PREFIXES[action];
  if (!prefix) return { value, selectionStart: start, selectionEnd: end };

  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextBreak = value.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const selectedLines = value.slice(lineStart, lineEnd);
  const replacement = selectedLines
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
  const added = replacement.length - selectedLines.length;

  return {
    value: `${value.slice(0, lineStart)}${replacement}${value.slice(lineEnd)}`,
    selectionStart: start + prefix.length,
    selectionEnd: end + added,
  };
}

export function insertMarkdownAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  markdown: string,
): MarkdownEdit {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leading = before.length > 0 && !before.endsWith("\n") ? "\n\n" : "";
  const trailing = after.length > 0 && !after.startsWith("\n") ? "\n\n" : "";
  const inserted = `${leading}${markdown}${trailing}`;
  const cursor = start + inserted.length - trailing.length;

  return {
    value: `${before}${inserted}${after}`,
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

export type MarkdownBlockCommand =
  | "heading2"
  | "heading3"
  | "bullet"
  | "ordered"
  | "checklist"
  | "quote"
  | "codeBlock"
  | "table"
  | "divider"
  | "callout";

export interface SlashCommandContext {
  start: number;
  end: number;
  query: string;
}

const BLOCK_TEMPLATES: Record<MarkdownBlockCommand, { text: string; select?: string }> = {
  heading2: { text: "## Section heading", select: "Section heading" },
  heading3: { text: "### Subheading", select: "Subheading" },
  bullet: { text: "- List item", select: "List item" },
  ordered: { text: "1. List item", select: "List item" },
  checklist: { text: "- [ ] Task", select: "Task" },
  quote: { text: "> Quote", select: "Quote" },
  codeBlock: { text: "```\ncode\n```", select: "code" },
  table: {
    text: "| Column 1 | Column 2 |\n| --- | --- |\n| Value 1 | Value 2 |",
    select: "Column 1",
  },
  divider: { text: "---" },
  callout: { text: "> **Note**\n> Add important context here.", select: "Add important context here." },
};

export function getSlashCommandContext(
  value: string,
  cursor: number,
): SlashCommandContext | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const lineStart = value.lastIndexOf("\n", Math.max(0, safeCursor - 1)) + 1;
  const beforeCursor = value.slice(lineStart, safeCursor);
  const match = beforeCursor.match(/^\s*\/([a-z0-9-]*)$/i);
  if (!match) return null;
  return {
    start: lineStart,
    end: safeCursor,
    query: match[1].toLowerCase(),
  };
}

export function insertMarkdownBlock(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  command: MarkdownBlockCommand,
  slashContext?: SlashCommandContext | null,
): MarkdownEdit {
  const template = BLOCK_TEMPLATES[command];
  const edit = slashContext
    ? replaceRange(value, slashContext.start, slashContext.end, template.text)
    : insertMarkdownAtSelection(value, selectionStart, selectionEnd, template.text);
  if (!template.select) return edit;

  const insertedStart = edit.value.lastIndexOf(
    template.text,
    Math.max(0, edit.selectionStart),
  );
  const selectionOffset = template.text.indexOf(template.select);
  if (insertedStart < 0 || selectionOffset < 0) return edit;
  return {
    ...edit,
    selectionStart: insertedStart + selectionOffset,
    selectionEnd: insertedStart + selectionOffset + template.select.length,
  };
}

function replaceRange(
  value: string,
  start: number,
  end: number,
  replacement: string,
): MarkdownEdit {
  const cursor = start + replacement.length;
  return {
    value: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}
