// Backstop for the model looping near the token budget: any content line seen
// more than twice in the WHOLE document is dropped, so repetition cycles of any
// length can't survive. Headings, blanks, and asset markers/embeds are exempt.
export function collapseRepeatedLines(text: string): string {
  const MAX_REPEATS = 2;
  const counts = new Map<string, number>();
  const kept: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const exempt =
      trimmed === "" ||
      /^#{1,6}\s/.test(trimmed) ||
      trimmed.startsWith("![") ||
      trimmed.includes("[[ATOK_ASSET");
    if (exempt) {
      kept.push(line);
      continue;
    }

    const norm = trimmed.toLowerCase();
    const seen = (counts.get(norm) ?? 0) + 1;
    counts.set(norm, seen);
    if (seen <= MAX_REPEATS) kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}
