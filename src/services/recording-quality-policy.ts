const ADVISORY_WARNING_PREFIXES = ["track_imbalance:", "mic_clipping_advisory:"];

export function blockingQualityWarnings(warnings: readonly string[]): string[] {
  return warnings.filter(
    (warning) => !ADVISORY_WARNING_PREFIXES.some((prefix) => warning.startsWith(prefix)),
  );
}

export function requiresCaptureReview(
  requiresReview: boolean,
  warnings: readonly string[],
): boolean {
  if (!requiresReview) return false;
  const blocking = blockingQualityWarnings(warnings);
  return warnings.length === 0 || blocking.length > 0;
}
