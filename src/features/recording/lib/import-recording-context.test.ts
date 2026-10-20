import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseImportRecordingContext, toLocalDateTimeInput } from './import-recording-context.ts';

test('preserves original meeting time and explicit local timezone through serialization', () => {
  const local = '2026-08-30T10:15';
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const context = parseImportRecordingContext(local, timezone);
  assert.equal(toLocalDateTimeInput(new Date(context.recordedAt)), local);
  assert.equal(context.timezone, timezone);
});

test('rejects missing, malformed, normalized impossible dates and invalid timezones', () => {
  for (const value of ['', '2026-02-30T10:00', '2026-13-01T10:00', '2026-01-01T25:00', 'yesterday']) {
    assert.throws(() => parseImportRecordingContext(value, 'UTC'));
  }
  assert.throws(() => parseImportRecordingContext('2026-08-30T10:00', 'invalid'));
});
