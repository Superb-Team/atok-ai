export function pendingRecordingContent(title: string, language: string): string {
  return language === "id"
    ? `# ${title}\n\n## Pemrosesan rekaman tertunda\n\nRekaman sudah tersimpan, tetapi transkripsinya belum selesai. Audio dan status pemrosesan tetap dipertahankan agar dapat dicoba lagi.`
    : `# ${title}\n\n## Recording processing pending\n\nThe recording was saved, but transcription did not finish. The audio and processing state were retained so it can be retried.`;
}

export function isPendingRecordingNote(note: { title: string; content?: string }, title: string, language: string): boolean {
  return note.title === title && note.content === pendingRecordingContent(title, language);
}
