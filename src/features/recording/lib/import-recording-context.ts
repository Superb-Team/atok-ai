import type { RecordingNoteContext } from './recording-note-metadata.ts';

export function toLocalDateTimeInput(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseImportRecordingContext(value: string, timezone: string): RecordingNoteContext {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Enter the original recording date and time.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || toLocalDateTimeInput(date) !== value) {
    throw new Error('The recording date or time is invalid in your local timezone.');
  }
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  return { recordedAt: date.toISOString(), timezone };
}
