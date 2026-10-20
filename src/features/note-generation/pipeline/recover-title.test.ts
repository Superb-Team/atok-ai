import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { parseStructuredRecordingTitle, recoverRecordingTitleEvidence } from '../lib/structured-global-note.ts';

const source = 'Sales Engine mengeksplorasi TikTok Live. Content Engine mendukung multi-user. ERP mengatur proyek dan undangan.';
const response = JSON.stringify({ title: 'Sales Engine, Content Engine, dan ERP',
  title_evidence: ['Sales Engine mengeksplorasi TikTok Live.', 'Content Engine mendukung multi-user.'] });

test('title evidence rejects invented projects and non-source quotes', () => {
  assert.equal(parseStructuredRecordingTitle(response, source), 'Sales Engine, Content Engine, dan ERP');
  assert.throws(() => parseStructuredRecordingTitle(response.replace('Content Engine mendukung multi-user.', 'Content Engine selesai diluncurkan.'), source));
  assert.throws(() => parseStructuredRecordingTitle(response.replace('Sales Engine, Content Engine, dan ERP', 'Peluncuran Kubernetes Blockchain'), source));
  assert.throws(() => parseStructuredRecordingTitle(response.replace('Sales Engine, Content Engine, dan ERP', 'Catatan Rekaman'), source));
  assert.throws(() => parseStructuredRecordingTitle(response.replace('Sales Engine, Content Engine, dan ERP', 'Sales Engine Kubernetes Blockchain'), source));
  assert.throws(() => parseStructuredRecordingTitle(response.replace('Sales Engine, Content Engine, dan ERP', 'Sales Engine dan CRM'), source));
});

test('evidence repair uses original source words without accepting invented topics', () => {
  const relatedQuotes = JSON.stringify({ title: 'Sales Engine, Content Engine, dan ERP',
    title_evidence: ['A related quote that omits the title words.', 'Another ungrounded quote.'] });
  assert.throws(() => parseStructuredRecordingTitle(relatedQuotes, source));
  assert.equal(recoverRecordingTitleEvidence(relatedQuotes, source), 'Sales Engine, Content Engine, dan ERP');
  assert.throws(() => recoverRecordingTitleEvidence(relatedQuotes.replace('Sales Engine, Content Engine, dan ERP', 'Sales Engine Kubernetes Blockchain'), source));
});

test('title recovery independently repairs section-only drafts and handles provider failure', async t => {
  const server = await createServer({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } },
    server: { middlewareMode: true, hmr: false, watch: null } });
  try {
    const api: Record<string, unknown> = {};
    const { recoverRecordingTitle } = await server.ssrLoadModule('/src/features/note-generation/pipeline/recover-title.ts');
    api.getModelLimits = async () => ({ model: 'test', context_tokens: 32768, max_output_tokens: 8192 });
    const draft = '## Pembahasan Terperinci\n\n### Sales Engine\n\nSemua rincian tetap ada.';
    let calls = 0;
    api.detailedChat = async (messages: Array<{content: string}>) => {
      calls++;
      assert.equal(messages[1].content, source);
      assert.ok(messages[1].content.endsWith('ERP mengatur proyek dan undangan.'));
      return { content: response, is_truncated: false };
    };
    await t.test('missing H1 gets a grounded title without changing detail', async () => {
      assert.equal(await recoverRecordingTitle(draft, source, 'Indonesian', api), '# Sales Engine, Content Engine, dan ERP\n\n' + draft);
      assert.equal(calls, 1);
    });
    await t.test('valid title avoids another provider request', async () => {
      const titled = '# Sales Engine dan Content Engine\n\n' + draft;
      assert.equal(await recoverRecordingTitle(titled, source, 'Indonesian', api), titled);
      assert.equal(calls, 1);
    });
    await t.test('truncated and malformed responses preserve the source draft', async () => {
      api.detailedChat = async () => ({ content: response, is_truncated: true });
      assert.equal(await recoverRecordingTitle(draft, source, 'Indonesian', api), draft);
      api.detailedChat = async () => ({ content: '{}', is_truncated: false });
      assert.equal(await recoverRecordingTitle(draft, source, 'Indonesian', api), draft);
      api.detailedChat = async () => { throw new Error('offline'); };
      assert.equal(await recoverRecordingTitle(draft, source, 'Indonesian', api), draft);
    });
    await t.test('validation failure retries once, while fenced headings stay intact', async () => {
      let attempts = 0;
      api.detailedChat = async () => ({ content: ++attempts === 1 ? '{}' : response, is_truncated: false });
      const fenced = draft + '\n\n```markdown\n# Sales Engine dan Content Engine\n```';
      const result = await recoverRecordingTitle(fenced, source, 'Indonesian', api);
      assert.equal(result, '# Sales Engine, Content Engine, dan ERP\n\n' + fenced);
      assert.equal(attempts, 2);
    });
    await t.test('oversized transcript AND draft never silently truncate to the opening', async () => {
      api.detailedChat = async () => { assert.fail('oversized request'); };
      const large = 'Topic '.repeat(40000);
      assert.equal(await recoverRecordingTitle(large, large, 'Indonesian', api), large);
    });
  } finally { await server.close(); }
});
