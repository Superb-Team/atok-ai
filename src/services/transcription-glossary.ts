const MAX_TERMS = 1_000;
const MAX_TERM_LENGTH = 100;

export function parseTranscriptionGlossary(value: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of value.split(/[,;\n]/u)) {
    const term = raw.trim();
    if (!term) continue;
    if ([...term].length > MAX_TERM_LENGTH) {
      throw new Error(`Each glossary term must be at most ${MAX_TERM_LENGTH} characters`);
    }
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length > MAX_TERMS) {
      throw new Error(`A recording glossary supports at most ${MAX_TERMS} terms`);
    }
  }
  return terms;
}
