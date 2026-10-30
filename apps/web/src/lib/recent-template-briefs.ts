// SPDX-License-Identifier: AGPL-3.0-only
//
// Recent AI-generation briefs, persisted per-browser so an accidental close or
// a fresh session doesn't force the user to retype a long brief (TMPL-042). The
// merge/cap logic is pure and unit-tested; the localStorage wrappers are thin
// and fail closed (a corrupt/blocked store simply yields no history).

const LEGACY_RECENT_STORAGE_KEY = "postwave.template.recent-briefs";
const LEGACY_SAVED_STORAGE_KEY = "postwave.template.saved-briefs";
const STORAGE_PREFIX = "postwave.template.briefs.v2";
const MAX_RECENT_BRIEFS = 5;
const MAX_BRIEF_CHARS = 8000;

export interface TemplateBriefStorageScope {
  tenantId: string;
  userId: string;
}

type TemplateBriefStorageKind = "recent" | "saved";

function storageKey(
  scope: TemplateBriefStorageScope,
  kind: TemplateBriefStorageKind,
): string | null {
  const tenantId = scope.tenantId.trim();
  const userId = scope.userId.trim();
  if (!tenantId || !userId) return null;
  return `${STORAGE_PREFIX}:${encodeURIComponent(tenantId)}:${encodeURIComponent(
    userId,
  )}:${kind}`;
}

/**
 * Old releases stored briefs in global browser keys. There is no trustworthy
 * way to infer which signed-in user/workspace owns those values, so migration
 * deliberately fails closed and removes them instead of copying possibly
 * private text into the active account.
 */
function purgeUnscopedLegacyBriefs(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_RECENT_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_SAVED_STORAGE_KEY);
  } catch {
    /* blocked storage is already fail-closed */
  }
}

function readBriefs(
  scope: TemplateBriefStorageScope,
  kind: TemplateBriefStorageKind,
  max: number,
): string[] {
  if (typeof window === "undefined") return [];
  purgeUnscopedLegacyBriefs();
  const key = storageKey(scope, kind);
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && Boolean(entry.trim()),
      )
      .slice(0, max);
  } catch {
    return [];
  }
}

function writeBriefs(
  scope: TemplateBriefStorageScope,
  kind: TemplateBriefStorageKind,
  briefs: string[],
): string[] {
  if (typeof window === "undefined") return briefs;
  purgeUnscopedLegacyBriefs();
  const key = storageKey(scope, kind);
  if (!key) return [];
  try {
    window.localStorage.setItem(key, JSON.stringify(briefs));
  } catch {
    /* storage full / blocked — best-effort */
  }
  return briefs;
}

/**
 * Merge a new brief into the recent list: trimmed, most-recent-first,
 * case-insensitively de-duplicated, and capped. Pure so it's testable without
 * a DOM. Returns a new array; blank briefs leave the list unchanged.
 */
export function mergeRecentBrief(
  existing: readonly string[],
  brief: string,
  max = MAX_RECENT_BRIEFS,
): string[] {
  const trimmed = brief.trim().slice(0, MAX_BRIEF_CHARS);
  if (!trimmed) return [...existing].slice(0, max);
  const rest = existing.filter(
    (entry) => entry.trim().toLowerCase() !== trimmed.toLowerCase(),
  );
  return [trimmed, ...rest].slice(0, max);
}

export function readRecentTemplateBriefs(
  scope: TemplateBriefStorageScope,
): string[] {
  return readBriefs(scope, "recent", MAX_RECENT_BRIEFS);
}

export function pushRecentTemplateBrief(
  scope: TemplateBriefStorageScope,
  brief: string,
): string[] {
  const next = mergeRecentBrief(readRecentTemplateBriefs(scope), brief);
  return writeBriefs(scope, "recent", next);
}

// Saved "house-style" briefs (TMPL-042). Unlike recent briefs, these are
// pinned by the user and persist until explicitly removed (no rotation).
const MAX_SAVED_BRIEFS = 20;

export function readSavedTemplateBriefs(
  scope: TemplateBriefStorageScope,
): string[] {
  return readBriefs(scope, "saved", MAX_SAVED_BRIEFS);
}

/** Pin a brief for reuse; trimmed, case-insensitively de-duplicated, capped. */
export function saveTemplateBrief(
  scope: TemplateBriefStorageScope,
  brief: string,
): string[] {
  const trimmed = brief.trim().slice(0, MAX_BRIEF_CHARS);
  if (!trimmed) return readSavedTemplateBriefs(scope);
  const rest = readSavedTemplateBriefs(scope).filter(
    (entry) => entry.trim().toLowerCase() !== trimmed.toLowerCase(),
  );
  return writeBriefs(
    scope,
    "saved",
    [trimmed, ...rest].slice(0, MAX_SAVED_BRIEFS),
  );
}

/** Remove a pinned brief (case-insensitive match). */
export function removeSavedTemplateBrief(
  scope: TemplateBriefStorageScope,
  brief: string,
): string[] {
  const target = brief.trim().toLowerCase();
  return writeBriefs(
    scope,
    "saved",
    readSavedTemplateBriefs(scope).filter(
      (entry) => entry.trim().toLowerCase() !== target,
    ),
  );
}

/** Remove only this verified account/workspace's local brief history. */
export function clearTemplateBriefs(scope: TemplateBriefStorageScope): void {
  if (typeof window === "undefined") return;
  purgeUnscopedLegacyBriefs();
  try {
    for (const kind of ["recent", "saved"] as const) {
      const key = storageKey(scope, kind);
      if (key) window.localStorage.removeItem(key);
    }
  } catch {
    /* blocked storage is already unavailable to the next reader */
  }
}
