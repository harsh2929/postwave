import {
  DESKTOP_NAV_DOMAINS,
  type DesktopNavDomain,
} from "./desktop-capabilities";
import {
  PERSISTENT_DESKTOP_SECTIONS,
  type PersistentDesktopSection,
} from "./desktop-routes";
import { registerPrivateSessionReset } from "./private-session-state";
import type { Section } from "./store";

export type NavigationRecentKind =
  | "nav"
  | "action"
  | "subscriber"
  | "campaign"
  | "list"
  | "form"
  | "template"
  | "tag"
  | "segment"
  | "suppression"
  // Search can return flow hits. Desktop ships no flows section today, so
  // serverHitToTarget drops them and none reaches a recent — but the kind
  // vocabulary should cover what a palette item CAN be, not what today's
  // routing happens to allow, or adding the section later means chasing a
  // type error through the recents store.
  | "flow"
  | "recent";

export interface NavigationRecentEntry {
  id: string;
  label: string;
  hint?: string;
  group: string;
  kind: NavigationRecentKind;
  section?: Section;
  resourceId?: string;
  at: number;
}

export interface NavigationPreferences {
  favorites: PersistentDesktopSection[];
  collapsedDomains: DesktopNavDomain[];
  sidebarCollapsed: boolean;
}

const RECENTS_KEY = "postwave.cmdk.recents.v1";
const PREFERENCES_KEY = "postwave.desktop.navigation.v1";
const RECENTS_MAX = 8;
const RECENTS_RECORD_VERSION = 2;
const DURABLE_RECENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PRIVATE_RECENT_TTL_MS = 8 * 60 * 60 * 1000;
const PRIVATE_RECENT_SCOPE_MAX = 8;
const RECENT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const RECENTS_RECORD_MAX_CHARS = 16 * 1024;
const RECENT_ID_MAX = 256;
const RECENT_LABEL_MAX = 256;
const RECENT_HINT_MAX = 512;
const RECENT_GROUP_MAX = 96;
const RECENT_RESOURCE_MAX = 256;
const SECTION_SET = new Set<PersistentDesktopSection>(
  PERSISTENT_DESKTOP_SECTIONS,
);
const DOMAIN_SET = new Set<DesktopNavDomain>(
  DESKTOP_NAV_DOMAINS.map((domain) => domain.id),
);
// Exhaustive BY CONSTRUCTION, via Record rather than a Set literal.
//
// This was `new Set<NavigationRecentKind>([...])`, which type-checks against a
// SUBSET without complaint — so when `flow` was added to the union it was not
// added here, and nothing failed. The two drifted silently for as long as they
// disagreed, and the effect was worse than the type error the union's own
// comment set out to avoid: `pushNavigationRecent` validates through this set,
// so a flow recent was rejected at write time and never appeared at all. That
// reads as a broken recents store, not as a missing entry in a list.
//
// `Record<NavigationRecentKind, true>` requires EVERY member of the union. The
// next kind added to the type fails to compile here until it is classified,
// which is the failure the union's comment intended in the first place.
const RECENT_KIND_MEMBERSHIP: Record<NavigationRecentKind, true> = {
  nav: true,
  action: true,
  subscriber: true,
  campaign: true,
  list: true,
  form: true,
  template: true,
  tag: true,
  segment: true,
  suppression: true,
  flow: true,
  recent: true,
};
const RECENT_KIND_SET = new Set<NavigationRecentKind>(
  Object.keys(RECENT_KIND_MEMBERSHIP) as NavigationRecentKind[],
);

interface DurableNavigationRecentsRecord {
  version: typeof RECENTS_RECORD_VERSION;
  savedAt: number;
  items: NavigationRecentEntry[];
}

interface PrivateRecentScope {
  items: NavigationRecentEntry[];
  touchedAt: number;
}

/** Customer-bearing entity labels and identifiers never leave this process. */
const privateRecents = new Map<string, PrivateRecentScope>();

function prunePrivateRecentScopes(now: number): void {
  for (const [scope, record] of privateRecents) {
    if (
      !recentTimestampIsCurrent(record.touchedAt, PRIVATE_RECENT_TTL_MS, now)
    ) {
      privateRecents.delete(scope);
    }
  }
  if (privateRecents.size <= PRIVATE_RECENT_SCOPE_MAX) return;
  const oldest = [...privateRecents.entries()].sort(
    ([, left], [, right]) => left.touchedAt - right.touchedAt,
  );
  for (const [scope] of oldest.slice(
    0,
    privateRecents.size - PRIVATE_RECENT_SCOPE_MAX,
  )) {
    privateRecents.delete(scope);
  }
}

export const DEFAULT_NAVIGATION_PREFERENCES: NavigationPreferences = {
  favorites: [],
  collapsedDomains: [],
  sidebarCollapsed: false,
};

