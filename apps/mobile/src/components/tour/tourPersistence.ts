/** Parse and clamp a persisted tour step to the currently available script. */
export function normalizeStoredTourStep(
  raw: string | null | undefined,
  totalSteps: number,
): number {
  if (!Number.isInteger(totalSteps) || totalSteps <= 0) return 0;
  if (raw == null || !/^\d+$/.test(raw.trim())) return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, totalSteps - 1);
}
