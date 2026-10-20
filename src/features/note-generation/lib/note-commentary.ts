const TRAILING_PARENTHETICAL = /^\(\s*(?:catatan|note|nb)\b/iu;
const ASIDE_LEAD_IN = /^\(?\s*(?:catatan|note|notes|nb|disclaimer|keterangan)\s*[:.\-—]/iu;
const ASIDE_SUBJECT = /\b(?:transkrip\w*|transcript\w*|audio|rekaman|recording)\b/iu;
const ASIDE_JUDGEMENT =
  /\b(?:kualitas|kurang|buruk|bising|terpotong|sulit|quality|poor|unclear|unintelligible|garbled|incomplete|truncated|noisy|noise)\b/iu;
// A hedge with no "Catatan:" lead-in: needs a scope word and an approximation word.
const HEDGE_ASIDE =
  /\b(?:sebagian|beberapa bagian|some parts?|portions?)\b.*\b(?:tidak jelas|kurang jelas|sulit didengar|unclear|inaudible|unintelligible|perkiraan|approximat|estimat)\b/iu;

function isQualityAside(paragraph: string): boolean {
  if (/^#{1,6}\s/u.test(paragraph) || /^[-*+>]\s/u.test(paragraph)) return false;
  if (!ASIDE_SUBJECT.test(paragraph)) return false;
  if (ASIDE_LEAD_IN.test(paragraph) && ASIDE_JUDGEMENT.test(paragraph)) return true;
  // Length-bounded so a real paragraph using these words as content is left alone.
  return paragraph.length <= 200 && HEDGE_ASIDE.test(paragraph);
}

export function stripMetaCommentary(text: string): string {
  const paragraphs = text.trimEnd().split(/\n{2,}/);
  while (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1].trim();
    if (!(TRAILING_PARENTHETICAL.test(last) && last.endsWith(")"))) break;
    paragraphs.pop();
  }

  return paragraphs
    .filter((paragraph) => !isQualityAside(paragraph.trim()))
    .join("\n\n");
}
