import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const parser = unified().use(remarkParse).use(remarkGfm);

interface MarkdownNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  children?: MarkdownNode[];
  position?: {
    start: { offset?: number; line: number; column: number };
    end: { offset?: number; line: number; column: number };
  };
}

interface Edit { start: number; end: number; text: string }
interface SourceLine { start: number; text: string }

function applyEdits(source: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

function sourceLines(source: string): SourceLine[] {
  return Array.from(source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g))
    .filter(match => match[0].length > 0)
    .map(match => ({ start: match.index!, text: match[0] }));
}

function columns(text: string): number {
  let column = 0;
  for (const character of text) column += character === '\t' ? 4 - column % 4 : 1;
  return column;
}

function titleStart(node: MarkdownNode, source: string): number | undefined {
  const start = node.position?.start.offset;
  if (start === undefined) return;
  const opening = /^(?:#{1,6})[ \t]+/.exec(source.slice(start));
  return start + (opening?.[0].length ?? 0);
}

function ordinalPrefix(source: string): string {
  return /^\d{1,3}(?:\.\d{1,3})*[.)][ \t]+/.exec(source)?.[0] ?? '';
}

export function getDocumentHeading(source: string): { title: string; start: number; end: number } | null {
  const tree: MarkdownNode = parser.parse(source);
  const heading = tree.children?.find(node => node.type === 'heading' && node.depth === 1);
  const start = heading?.position?.start.offset;
  const end = heading?.position?.end.offset;
  if (!heading || start === undefined || end === undefined) return null;
  const text = (node: MarkdownNode): string => node.value ?? (node.children ?? []).map(text).join('');
  return { title: text(heading).replace(/\s+/g, ' ').trim(), start, end };
}

export function replaceDocumentHeading(source: string, title: string): string {
  const heading = getDocumentHeading(source);
  return heading
    ? source.slice(0, heading.start) + `# ${title}` + source.slice(heading.end)
    : `# ${title}\n\n${source}`;
}

export function normalizeNoteMarkdown(source: string, options: { numberHeadings?: boolean } = {}): string {
  const tree: MarkdownNode = parser.parse(source);
  const edits: Edit[] = [];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  // Document headings own the outline. Quoted/list-contained headings are content.
  for (const node of tree.children ?? []) {
    if (node.type !== 'heading') continue;
    const depth = node.depth ?? 1;
    counts.fill(0, depth + 1);
    if (depth === 1) { counts.fill(0); continue; }
    const start = titleStart(node, source);
    if (start === undefined) continue;
    const prefix = ordinalPrefix(source.slice(start));
    const emphasis = ['strong', 'emphasis'].includes(node.children?.[0]?.type ?? '')
      ? /^(?:\*\*|__|\*|_)/.exec(source.slice(start))?.[0] ?? '' : '';
    const emphasizedPrefix = emphasis ? ordinalPrefix(source.slice(start + emphasis.length)) : '';
    if (!options.numberHeadings && !prefix && !emphasizedPrefix) continue;
    counts[depth]++;
    const number = Array.from({ length: depth - 1 }, (_, index) => counts[index + 2] || 1).join('.');
    edits.push({ start, end: start + prefix.length, text: `${number}. ` });
    if (emphasizedPrefix) edits.push({ start: start + emphasis.length,
      end: start + emphasis.length + emphasizedPrefix.length, text: '' });
  }

  const lines = sourceLines(source);
  const indentation = new Map<number, number>();
  const visit = (node: MarkdownNode) => {
    if (node.type === 'list' && node.ordered) {
      (node.children ?? []).forEach((item, index) => {
        const start = item.position?.start.offset;
        if (start === undefined) return;
        const marker = /^(\d{1,9})([.)])([ \t]+|(?=\r?$))/m.exec(source.slice(start));
        if (!marker || marker.index !== 0) return;
        const number = String(index + 1);
        edits.push({ start, end: start + marker[1].length, text: number });
        const firstLine = lines[(item.position?.start.line ?? 1) - 1];
        if (!firstLine) return;
        const prefix = source.slice(firstLine.start, start);
        const originalColumn = columns(prefix + marker[0]);
        const nextColumn = columns(prefix + number + marker[2] + marker[3]);
        const delta = nextColumn - originalColumn;
        if (delta === 0) return;
        for (let line = item.position!.start.line; line < item.position!.end.line; line++) {
          const current = lines[line];
          if (!current || !current.text.trim()) continue;
          const leading = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(current.text)?.[0] ?? '';
          // Lazy continuation paragraphs need no indentation adjustment.
          if (columns(leading) >= originalColumn) indentation.set(line, (indentation.get(line) ?? 0) + delta);
        }
      });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  for (const [index, delta] of indentation) {
    if (delta === 0) continue;
    const line = lines[index];
    const prefix = /^(?:[ \t]*>[ \t]?)*/.exec(line.text)?.[0] ?? '';
    const whitespace = /^[ \t]*/.exec(line.text.slice(prefix.length))![0];
    const width = columns(prefix + whitespace) - columns(prefix);
    edits.push({ start: line.start + prefix.length, end: line.start + prefix.length + whitespace.length,
      text: ' '.repeat(Math.max(0, width + delta)) });
  }
  return applyEdits(source, edits);
}

export function normalizeDiscussionHeadings(source: string): string {
  const tree: MarkdownNode = parser.parse(source);
  const headings = (tree.children ?? []).filter(node => node.type === 'heading');
  const wrappers = new Set(headings.filter(node => {
    const start = titleStart(node, source);
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return false;
    const text = source.slice(start, end).split(/\r?\n/)[0].replace(/[ \t]+#+[ \t]*$/, '').trim();
    return /^(?:Section|Part|Bagian)[ \t]+\d+$/i.test(text);
  }));
  const topics = headings.filter(node => !wrappers.has(node));
  const shallowest = Math.min(...topics.map(node => node.depth ?? 1));
  const edits: Edit[] = [];
  for (const node of headings) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (wrappers.has(node)) {
      edits.push({ start, end, text: '' });
      continue;
    }
    const depth = Math.min(6, 3 + (node.depth ?? 1) - shallowest);
    const opening = /^#{1,6}(?=[ \t])/.exec(source.slice(start));
    if (opening) {
      edits.push({ start, end: start + opening[0].length, text: '#'.repeat(depth) });
    } else {
      const raw = source.slice(start, end);
      const underline = /\r?\n[ \t]*(?:=+|-+)[ \t]*$/.exec(raw);
      if (underline) edits.push({ start, end, text: `${'#'.repeat(depth)} ${raw.slice(0, underline.index)}` });
    }
  }
  return applyEdits(source, edits);
}
