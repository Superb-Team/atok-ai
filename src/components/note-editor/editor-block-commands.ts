import type { MarkdownBlockCommand } from "@/lib/markdown-editing";

export interface EditorBlockCommand {
  id: MarkdownBlockCommand;
  label: string;
  description: string;
  keywords: string;
}

export const editorBlockCommands: EditorBlockCommand[] = [
  { id: "heading2", label: "Section heading", description: "Create a main section", keywords: "h2 heading section judul" },
  { id: "heading3", label: "Subheading", description: "Create a nested topic", keywords: "h3 heading subsection subjudul" },
  { id: "bullet", label: "Bullet list", description: "Add an unordered list", keywords: "bullet list poin" },
  { id: "ordered", label: "Numbered list", description: "Add an ordered list", keywords: "number ordered list nomor" },
  { id: "checklist", label: "Checklist", description: "Track an actionable item", keywords: "todo task checklist tugas" },
  { id: "quote", label: "Quote", description: "Emphasize a quotation", keywords: "quote kutipan" },
  { id: "callout", label: "Callout", description: "Highlight important context", keywords: "callout note info penting" },
  { id: "codeBlock", label: "Code block", description: "Insert a fenced code block", keywords: "code block kode" },
  { id: "table", label: "Table", description: "Start a two-column table", keywords: "table tabel kolom" },
  { id: "divider", label: "Divider", description: "Separate two sections", keywords: "divider separator garis" },
];

export function filterEditorBlockCommands(query: string): EditorBlockCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return editorBlockCommands;

  return editorBlockCommands
    .map((command, order) => {
      const label = command.label.toLowerCase();
      const keywords = command.keywords.toLowerCase().split(/\s+/);
      const score = label.startsWith(normalized)
        ? 0
        : keywords.some((keyword) => keyword.startsWith(normalized))
          ? 1
          : `${label} ${command.keywords}`.toLowerCase().includes(normalized)
            ? 2
            : -1;
      return { command, order, score };
    })
    .filter(({ score }) => score >= 0)
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map(({ command }) => command);
}

export function moveCommandSelection(
  currentIndex: number,
  direction: 1 | -1,
  itemCount: number,
): number {
  if (itemCount <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= itemCount) {
    return direction === 1 ? 0 : itemCount - 1;
  }
  const safeIndex = currentIndex;
  return (safeIndex + direction + itemCount) % itemCount;
}
