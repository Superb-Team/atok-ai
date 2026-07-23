export type MarkdownAction =
  | "bold"
  | "italic"
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
