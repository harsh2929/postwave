/**
 * Sequence mutations are compare-and-swap operations. A transport-level 2xx
 * is not enough to prove persistence: the server must echo the exact next
 * positive integer revision. Anything else leaves the write outcome
 * uncertain and callers must reload instead of reusing the stale token.
 */
export function confirmedNextSequenceVersion(
  candidate: unknown,
  expected: number,
): number | null {
  if (!Number.isSafeInteger(expected) || expected < 1) return null;
  if (!Number.isSafeInteger(candidate)) return null;
  const next = candidate as number;
  return next === expected + 1 ? next : null;
}

export const SEQUENCE_VERSION_CONFIRMATION_ERROR =
  "The server did not confirm the next sequence version. Reload the latest version before making another change.";
