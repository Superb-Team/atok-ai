const MAX_KEY_POINTS = 8;
const MAX_ACTION_ITEMS = 10;

const EXTRACTIVE_FALLBACK_WARNING = /^>\s*(?:Pemformatan AI tidak tersedia|AI formatting was unavailable)\b/im;

/**
 * Detects a durable degraded note produced when the AI enhancement provider
 * was unavailable. This is intentionally based on the rendered warning, not
 * on a loose keyword search, so ordinary notes can mention formatting safely.
 */
export function isExtractiveFallbackNote(content: string | undefined): boolean {
  return typeof content === "string" && EXTRACTIVE_FALLBACK_WARNING.test(content);
}

const ACTION_PATTERN = /\b(akan|harus|perlu|target|besok|malam ini|minggu depan|dalam \d+ hari|fix|perbaiki|membuat|diminta|coba|will|must|need|target|tomorrow|next week|follow up)\b/i;
const FILLER_PATTERN = /^(?:halo|tes|oke|iya|ya|terima kasih|thank you)[.!?\s]*$|^sampai jumpa\b/i;

interface FallbackLabels {
  warning: string;
  summary: string;
  keyPoints: string;
  actionItems: string;
}

function labelsFor(language: string): FallbackLabels {
  if (language === "id") {
    return {
      warning: "Pemformatan AI tidak tersedia. Bagian di bawah dibuat secara ekstraktif: setiap poin diambil langsung dari transcript tanpa menambahkan fakta baru.",
      summary: "Ringkasan Ekstraktif",
      keyPoints: "Poin Utama",
      actionItems: "Tindak Lanjut yang Disebutkan",
    };
  }
  return {
    warning: "AI formatting was unavailable. The sections below are extractive: every point is copied directly from the transcript without adding new facts.",
    summary: "Extractive Summary",
    keyPoints: "Key Points",
    actionItems: "Mentioned Follow-ups",
  };
}

function sourceSentences(transcript: string): string[] {
  const seen = new Set<string>();
  return transcript
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20 && !FILLER_PATTERN.test(sentence))
    .filter((sentence) => {
      const normalized = sentence.toLocaleLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function takeEvenly(sentences: string[], maximum: number): string[] {
  if (sentences.length <= maximum) return sentences;
  if (maximum <= 1) return sentences.slice(0, maximum);
  const selected: string[] = [];
  for (let index = 0; index < maximum; index += 1) {
    selected.push(sentences[Math.round(index * (sentences.length - 1) / (maximum - 1))]);
  }
  return selected;
}

export function buildLosslessStructuredFallback(
  noteTitle: string,
  transcript: string,
  language: string,
): string {
  const labels = labelsFor(language);
  const sentences = sourceSentences(transcript);
  const actions = takeEvenly(sentences.filter((sentence) => ACTION_PATTERN.test(sentence)), MAX_ACTION_ITEMS);
  const actionSet = new Set(actions);
  const nonActions = sentences.filter((sentence) => !actionSet.has(sentence));
  const summaryCount = Math.min(3, Math.max(1, nonActions.length - 1));
  const summary = nonActions.slice(0, summaryCount);
  const summarySet = new Set(summary);
  const points = takeEvenly(
    nonActions.filter((sentence) => !summarySet.has(sentence)),
    MAX_KEY_POINTS,
  );

  const sections = [
    `# ${noteTitle}`,
    `> ${labels.warning}`,
  ];
  if (summary.length > 0) {
    sections.push(`## ${labels.summary}\n\n${summary.join(" ")}`);
  }
  if (points.length > 0) {
    sections.push(`## ${labels.keyPoints}\n\n${points.map((point) => `- ${point}`).join("\n")}`);
  }
  if (actions.length > 0) {
    sections.push(`## ${labels.actionItems}\n\n${actions.map((action) => `- ${action}`).join("\n")}`);
  }
  return sections.join("\n\n");
}