function scopedKey(prefix: string, scope: string): string {
  return `${prefix}:${scope}`;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function uniqueAllowed<T>(values: readonly T[], allowed: ReadonlySet<T>): T[] {
  return [...new Set(values.filter((value) => allowed.has(value)))];
}

function isPersistentSection(
  section: Section,
): section is PersistentDesktopSection {
  return SECTION_SET.has(section as PersistentDesktopSection);
}

function isNavigationRecentEntry(
  entry: unknown,
): entry is NavigationRecentEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const recent = entry as NavigationRecentEntry;
  return (
    isBoundedString(recent.id, RECENT_ID_MAX) &&
    isBoundedString(recent.label, RECENT_LABEL_MAX) &&
    isBoundedString(recent.group, RECENT_GROUP_MAX) &&
    RECENT_KIND_SET.has(recent.kind) &&
    Number.isFinite(recent.at) &&
    recent.at >= 0 &&
    (recent.hint === undefined ||
      isBoundedString(recent.hint, RECENT_HINT_MAX)) &&
    (recent.section === undefined || isPersistentSection(recent.section)) &&
    (recent.resourceId === undefined ||
      isBoundedString(recent.resourceId, RECENT_RESOURCE_MAX))
  );
}

function recentTimestampIsCurrent(
  at: number,
  ttl: number,
  now: number,
): boolean {
  return at <= now + RECENT_FUTURE_SKEW_MS && at >= now - ttl;
}

/** Only product-owned navigation/action metadata is allowed on disk. */
function isDurableNavigationRecent(entry: NavigationRecentEntry): boolean {
  if (entry.resourceId !== undefined) return false;
  if (entry.kind === "nav") {
    return entry.section !== undefined && entry.id === `nav:${entry.section}`;
  }
  return (
    entry.kind === "action" &&
    entry.section === undefined &&
    entry.id.startsWith("action:")
  );
}

function canonicalRecentEntry(
  entry: NavigationRecentEntry,
): NavigationRecentEntry {
  return {
    id: entry.id,
    label: entry.label,
    ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
    group: entry.group,
    kind: entry.kind,
    ...(entry.section !== undefined ? { section: entry.section } : {}),
    ...(entry.resourceId !== undefined ? { resourceId: entry.resourceId } : {}),
    at: entry.at,
  };
}

function removeRecentStorageKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Optional discovery state must not block navigation.
  }
}

function writeDurableRecents(
  scope: string,
  items: NavigationRecentEntry[],
  now: number,
): void {
  const key = scopedKey(RECENTS_KEY, scope);
  if (items.length === 0) {
    removeRecentStorageKey(key);
    return;
  }
  const record: DurableNavigationRecentsRecord = {
    version: RECENTS_RECORD_VERSION,
    savedAt: now,
    items: items.slice(0, RECENTS_MAX).map(canonicalRecentEntry),
  };
  localStorage.setItem(key, JSON.stringify(record));
}

function loadDurableRecents(
  scope: string,
  now: number,
): NavigationRecentEntry[] {
  const key = scopedKey(RECENTS_KEY, scope);
  try {
    // Never migrate historical records. Old arrays could contain subscriber
    // emails, record IDs, customer labels, or searches owned by another user.
    localStorage.removeItem(RECENTS_KEY);
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    if (raw.length > RECENTS_RECORD_MAX_CHARS) {
      localStorage.removeItem(key);
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      localStorage.removeItem(key);
      return [];
    }
    const record = parsed as Partial<DurableNavigationRecentsRecord>;
    if (
      record.version !== RECENTS_RECORD_VERSION ||
      !Number.isFinite(record.savedAt) ||
      !record.savedAt ||
      !recentTimestampIsCurrent(record.savedAt, DURABLE_RECENT_TTL_MS, now) ||
      !Array.isArray(record.items)
    ) {
      localStorage.removeItem(key);
      return [];
    }
    const items = record.items
      .filter(isNavigationRecentEntry)
      .filter(isDurableNavigationRecent)
      .filter((entry) =>
        recentTimestampIsCurrent(entry.at, DURABLE_RECENT_TTL_MS, now),
      )
      .map(canonicalRecentEntry)
      .sort((left, right) => right.at - left.at)
      .slice(0, RECENTS_MAX);
    const canonical: DurableNavigationRecentsRecord = {
      version: RECENTS_RECORD_VERSION,
      savedAt: record.savedAt,
      items,
    };
    if (JSON.stringify(canonical) !== raw) {
      writeDurableRecents(scope, items, now);
    }
    return items;
  } catch {
    removeRecentStorageKey(key);
    return [];
  }
}

