// SPDX-License-Identifier: AGPL-3.0-only

export async function optionalPilotEvidence<T>(
  label: string,
  fn: () => Promise<T>,
  errors: string[],
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    errors.push(
      `${label}: ${error instanceof Error ? error.message : "request failed"}`,
    );
    return null;
  }
}

const PILOT_SOURCES = new Set(["activecampaign", "hubspot"]);

/**
 * Restrict first-customer evidence to the two explicitly supported pilot
 * sources. Other migrations remain visible as an excluded count; they must
 * never silently become the selected pilot merely because they are newer.
 */
export function scopePilotJobs<
  T extends { source: string; started_at: string },
>(
  jobs: T[],
): {
  inScope: T[];
  excluded: number;
  total: number;
} {
  const sorted = [...jobs].sort(
    (left, right) => Date.parse(right.started_at) - Date.parse(left.started_at),
  );
  const inScope = sorted.filter((job) => PILOT_SOURCES.has(job.source));
  return {
    inScope,
    excluded: sorted.length - inScope.length,
    total: sorted.length,
  };
}
