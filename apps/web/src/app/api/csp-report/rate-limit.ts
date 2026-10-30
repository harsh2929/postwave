// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

const WINDOW_MS = 60_000;
const MAX_LOGS_PER_WINDOW = 30;
const DEDUPE_TTL_MS = 5 * 60_000;
const MAX_DEDUPE_ENTRIES = 512;

let windowStartedAt = 0;
let loggedInWindow = 0;
const recentlyLogged = new Map<string, number>();

function fingerprint(reports: Record<string, unknown>[]): string {
  return createHash("sha256").update(JSON.stringify(reports)).digest("base64url");
}

/**
 * Bounds unauthenticated CSP-report log volume and suppresses browser retries.
 * This is deliberately process-local: every instance has a hard log ceiling,
 * while the platform log sink remains the cross-instance backstop.
 */
export function shouldLogCSPReport(
  reports: Record<string, unknown>[],
  now = Date.now(),
): boolean {
  if (reports.length === 0) return false;

  if (
    windowStartedAt === 0 ||
    now < windowStartedAt ||
    now - windowStartedAt >= WINDOW_MS
  ) {
    windowStartedAt = now;
    loggedInWindow = 0;
  }

  for (const [key, loggedAt] of recentlyLogged) {
    if (now - loggedAt >= DEDUPE_TTL_MS || now < loggedAt) {
      recentlyLogged.delete(key);
    }
  }

  const key = fingerprint(reports);
  const previous = recentlyLogged.get(key);
  if (previous !== undefined && now >= previous && now - previous < DEDUPE_TTL_MS) {
    return false;
  }
  if (loggedInWindow >= MAX_LOGS_PER_WINDOW) return false;

  if (recentlyLogged.size >= MAX_DEDUPE_ENTRIES) {
    const oldest = recentlyLogged.keys().next().value as string | undefined;
    if (oldest !== undefined) recentlyLogged.delete(oldest);
  }
  recentlyLogged.set(key, now);
  loggedInWindow += 1;
  return true;
}

/** Test-only state reset; kept outside the Next route module's export surface. */
export function resetCSPReportLimiterForTests(): void {
  windowStartedAt = 0;
  loggedInWindow = 0;
  recentlyLogged.clear();
}
