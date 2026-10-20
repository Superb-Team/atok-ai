import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { normalizeDiscussionHeadings, normalizeNoteMarkdown } from './note-markdown.ts';

const parser = unified().use(remarkParse).use(remarkGfm);

test('generated meeting outline numbers sections and topic subsections coherently without inventing content', () => {
  const source = `# Sales Engine and ERP — 2026

## 8. Ringkasan
Growth reached 12.5% with 30 participants.

## Pembahasan Terperinci
### 3. Sales Engine
Scope 2 uses 3 APIs.
#### Pipeline 2026
ERP v1.2 remains active.
### CRM dan Integrasi
Revenue target: 250 juta.

## 1) Tindak Lanjut
### **7. Penanggung Jawab**
8. Siti prepares the 2026-10-05 plan.
8. Rahmat checks [API v1.2](https://example.com/2026/1.2).

## Screenshots
[[ATOK_ASSET_12]]`;
  const expected = source
    .replace('## 8. Ringkasan', '## 1. Ringkasan')
    .replace('## Pembahasan Terperinci', '## 2. Pembahasan Terperinci')
    .replace('### 3. Sales Engine', '### 2.1. Sales Engine')
    .replace('#### Pipeline 2026', '#### 2.1.1. Pipeline 2026')
    .replace('### CRM dan Integrasi', '### 2.2. CRM dan Integrasi')
    .replace('## 1) Tindak Lanjut', '## 3. Tindak Lanjut')
    .replace('### **7. Penanggung Jawab**', '### 3.1. **Penanggung Jawab**')
    .replace('8. Siti', '1. Siti').replace('8. Rahmat', '2. Rahmat')
    .replace('## Screenshots', '## 4. Screenshots');
  assert.equal(normalizeNoteMarkdown(source, { numberHeadings: true }), expected);
  assert.equal(normalizeNoteMarkdown(expected, { numberHeadings: true }), expected);
});

test('every distinct ordered list restarts at one and nested lists remain independent', () => {
  const source = `## Details
7. First topic

   9) Nested first
   9) Nested second
4. Second topic
   - Existing bullet with 12 items.

Paragraph ends the first list.

3. New sequence
8. Next step

> 99. Quoted first
>
>     7. Nested quoted
> 7. Quoted second`;
  const result = normalizeNoteMarkdown(source);
  assert.match(result, /1\. First topic\n\n   1\) Nested first\n   2\) Nested second\n2\. Second topic/);
  assert.match(result, /1\. New sequence\n2\. Next step/);
  assert.match(result, /> 1\. Quoted first\n>\n>    1\. Nested quoted\n> 2\. Quoted second/);
  assert.ok(result.includes('- Existing bullet with 12 items.'));
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: result }));
  assert.equal((html.match(/<ol(?:>| start="1">)/g) ?? []).length, 5);
  assert.doesNotMatch(html, /start="(?:7|9|99)"/);
});

test('renumbering preserves list nesting when item ten grows its marker width', () => {
  const source = Array.from({ length: 12 }, (_, index) =>
    `1. Item ${index + 1}\n   - Evidence ${index + 1}\n\n   Continuation ${index + 1}.`).join('\n');
  const result = normalizeNoteMarkdown(source);
  const tree = parser.parse(result);
  const list = tree.children[0];
  assert.equal(list.type, 'list');
  if (list.type !== 'list') throw new Error('Expected a list');
  assert.equal(list.children.length, 12);
  assert.deepEqual(list.children[9].children.map(node => node.type), ['paragraph', 'list', 'paragraph']);
  assert.match(result, /10\. Item 10\n    - Evidence 10\n\n    Continuation 10\./);
  assert.equal(normalizeNoteMarkdown(result), result);
});

test('factual numeric content, code, GFM tables, URLs, assets and quoted headings survive verbatim', () => {
  const preserved = `## 2026. Sales Plan

\`7. literal inline code\`

\`\`\`markdown
## 7. Code heading
9. Code list
\`\`\`

    9. Indented code
    ## 4. Code heading

| Version | Count |
| --- | --- |
| 1.2 | 12 |
| 3. Step | 2026-10-05 |

![Screenshot 01:23](/tmp/image-12.png)
[[ATOK_ASSET_7]]
[Version](https://example.com/2026/1.2)

> ## 7. Quoted heading
> Scope 2 includes 3 APIs.
`;
  assert.equal(normalizeNoteMarkdown(preserved), preserved);
  const result = normalizeNoteMarkdown(preserved, { numberHeadings: true });
  assert.equal(result, preserved.replace('## 2026. Sales Plan', '## 1. 2026. Sales Plan'));
});

test('defaults fix existing ordinal headings but retain unnumbered headings and line endings', () => {
  const source = '# Meeting\r\n\r\n## Summary\r\n## 7. Topic\r\n### 9) Detail\r\n## 3. Next\r\n';
  assert.equal(normalizeNoteMarkdown(source), '# Meeting\r\n\r\n## Summary\r\n## 1. Topic\r\n### 1.1. Detail\r\n## 2. Next\r\n');
});

test('a second document title starts a new outline and heading depth gaps stay deterministic', () => {
  const source = '# One\n## Topic\n#### Detail\n# Two\n## Topic\n### Subtopic';
  assert.equal(normalizeNoteMarkdown(source, { numberHeadings: true }),
    '# One\n## 1. Topic\n#### 1.1.1. Detail\n# Two\n## 1. Topic\n### 1.1. Subtopic');
});

test('discussion composition keeps relative topic hierarchy and only removes standalone chunk wrappers', () => {
  const source = `# Bagian 7

## Sales Engine
### Pipeline
#### Metrics 2026
Scope 2 covers 3 APIs.

## CRM
### Decisions

\`\`\`markdown
# Bagian 12
## Literal source heading
\`\`\``;
  const result = normalizeDiscussionHeadings(source);
  assert.match(result, /^### Sales Engine\n#### Pipeline\n##### Metrics 2026/m);
  assert.match(result, /^### CRM\n#### Decisions/m);
  assert.ok(result.includes('Scope 2 covers 3 APIs.'));
  assert.ok(result.includes('```markdown\n# Bagian 12\n## Literal source heading\n```'));
  assert.doesNotMatch(result, /^# Bagian 7$/m);
});

test('discussion setext headings are promoted without flattening descendants or trimming code blocks', () => {
  const source = 'Topic\n=====\n\n## Detail\n\n~~~markdown\n## Raw heading\n~~~';
  assert.equal(normalizeDiscussionHeadings(source), '### Topic\n\n#### Detail\n\n~~~markdown\n## Raw heading\n~~~');
});


test('discussion helper preserves a standalone indented code block byte for byte', () => {
  const code = '    ## Literal heading\n    7. Literal list\n';
  assert.equal(normalizeDiscussionHeadings(code), code);
});
