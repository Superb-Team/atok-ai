const TRANSCRIPT_HEADING = /^(#{1,6})\s+(?:Transcript Lengkap|Complete Transcript)\s*$/iu;

export function stripTranscriptSection(markdown: string): string {
  const kept: string[] = [];
  let skippedHeadingLevel: number | null = null;

  for (const line of markdown.trim().split("\n")) {
    const heading = line.match(/^(#{1,6})\s+.+?\s*$/u);
    if (skippedHeadingLevel !== null) {
      if (heading && heading[1].length <= skippedHeadingLevel) {
        skippedHeadingLevel = null;
      } else {
        continue;
      }
    }

    if (skippedHeadingLevel === null && TRANSCRIPT_HEADING.test(line.trim())) {
      skippedHeadingLevel = heading?.[1].length ?? 2;
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n").trim();
}
