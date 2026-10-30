/**
 * Identity-scoped, process-memory subscriber search history (SUB-085).
 *
 * Search terms can contain subscriber emails and customer data, so they are
 * never written to localStorage/sessionStorage. The small current-workspace
 * ring is reset on workspace change, sign-out, expiry, or process exit.
 */

import { registerPrivateSessionReset } from "../../lib/private-session-state";

const LEGACY_STORAGE_KEY = "pw.subscribers.recentSearches.v1";
const MAX_RECENT = 5;
const MAX_QUERY_CHARS = 256;
const SEARCH_TTL_MS = 8 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

interface RecentSubscriberSearch {
  query: string;
  at: number;
}

let activeScope: string | null = null;
let recentSearches: RecentSubscriberSearch[] = [];

function purgeLegacyPlaintext(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Continue with the process-local ring even in a hardened webview.
  }
  try {
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Continue with the process-local ring even in a hardened webview.
  }
}

function isCurrent(at: number, now: number): boolean {
  return (
    Number.isFinite(at) &&
    at <= now + FUTURE_SKEW_MS &&
    at >= now - SEARCH_TTL_MS
  );
}

function activateScope(scope: string | null, now: number): boolean {
  purgeLegacyPlaintext();
  if (!scope) {
    activeScope = null;
    recentSearches = [];
    return false;
  }
  if (activeScope !== scope) {
    // Workspace changes intentionally do not retain the previous workspace's
    // search terms, even in process memory.
    activeScope = scope;
    recentSearches = [];
  }
  recentSearches = recentSearches
    .filter((entry) => isCurrent(entry.at, now))
    .slice(0, MAX_RECENT);
  return true;
}

function normalizedQuery(query: string): string | null {
  const value = query.trim();
  if (!value || value.length > MAX_QUERY_CHARS || CONTROL_RE.test(value)) {
    return null;
  }
  return value;
}

/** Most-recent-first searches for the currently resolved identity. */
export function getRecentSubscriberSearches(scope: string | null): string[] {
  if (!activateScope(scope, Date.now())) return [];
  return recentSearches.map((entry) => entry.query);
}

/** Record a bounded query without ever serializing it to browser storage. */
export function pushRecentSubscriberSearch(
  scope: string | null,
  query: string,
): void {
  const now = Date.now();
  if (!activateScope(scope, now)) return;
  const value = normalizedQuery(query);
  if (!value) return;
  const lower = value.toLocaleLowerCase();
  recentSearches = [
    { query: value, at: now },
    ...recentSearches.filter(
      (entry) => entry.query.toLocaleLowerCase() !== lower,
    ),
  ].slice(0, MAX_RECENT);
}

/** Clear memory and any ownership-ambiguous record from older builds. */
export function clearRecentSubscriberSearches(): void {
  activeScope = null;
  recentSearches = [];
  purgeLegacyPlaintext();
}

registerPrivateSessionReset("subscriber-recent-searches", () => {
  clearRecentSubscriberSearches();
});
