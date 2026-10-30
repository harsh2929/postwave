// SPDX-License-Identifier: AGPL-3.0-only
//
// Most-recently-visited in-app destinations for the command palette's "Recent"
// group (SHELL-032). We record only visited /app *routes* — never raw search
// text — to respect the palette's deliberate identity-hygiene choice (search
// hits are ephemeral and never persisted). The list is tenant-scoped in the
// storage key so it can't bleed across workspaces on a shared browser, and it
// is capped so it stays a fast path, not a history log.

const MAX_RECENT = 6;
const KEY_PREFIX = "pw:recent-destinations:";

export interface RecentDestination {
  href: string;
  label: string;
}

function storageKey(tenantId: string): string {
  return `${KEY_PREFIX}${tenantId || "anon"}`;
}

function safeRead(tenantId: string): RecentDestination[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(tenantId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (d): d is RecentDestination =>
          !!d &&
          typeof d.href === "string" &&
          typeof d.label === "string" &&
          d.href.startsWith("/app"),
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function readRecentDestinations(tenantId: string): RecentDestination[] {
  return safeRead(tenantId);
}

/**
 * Record a visit. Dedupes by href (case-sensitive path), moves the entry to the
 * front, and trims to MAX_RECENT. A no-op under SSR / on write failure.
 */
export function recordRecentDestination(
  tenantId: string,
  entry: RecentDestination,
): void {
  if (typeof window === "undefined") return;
  if (!entry.href.startsWith("/app")) return;
  try {
    const existing = safeRead(tenantId).filter((d) => d.href !== entry.href);
    const next = [entry, ...existing].slice(0, MAX_RECENT);
    window.localStorage.setItem(storageKey(tenantId), JSON.stringify(next));
  } catch {
    // Best-effort: a full/blocked localStorage must never break navigation.
  }
}
