export interface RecordingNoteContext {
  recordedAt: string;
  timezone: string;
}

const GENERIC_TITLE_PATTERN =
  /^(?:recording|voice recording|meeting|meeting notes?|progress meeting|catatan|catatan rapat|rapat|rekaman)(?:\s*[-–—:]\s*.*)?$/iu;
const PLACEHOLDER_PATTERN =
  /\[(?:tanggal|date|main topic|topic|judul|title)\]|\{(?:tanggal|date|main topic|topic|judul|title)\}|<(?:tanggal|date|main topic|topic|judul|title)>/iu;
const CONVERSATIONAL_TITLE_PATTERN =
  /^(?:berapa|kenapa|mengapa|gimana|bagaimana|siapa|kapan|di mana|dimana|apakah|kok|nah|jadi|terus|lalu|tadi)\b/iu;
const TITLE_STOP_WORDS = new Set([
  "yang", "dan", "atau", "dari", "untuk", "pada", "dengan", "dalam", "ini", "itu",
  "the", "and", "for", "from", "with", "this", "that", "meeting", "rapat", "catatan",
  "recording", "rekaman", "progress", "progres",
]);

export function createRecordingNoteContext(now = new Date()): RecordingNoteContext {
  return {
    recordedAt: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

export function inferRecordingNoteContext(audioPath: string): RecordingNoteContext | undefined {
  const fileName = audioPath.split(/[/\\]/).pop() ?? "";
  const match = fileName.match(
    /^recording-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.mp3$/u,
  );
  if (!match) return undefined;

  const recordedAt = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  return Number.isNaN(Date.parse(recordedAt))
    ? undefined
    : { recordedAt, timezone: "UTC" };
}

export function formatRecordedDate(
  recordedAt: string,
  timezone: string,
  language: string,
): string {
  const locale = language === "id" ? "id-ID" : language || "en-US";
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: timezone,
    }).format(new Date(recordedAt));
  } catch {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(recordedAt));
  }
}

export function isUsefulGroundedTitle(value: string, transcript: string): boolean {
  const title = cleanTitleCandidate(value);
  if (title.length < 6 || title.length > 120) return false;
  if (PLACEHOLDER_PATTERN.test(title) || GENERIC_TITLE_PATTERN.test(title)) return false;
  if (CONVERSATIONAL_TITLE_PATTERN.test(title) || /[?!]\s*$/u.test(title)) return false;

  const transcriptWords = new Set(wordsIn(transcript));
  const distinctiveTitleWords = wordsIn(title).filter(
    (word) => word.length >= 4 && !TITLE_STOP_WORDS.has(word),
  );
  return distinctiveTitleWords.some((word) => transcriptWords.has(word));
}

export function deriveRecordingNoteTitle(
  enhancedText: string,
  transcript: string,
  fallbackTitle: string,
  context: RecordingNoteContext,
  language: string,
): string {
  const heading = enhancedText.match(/^#\s+(.+)$/m)?.[1] ?? "";
  const firstContentLine = enhancedText
    .split("\n")
    .map(cleanTitleCandidate)
    .find((line) => isUsefulGroundedTitle(line, transcript)) ?? "";
  const fallback = cleanTitleCandidate(fallbackTitle);
  const rawTopic = [heading, firstContentLine, fallback]
    .map(cleanTitleCandidate)
    .find((candidate) => isUsefulGroundedTitle(candidate, transcript))
    ?? (language === "id" ? "Catatan Rekaman" : "Recording Notes");
  const date = formatRecordedDate(context.recordedAt, context.timezone, language);
  const topic = rawTopic
    .replace(new RegExp(`\\s*[-–—:]\\s*${escapeRegExp(date)}\\s*$`, "iu"), "")
    .trim();

  return `${capTitle(topic)} — ${date}`;
}

export function replaceDocumentTitle(markdown: string, title: string): string {
  if (/^#\s+.+$/m.test(markdown)) {
    return markdown.replace(/^#\s+.+$/m, `# ${title}`);
  }
  return `# ${title}\n\n${markdown.trim()}`;
}

function wordsIn(value: string): string[] {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function cleanTitleCandidate(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function capTitle(value: string): string {
  if (value.length <= 90) return value;
  const truncated = value.slice(0, 90);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