function loadPrivateRecents(
  scope: string,
  now: number,
): NavigationRecentEntry[] {
  prunePrivateRecentScopes(now);
  const current = privateRecents.get(scope);
  if (!current) return [];
  if (
    !recentTimestampIsCurrent(current.touchedAt, PRIVATE_RECENT_TTL_MS, now)
  ) {
    privateRecents.delete(scope);
    return [];
  }
  const items = current.items
    .filter(isNavigationRecentEntry)
    .filter((entry) => !isDurableNavigationRecent(entry))
    .filter((entry) =>
      recentTimestampIsCurrent(entry.at, PRIVATE_RECENT_TTL_MS, now),
    )
    .sort((left, right) => right.at - left.at)
    .slice(0, RECENTS_MAX);
  if (items.length === 0) privateRecents.delete(scope);
  else privateRecents.set(scope, { items, touchedAt: now });
  return items;
}

export function loadNavigationRecents(
  scope: string | null,
): NavigationRecentEntry[] {
  if (!scope) return [];
  const now = Date.now();
  const combined = [
    ...loadDurableRecents(scope, now),
    ...loadPrivateRecents(scope, now),
  ].sort((left, right) => right.at - left.at);
  const seen = new Set<string>();
  return combined
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .slice(0, RECENTS_MAX);
}

export function pushNavigationRecent(
  scope: string | null,
  entry: Omit<NavigationRecentEntry, "at">,
): void {
  if (!scope) return;
  try {
    const now = Date.now();
    const candidate: NavigationRecentEntry = { ...entry, at: now };
    if (!isNavigationRecentEntry(candidate)) return;
    if (isDurableNavigationRecent(candidate)) {
      const next = loadDurableRecents(scope, now).filter(
        (recent) => recent.id !== entry.id,
      );
      next.unshift(candidate);
      writeDurableRecents(scope, next, now);
      return;
    }
    const next = loadPrivateRecents(scope, now).filter(
      (recent) => recent.id !== entry.id,
    );
    next.unshift(candidate);
    privateRecents.set(scope, {
      items: next.slice(0, RECENTS_MAX),
      touchedAt: now,
    });
    prunePrivateRecentScopes(now);
  } catch {
    // Discovery preferences are optional; blocked storage must not block nav.
  }
}

/** Clear one identity's recents, or every identity during sign-out. */
export function clearNavigationRecents(scope?: string | null): void {
  if (scope) privateRecents.delete(scope);
  else privateRecents.clear();
  try {
    if (scope) {
      localStorage.removeItem(scopedKey(RECENTS_KEY, scope));
      return;
    }
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && (key === RECENTS_KEY || key.startsWith(`${RECENTS_KEY}:`))) {
        keys.push(key);
      }
    }
    for (const key of keys) localStorage.removeItem(key);
    localStorage.removeItem(RECENTS_KEY);
  } catch {
    // The process-local customer data was still erased above.
  }
}

export function loadNavigationPreferences(
  scope: string | null,
): NavigationPreferences {
  if (!scope) return DEFAULT_NAVIGATION_PREFERENCES;
  try {
    const raw = localStorage.getItem(scopedKey(PREFERENCES_KEY, scope));
    if (!raw) return DEFAULT_NAVIGATION_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<NavigationPreferences>;
    return {
      favorites: Array.isArray(parsed.favorites)
        ? uniqueAllowed(parsed.favorites, SECTION_SET)
        : [],
      collapsedDomains: Array.isArray(parsed.collapsedDomains)
        ? uniqueAllowed(parsed.collapsedDomains, DOMAIN_SET)
        : [],
      sidebarCollapsed: parsed.sidebarCollapsed === true,
    };
  } catch {
    return DEFAULT_NAVIGATION_PREFERENCES;
  }
}

export function saveNavigationPreferences(
  scope: string | null,
  preferences: NavigationPreferences,
): void {
  if (!scope) return;
  const sanitized: NavigationPreferences = {
    favorites: uniqueAllowed(preferences.favorites, SECTION_SET),
    collapsedDomains: uniqueAllowed(preferences.collapsedDomains, DOMAIN_SET),
    sidebarCollapsed: preferences.sidebarCollapsed,
  };
  try {
    localStorage.setItem(
      scopedKey(PREFERENCES_KEY, scope),
      JSON.stringify(sanitized),
    );
  } catch {
    // Optional preference persistence; in-memory caller state still works.
  }
}

export function recentDestinationSections(
  recents: readonly NavigationRecentEntry[],
  limit = 5,
): PersistentDesktopSection[] {
  const seen = new Set<PersistentDesktopSection>();
  const sections: PersistentDesktopSection[] = [];
  for (const recent of recents) {
    const section = recent.section;
    if (!section || !isPersistentSection(section)) continue;
    if (seen.has(section)) continue;
    seen.add(section);
    sections.push(section);
    if (sections.length >= limit) break;
  }
  return sections;
}

registerPrivateSessionReset("navigation-recents", () => {
  clearNavigationRecents();
});
