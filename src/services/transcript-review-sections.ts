export function appendTranscriptReviewSections(
  content: string,
  issues: string[],
  language: string,
): string {
  const transcriptIssues = issues.filter((issue) => !issue.startsWith("audio_quality_requires_review"));
  const captureIssues = issues.filter((issue) => issue.startsWith("audio_quality_requires_review"));
  const sections: string[] = [];
  if (transcriptIssues.length > 0) {
    sections.push(
      `## ${language === "id" ? "Perlu Verifikasi Transkrip" : "Transcript Verification Required"}\n\n${transcriptIssues.map((issue) => `- ${issue}`).join("\n")}`,
    );
  }
  if (captureIssues.length > 0) {
    sections.push(
      `## ${language === "id" ? "Kualitas Capture" : "Capture Quality"}\n\n${captureIssues.map((issue) => `- ${issue}`).join("\n")}`,
    );
  }
  return sections.length > 0 ? `${content.trimEnd()}\n\n${sections.join("\n\n")}` : content;
}
