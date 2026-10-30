/**
 * CommandPalette — the ⌘K workspace launcher.
 *
 * Surfaces four content kinds in one ranked list:
 *
 *   1. Navigation — every sidebar destination
 *   2. Actions   — quick commands ("New campaign", "Toggle theme", …)
 *   3. Entities  — subscribers / campaigns / lists / forms / templates,
 *                  fetched in parallel when the query is non-trivial
 *   4. Recents   — last 8 things the operator opened (safe destinations and
 *                  actions survive restart; customer entities stay in memory)
 *
 * Category prefixes route the query at parse-time so power users can
 * narrow before they type:
 *
 *   >foo  →  Actions only
 *   @foo  →  Subscribers only
 *   #foo  →  Lists + tags
 *   /foo  →  Navigation only
 *
 * Without a prefix the palette searches every kind in parallel and
 * ranks results with `rankFuzzy` (prefix > word-start > substring >
 * subsequence). Empty query shows Recents + Suggested.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject,
  type SVGProps,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type GlobalSearchResult,
  api,
  listCampaignTemplatesWithQuery,
  listCampaignsWithQuery,
  listListsWithQuery,
  searchApi,
} from "../lib/api-client";
import { serverHitToTarget, serverHitVisible } from "./command-palette-helpers";
import { useAuditScopes } from "../lib/auditScopes";
import { resolveCapabilityAccess } from "../lib/capability-access";
import {
  getCapabilityObservation,
  useCapabilityObservationsRevision,
} from "../lib/capability-observations";
import { useDialogStack } from "../hooks/useDialogStack";
import {
  isolateDialogBackground,
  lockDocumentBodyScroll,
} from "../lib/dialog-accessibility";
import {
  desktopRouteIdentityScope,
  navigateDesktopRoute,
  navigateDesktopSectionResource,
} from "../lib/desktop-router";
import {
  DESKTOP_TASK_COMMANDS,
  desktopTaskIntentRoute,
  type DesktopTaskIntent,
} from "../lib/desktop-task-intents";
import {
  capabilityForSection,
  DESKTOP_NAV_DOMAINS,
} from "../lib/desktop-capabilities";
import { COMMAND_PALETTE_NAV_TARGETS } from "../lib/desktop-routes";
import {
  formatShortcutBinding,
  loadShortcutPreferences,
  shortcutBindingFor,
  shortcutForSection,
  subscribeShortcutPreferences,
} from "../lib/desktop-shortcuts";
import {
  loadNavigationRecents,
  pushNavigationRecent,
  type NavigationRecentEntry,
  type NavigationRecentKind,
} from "../lib/navigation-preferences";
import {
  SETTINGS_INFORMATION_ARCHITECTURE,
  settingsCategoryLabel,
} from "../lib/settings-information-architecture";
import { useOnline } from "../lib/online-manager";
import { pushDialog, popDialog, topDialog } from "../lib/dialogStack";
import { toast } from "./Toast";
import {
  canWrite,
  signOut,
  setCommandOpen,
  setSection,
  setTheme,
  toggleTheme,
  useCommandOpen,
  useMe,
  useRole,
  useRoleStatus,
  useTheme,
  type Role,
  type RoleStatus,
} from "../lib/store";

/* ---------- types ------------------------------------------------- */

type ItemKind = NavigationRecentKind;

interface Item {
  id: string;
  label: string;
  /** Secondary text shown muted on the right (e.g. campaign status, list size). */
  hint?: string;
  /** Additional non-rendered discovery terms used only for local ranking. */
  searchText?: string;
  group: string;
  kind: ItemKind;
  /** Keyboard shortcut chip rendered after the label (e.g. "⌘1"). */
  kbd?: string;
  run: () => void;
}

const SETTINGS_NAVIGATION_ITEMS: readonly Item[] =
  SETTINGS_INFORMATION_ARCHITECTURE.map((item) => ({
    id: `settings:${item.anchor}`,
    label: item.label,
    hint: settingsCategoryLabel(item.category),
    searchText: `${item.summary} ${item.keywords.join(" ")}`,
    group: `Settings · ${settingsCategoryLabel(item.category)}`,
    kind: "nav",
    run: () => {
      navigateDesktopRoute({
        section: "settings",
        settingsAnchor: item.anchor,
      });
      setCommandOpen(false);
    },
  }));

function dispatchDesktopTask(
  intent: DesktopTaskIntent,
  role: Role | null,
  roleStatus: RoleStatus,
): void {
  if (roleStatus === "loading") {
    toast.info("Your workspace role is still loading. Try the task again.");
  } else if (roleStatus !== "resolved" || !canWrite(role)) {
    toast.error("A write role is required to start this task.");
  } else {
    navigateDesktopRoute(desktopTaskIntentRoute(intent));
  }
  setCommandOpen(false);
}

type RecentEntry = NavigationRecentEntry;

/* ---------- icons (per-kind for visual scanning) ------------------ */

const iconProps: SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

const ArrowIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M5 12h14m-6-6 6 6-6 6" />
  </svg>
);
const BoltIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M13 3 4 14h7l-1 7 9-11h-7z" />
  </svg>
);
const PersonIcon = (): ReactElement => (
  <svg {...iconProps}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);
const MailIcon = (): ReactElement => (
  <svg {...iconProps}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </svg>
);
const ListIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </svg>
);
const FormIcon = (): ReactElement => (
  <svg {...iconProps}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8 9h8M8 13h8M8 17h5" />
  </svg>
);
const TemplateIcon = (): ReactElement => (
  <svg {...iconProps}>
    <rect x="4" y="4" width="16" height="6" rx="1" />
    <rect x="4" y="12" width="7" height="8" rx="1" />
    <rect x="13" y="12" width="7" height="8" rx="1" />
  </svg>
);
const TagIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M3 12V4h8l10 10-8 8z" />
    <circle cx="7" cy="8" r="1.5" />
  </svg>
);
const ClockIcon = (): ReactElement => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5l3 2" />
  </svg>
);
// #59 server-search kinds: funnel for segments (mirrors the Sidebar's
// IconFunnel), shield for suppressions (mirrors IconShield).
const FunnelIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M3 5h18l-7 9v6l-4-2v-4z" />
  </svg>
);
const ShieldIcon = (): ReactElement => (
  <svg {...iconProps}>
    <path d="M12 3 4 6v6c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9V6z" />
  </svg>
);

function iconFor(kind: ItemKind): ReactElement {
  switch (kind) {
    case "action":
      return <BoltIcon />;
    case "subscriber":
      return <PersonIcon />;
    case "campaign":
      return <MailIcon />;
    case "list":
      return <ListIcon />;
    case "form":
      return <FormIcon />;
    case "template":
      return <TemplateIcon />;
    case "tag":
      return <TagIcon />;
    case "segment":
      return <FunnelIcon />;
    case "suppression":
      return <ShieldIcon />;
    case "recent":
      return <ClockIcon />;
    case "nav":
    default:
      return <ArrowIcon />;
  }
}

/* ---------- ranking ------------------------------------------------ */

/**
 * Score a query against a target string. Lower = better. -1 = no match.
 *
 *   0..99       exact prefix       ("camp" vs "Campaigns")
 *   100..299    word-start         ("camp" vs "New campaign")
 *   300..999    substring          ("amp"  vs "Campaigns")
 *   1000+       loose subsequence  ("cmp"  vs "Campaigns")
 *
 * Stable within each band so equal-quality matches keep their insertion
 * order (used for "Recents at the top" semantics).
 */
function rankFuzzy(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.startsWith(q)) return q.length;
  // word-start: "/-_ " boundaries
  const words = t.split(/[\s/_\-.]+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (w.startsWith(q)) return 100 + i * 10 + q.length;
  }
  const idx = t.indexOf(q);
  if (idx >= 0) return 300 + idx;
  let qi = 0;
  let lastHit = -1;
  let gap = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (lastHit >= 0) gap += i - lastHit - 1;
      lastHit = i;
      qi++;
    }
  }
  if (qi !== q.length) return -1;
  return 1000 + gap;
}

function optionalPaletteRank(
  query: string,
  target: string | undefined,
  offset: number,
): number {
  if (!target) return Infinity;
  const score = rankFuzzy(query, target);
  return score < 0 ? Infinity : score + offset;
}

function filterRankedPaletteItems(
  items: readonly Item[],
  text: string,
): Item[] {
  const scored: Array<{ item: Item; score: number; order: number }> = [];
  // Server-fetched entities remain visible when a non-rendered server field
  // matched. Navigation/actions must match one of their local discovery fields.
  const unrankedEntities: Item[] = [];
  items.forEach((item, order) => {
    const score = Math.min(
      optionalPaletteRank(text, item.label, 0),
      optionalPaletteRank(text, item.hint, 50),
      optionalPaletteRank(text, item.searchText, 100),
    );
    if (score !== Infinity) scored.push({ item, score, order });
    else if (
      item.kind !== "nav" &&
      item.kind !== "action" &&
      item.kind !== "recent"
    ) {
      unrankedEntities.push(item);
    }
  });
  scored.sort(
    (left, right) => left.score - right.score || left.order - right.order,
  );
  return [...scored.map((match) => match.item), ...unrankedEntities].slice(
    0,
    60,
  );
}

/* ---------- recents (safe durable + private process memory) -------- */

const loadRecents = loadNavigationRecents;
const pushRecent = pushNavigationRecent;

/* ---------- entity cache ------------------------------------------- */

const ENTITY_CACHE_TTL_MS = 60 * 1000;

interface EntityCacheEntry<T> {
  at: number;
  data: T;
}

type EntityCache = {
  subscribers: Map<
    string,
    EntityCacheEntry<Array<{ email: string; id?: string }>>
  >;
  campaigns: Map<
    string,
    EntityCacheEntry<
      Array<{ id: string; name: string; subject?: string; status?: string }>
    >
  >;
  lists: Map<string, EntityCacheEntry<Array<{ id: string; name: string }>>>;
  forms: Map<
    string,
    EntityCacheEntry<Array<{ id: string; name: string; slug: string }>>
  >;
  templates: Map<string, EntityCacheEntry<Array<{ id: string; name: string }>>>;
  tags: Map<string, EntityCacheEntry<Array<{ id: string; name: string }>>>;
  server: Map<string, EntityCacheEntry<GlobalSearchResult[]>>;
};

function makeCache(): EntityCache {
  return {
    subscribers: new Map(),
    campaigns: new Map(),
    lists: new Map(),
    forms: new Map(),
    templates: new Map(),
    tags: new Map(),
    server: new Map(),
  };
}

function readCache<T>(
  map: Map<string, EntityCacheEntry<T>>,
  key: string,
): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ENTITY_CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return hit.data;
}

/**
 * Prefix-reuse read: exact hit first, otherwise find the longest cached
 * key that is a prefix of `key` and narrow that response locally with
 * `matches`. A server response for "newsl" is a superset of the hits
 * for "newsle" (modulo server result caps), so the narrower query can
 * be answered without refetching the list endpoints.
 */
function readCacheByPrefix<T>(
  map: Map<string, EntityCacheEntry<T[]>>,
  key: string,
  matches: (row: T, q: string) => boolean,
): T[] | null {
  const exact = readCache(map, key);
  if (exact) return exact;
  let bestKey: string | null = null;
  for (const k of map.keys()) {
    if (
      k !== key &&
      key.startsWith(k) &&
      (bestKey === null || k.length > bestKey.length)
    ) {
      bestKey = k;
    }
  }
  if (bestKey === null) return null;
  const base = readCache(map, bestKey);
  if (!base) return null;
  return base.filter((row) => matches(row, key));
}

function writeCache<T>(
  map: Map<string, EntityCacheEntry<T>>,
  key: string,
  data: T,
): void {
  map.set(key, { at: Date.now(), data });
  // Bound the cache so heavy typers don't grow it unbounded.
  if (map.size > 32) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
}

/* ---------- entity fetch (parallel) -------------------------------- */

interface EntityHits {
  subscribers: Array<{ email: string }>;
  campaigns: Array<{
    id: string;
    name: string;
    subject?: string;
    status?: string;
  }>;
  lists: Array<{ id: string; name: string }>;
  forms: Array<{ id: string; name: string; slug: string }>;
  templates: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  /** #59 — hits from the server-side global search (/api/v1/search). */
  server: GlobalSearchResult[];
}

const EMPTY_HITS: EntityHits = {
  subscribers: [],
  campaigns: [],
  lists: [],
  forms: [],
  templates: [],
  tags: [],
  server: [],
};

/**
 * Fetch up to N hits per category for a query. Every wrapper is
 * tolerant of the multiple shapes the API returns (`{items}`,
 * `{results}`, bare arrays). Failures resolve to [] so a misbehaving
 * endpoint never blanks the whole palette.
 */
async function fetchEntities(
  q: string,
  cats: ReadonlySet<keyof EntityHits>,
  cache: EntityCache,
  signal?: AbortSignal,
): Promise<EntityHits> {
  const trimmed = q.trim();
  if (!trimmed) return EMPTY_HITS;

  type Maybe<T> = T | null | undefined;
  const unwrap = <T,>(d: unknown): T[] => {
    if (Array.isArray(d)) return d as T[];
    const r = d as Maybe<{ items?: T[]; results?: T[]; data?: T[] }>;
    return r?.items ?? r?.results ?? r?.data ?? [];
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- defensive parsing of varied shapes
  const safe = async <T,>(
    p: Promise<{ data?: any; error?: unknown }>,
  ): Promise<T[]> => {
    try {
      const r = await p;
      if (r.error || r.data === undefined) return [];
      return unwrap<T>(r.data);
    } catch {
      return [];
    }
  };

  // Local narrowing predicates for prefix-cache reuse — match on the
  // same fields the palette renders so a row that survived the server
  // search for a prefix stays visible while it still matches locally.
  const byEmail = (r: { email: string }, q: string): boolean =>
    rankFuzzy(q, r.email) >= 0;
  const byName = (r: { name?: string }, q: string): boolean =>
    rankFuzzy(q, String(r.name ?? "")) >= 0;
  const byCampaign = (
    r: { name: string; subject?: string },
    q: string,
  ): boolean => rankFuzzy(q, r.name) >= 0 || rankFuzzy(q, r.subject ?? "") >= 0;
  const byForm = (r: { name: string; slug: string }, q: string): boolean =>
    rankFuzzy(q, r.name) >= 0 || rankFuzzy(q, r.slug) >= 0;

  const subsPromise = cats.has("subscribers")
    ? (readCacheByPrefix(cache.subscribers, trimmed, byEmail) ??
      safe<{ email: string }>(api.listSubscribers({ query: trimmed })))
    : Promise.resolve([]);
  const campsPromise = cats.has("campaigns")
    ? (readCacheByPrefix(cache.campaigns, trimmed, byCampaign) ??
      safe<{ id: string; name: string; subject?: string; status?: string }>(
        listCampaignsWithQuery({ query: trimmed }),
      ))
    : Promise.resolve([]);
  const listsPromise = cats.has("lists")
    ? (readCacheByPrefix(cache.lists, trimmed, byName) ??
      safe<{ id: string; name: string }>(
        listListsWithQuery({ query: trimmed }),
      ))
    : Promise.resolve([]);
  // Forms + tags don't have dedicated query endpoints (small surfaces,
  // <500 rows), so we list everything and filter locally. Templates
  // does support `?query=`.
  const formsPromise = cats.has("forms")
    ? (readCacheByPrefix(cache.forms, trimmed, byForm) ??
      safe<{ id: string; name: string; slug: string }>(api.listForms()))
    : Promise.resolve([]);
  const tmplsPromise = cats.has("templates")
    ? (readCacheByPrefix(cache.templates, trimmed, byName) ??
      safe<{ id: string; name: string }>(
        listCampaignTemplatesWithQuery({ query: trimmed }),
      ))
    : Promise.resolve([]);
  const tagsPromise = cats.has("tags")
    ? (readCacheByPrefix(cache.tags, trimmed, byName) ??
      safe<{ id: string; name: string }>(api.listTags()))
    : Promise.resolve([]);
  // #59 — server-side global search runs in parallel with the per-type
  // fetches above and degrades silently: `safe()` resolves to [] on any
  // error so a missing/broken /search endpoint just means the palette
  // lacks that source. (`unwrap` picks the rows out of `{results}`.)
  // The wrapper threads `signal` so a superseded keystroke aborts the
  // in-flight request instead of letting it finish and get discarded.
  const byServer = (r: GlobalSearchResult, q: string): boolean =>
    rankFuzzy(q, r.title) >= 0 || rankFuzzy(q, r.detail ?? "") >= 0;
  const serverPromise = cats.has("server")
    ? (readCacheByPrefix(cache.server, trimmed, byServer) ??
      safe<GlobalSearchResult>(
        searchApi.global(trimmed, { limit: 10, signal }),
      ))
    : Promise.resolve([]);

  const [subs, camps, lists, forms, tmpls, tags, server] = await Promise.all([
    subsPromise,
    campsPromise,
    listsPromise,
    formsPromise,
    tmplsPromise,
    tagsPromise,
    serverPromise,
  ]);

  // Cache under the exact query — whether it came off the wire or was
  // narrowed from a shorter cached prefix — so the next keystroke
  // ("newsl" → "newsle" → "newslet") keeps chaining off cached data
  // instead of refetching the list endpoints.
  if (cats.has("subscribers")) writeCache(cache.subscribers, trimmed, subs);
  if (cats.has("campaigns")) writeCache(cache.campaigns, trimmed, camps);
  if (cats.has("lists")) writeCache(cache.lists, trimmed, lists);
  if (cats.has("forms")) writeCache(cache.forms, trimmed, forms);
  if (cats.has("templates")) writeCache(cache.templates, trimmed, tmpls);
  if (cats.has("tags")) writeCache(cache.tags, trimmed, tags);
  // An aborted /search resolves [] via `safe()` — don't cache that as
  // "no results" for this query (the cache TTL is a full minute).
  if (cats.has("server") && !signal?.aborted)
    writeCache(cache.server, trimmed, server);

  // Forms + tags hit list-all endpoints — filter locally before
  // yielding so we don't dump 200 rows into the palette. Templates
  // is already filtered server-side.
  const localFilter = <T extends { name?: string }>(rows: T[]): T[] => {
    return rows
      .filter((r) => rankFuzzy(trimmed, String(r.name ?? "")) >= 0)
      .slice(0, 5);
  };

  return {
    subscribers: subs.slice(0, 5),
    campaigns: camps.slice(0, 5),
    lists: lists.slice(0, 5),
    forms: localFilter(forms),
    templates: tmpls.slice(0, 5),
    tags: localFilter(tags),
    server: server.slice(0, 10),
  };
}

/* ---------- prefix routing ---------------------------------------- */

interface ParsedQuery {
  /** Categories enabled for this search. */
  cats: ReadonlySet<keyof EntityHits | "actions" | "nav">;
  /** The actual text to match (prefix character stripped). */
  text: string;
  /** The leading prefix character that was consumed, if any. */
  prefix: "" | ">" | "@" | "#" | "/";
}

const ALL_CATS = new Set<keyof EntityHits | "actions" | "nav">([
  "subscribers",
  "campaigns",
  "lists",
  "forms",
  "templates",
  "tags",
  "actions",
  "nav",
]);

function parseQuery(raw: string): ParsedQuery {
  if (raw.startsWith(">")) {
    return {
      cats: new Set(["actions"]),
      text: raw.slice(1).trim(),
      prefix: ">",
    };
  }
  if (raw.startsWith("@")) {
    return {
      cats: new Set(["subscribers"]),
      text: raw.slice(1).trim(),
      prefix: "@",
    };
  }
  if (raw.startsWith("#")) {
    return {
      cats: new Set(["lists", "tags"]),
      text: raw.slice(1).trim(),
      prefix: "#",
    };
  }
  if (raw.startsWith("/")) {
    return { cats: new Set(["nav"]), text: raw.slice(1).trim(), prefix: "/" };
  }
  return { cats: ALL_CATS, text: raw.trim(), prefix: "" };
}

interface PaletteBuildContext {
  audit: ReturnType<typeof useAuditScopes>;
  hits: EntityHits;
  online: ReturnType<typeof useOnline>;
  parsed: ParsedQuery;
  recentScope: ReturnType<typeof desktopRouteIdentityScope>;
  role: Role | null;
  roleStatus: RoleStatus;
  shortcutPreferences: ReturnType<typeof loadShortcutPreferences>;
  theme: ReturnType<typeof useTheme>;
}

function buildNavigationItems(context: PaletteBuildContext): Item[] {
  if (!context.parsed.cats.has("nav")) return [];
  const items: Item[] = [];
  for (const target of COMMAND_PALETTE_NAV_TARGETS) {
    const shortcut = shortcutForSection(target.section);
    const capability = capabilityForSection(target.section);
    const domain = DESKTOP_NAV_DOMAINS.find(
      (candidate) => candidate.id === capability.domain,
    );
    const navigationGroup = domain?.label ?? "Workspace";
    const access = resolveCapabilityAccess(target.section, {
      role: context.role,
      roleStatus: context.roleStatus,
      online: context.online,
      audit: {
        loading: context.audit.loading,
        isAdmin: context.audit.isAdmin,
        scopes: context.audit.scopes,
        error: context.audit.error,
      },
      observation: getCapabilityObservation(
        context.recentScope,
        target.section,
      ),
    });
    items.push({
      id: `nav:${target.section}`,
      label: target.label,
      hint: access.label ?? undefined,
      group: `Navigation · ${navigationGroup}`,
      kind: "nav",
      kbd: shortcut
        ? formatShortcutBinding(
            shortcutBindingFor(shortcut, context.shortcutPreferences),
          )
        : undefined,
      run: () => {
        pushRecent(context.recentScope, {
          id: `nav:${target.section}`,
          label: target.label,
          group: `Navigation · ${navigationGroup}`,
          kind: "nav",
          section: target.section,
        });
        setSection(target.section);
        setCommandOpen(false);
      },
    });
  }
  return [...items, ...SETTINGS_NAVIGATION_ITEMS];
}

function buildActionItems(context: PaletteBuildContext): Item[] {
  if (!context.parsed.cats.has("actions")) return [];
  const actions: Array<Omit<Item, "id" | "kind" | "group">> = [
    ...DESKTOP_TASK_COMMANDS.map(({ intent, label, hint }) => ({
      label,
      hint,
      run: () => dispatchDesktopTask(intent, context.role, context.roleStatus),
    })),
    {
      label: "View plan & usage",
      hint: "Limits, projected sends, no surprises",
      run: () => {
        navigateDesktopRoute({
          section: "settings",
          settingsAnchor: "usage",
        });
        setCommandOpen(false);
      },
    },
    {
      label: "Export all my data",
      hint: "Portable ZIP — no lock-in",
      run: () => {
        navigateDesktopRoute({
          section: "settings",
          settingsAnchor: "data-exports",
        });
        setCommandOpen(false);
      },
    },
    {
      label:
        context.theme === "dark"
          ? "Switch to light theme"
          : "Switch to dark theme",
      run: () => {
        toggleTheme();
        setCommandOpen(false);
      },
    },
    {
      label: "Force light theme",
      run: () => {
        setTheme("light");
        setCommandOpen(false);
      },
    },
    {
      label: "Force dark theme",
      run: () => {
        setTheme("dark");
        setCommandOpen(false);
      },
    },
    {
      label: "Test API connection",
      hint: "Pings /health",
      run: () => {
        setCommandOpen(false);
        void api.health().then((response) => {
          if (response.error) {
            toast.error(`API connection failed: ${response.error.message}`);
          } else {
            toast.success("API connection OK");
          }
        });
      },
    },
    {
      label: "Sign out · Reset workspace",
      hint: "Clears the API key",
      run: () => {
        setCommandOpen(false);
        void signOut();
      },
    },
  ];
  return actions.map((action) => {
    const id = `action:${action.label}`;
    return {
      id,
      ...action,
      kind: "action",
      group: "Actions",
      run: () => {
        pushRecent(context.recentScope, {
          id,
          label: action.label,
          hint: action.hint,
          group: "Actions",
          kind: "action",
        });
        action.run();
      },
    };
  });
}

type LocalRecordSection =
  | "subscribers"
  | "campaigns"
  | "lists"
  | "forms"
  | "templates"
  | "tags";

interface LocalRecordItem {
  group: string;
  hint?: string;
  id: string;
  kind: ItemKind;
  label: string;
  resourceId: string;
  section: LocalRecordSection;
}

function localRecordPaletteItem(
  record: LocalRecordItem,
  recentScope: ReturnType<typeof desktopRouteIdentityScope>,
): Item {
  return {
    id: record.id,
    label: record.label,
    hint: record.hint,
    group: record.group,
    kind: record.kind,
    run: () => {
      pushRecent(recentScope, {
        id: record.id,
        label: record.label,
        hint: record.hint,
        group: record.group,
        kind: record.kind,
        section: record.section,
        resourceId: record.resourceId,
      });
      navigateDesktopSectionResource(record.section, record.resourceId);
      setCommandOpen(false);
    },
  };
}

function buildLocalRecordItems(context: PaletteBuildContext): Item[] {
  const { cats } = context.parsed;
  const records: LocalRecordItem[] = [];
  if (cats.has("subscribers")) {
    records.push(
      ...context.hits.subscribers.map((subscriber) => ({
        id: `subscriber:${subscriber.email}`,
        label: subscriber.email,
        group: "Subscribers",
        kind: "subscriber" as const,
        section: "subscribers" as const,
        resourceId: subscriber.email,
      })),
    );
  }
  if (cats.has("campaigns")) {
    records.push(
      ...context.hits.campaigns.map((campaign) => ({
        id: `campaign:${campaign.id}`,
        label: campaign.name || campaign.subject || campaign.id,
        hint: campaign.status,
        group: "Campaigns",
        kind: "campaign" as const,
        section: "campaigns" as const,
        resourceId: String(campaign.id),
      })),
    );
  }
  if (cats.has("lists")) {
    records.push(
      ...context.hits.lists.map((list) => ({
        id: `list:${list.id}`,
        label: list.name,
        group: "Lists",
        kind: "list" as const,
        section: "lists" as const,
        resourceId: String(list.id),
      })),
    );
  }
  if (cats.has("forms")) {
    records.push(
      ...context.hits.forms.map((form) => ({
        id: `form:${form.id}`,
        label: form.name,
        hint: `/${form.slug}`,
        group: "Forms",
        kind: "form" as const,
        section: "forms" as const,
        resourceId: String(form.id),
      })),
    );
  }
  if (cats.has("templates")) {
    records.push(
      ...context.hits.templates.map((template) => ({
        id: `template:${template.id}`,
        label: template.name,
        group: "Templates",
        kind: "template" as const,
        section: "templates" as const,
        resourceId: String(template.id),
      })),
    );
  }
  if (cats.has("tags")) {
    records.push(
      ...context.hits.tags.map((tag) => ({
        id: `tag:${tag.id}`,
        label: tag.name,
        group: "Tags",
        kind: "tag" as const,
        section: "tags" as const,
        resourceId: String(tag.id),
      })),
    );
  }
  return records.map((record) =>
    localRecordPaletteItem(record, context.recentScope),
  );
}

function appendServerRecordItems(
  items: Item[],
  context: PaletteBuildContext,
): void {
  const seen = new Set(items.map((item) => item.id));
  for (const hit of context.hits.server) {
    const target = serverHitToTarget(hit);
    if (!target || !serverHitVisible(target.kind, context.parsed.cats))
      continue;
    if (
      seen.has(target.itemId) ||
      target.aliasIds.some((alias) => seen.has(alias))
    ) {
      continue;
    }
    seen.add(target.itemId);
    items.push({
      id: target.itemId,
      label: hit.title,
      hint: hit.detail,
      group: target.group,
      kind: target.kind,
      run: () => {
        pushRecent(context.recentScope, {
          id: target.itemId,
          label: hit.title,
          hint: hit.detail,
          group: target.group,
          kind: target.kind,
          section: target.section,
          ...(target.targetId !== null ? { resourceId: target.targetId } : {}),
        });
        if (target.targetId !== null) {
          navigateDesktopSectionResource(target.section, target.targetId);
        } else {
          setSection(target.section);
        }
        setCommandOpen(false);
      },
    });
  }
}

function buildPaletteItems(context: PaletteBuildContext): Item[] {
  const items = [
    ...buildNavigationItems(context),
    ...buildActionItems(context),
    ...buildLocalRecordItems(context),
  ];
  appendServerRecordItems(items, context);
  return items;
}

function commandPlaceholder(prefix: ParsedQuery["prefix"]): string {
  if (prefix === ">") return "Search actions…";
  if (prefix === "@") return "Search subscribers by email…";
  if (prefix === "#") return "Search lists & tags…";
  if (prefix === "/") return "Navigate to…";
  return "Type a command, page, or > @ # / for filters…";
}

interface CommandPaletteDialogProps {
  active: number;
  dialogRef: RefObject<HTMLDivElement | null>;
  filtered: readonly Item[];
  inputRef: RefObject<HTMLInputElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  listboxId: string;
  parsed: ParsedQuery;
  query: string;
  searching: boolean;
  onActive: (index: number) => void;
  onClose: () => void;
  onInputKey: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onQuery: (value: string) => void;
}

function CommandPaletteDialog({
  active,
  dialogRef,
  filtered,
  inputRef,
  listRef,
  listboxId,
  parsed,
  query,
  searching,
  onActive,
  onClose,
  onInputKey,
  onQuery,
}: CommandPaletteDialogProps): ReactElement {
  let lastGroup = "";
  const resultCount = `${filtered.length} result${filtered.length === 1 ? "" : "s"}`;
  return (
    <div
      className="cmdk-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="cmdk-input-wrap">
          <span className="cmdk-input-icon" aria-hidden>
            <svg {...iconProps}>
              <circle cx="11" cy="11" r="6.5" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="cmdk-input"
            aria-label="Search commands"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={
              filtered[active] ? `${listboxId}-option-${active}` : undefined
            }
            placeholder={commandPlaceholder(parsed.prefix)}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={onInputKey}
          />
          {searching ? <span className="cmdk-spinner" aria-hidden /> : null}
        </div>
        <div
          className="cmdk-list"
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Commands and destinations"
          aria-busy={searching}
        >
          {filtered.length === 0 ? (
            <div className="cmdk-empty">
              <div style={{ marginBottom: 4 }}>No matches</div>
              <div className="cmdk-empty-hint">
                Try <span className="cmdk-kbd-inline">{">"}</span> for actions ·{" "}
                <span className="cmdk-kbd-inline">@</span> subscribers ·{" "}
                <span className="cmdk-kbd-inline">#</span> lists/tags ·{" "}
                <span className="cmdk-kbd-inline">/</span> navigation
              </div>
            </div>
          ) : (
            filtered.map((item, index) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.id} role="presentation">
                  {showGroup ? (
                    <div className="cmdk-section-label" aria-hidden="true">
                      {item.group}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === active}
                    aria-label={`${item.label}${item.hint ? `, ${item.hint}` : ""}; ${item.group}`}
                    data-cmdk-row={index}
                    className={`cmdk-item${index === active ? " is-active" : ""}`}
                    onMouseEnter={() => onActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => item.run()}
                  >
                    <span className="cmdk-item-icon">{iconFor(item.kind)}</span>
                    <span className="cmdk-item-label">{item.label}</span>
                    {item.hint ? (
                      <span className="cmdk-item-hint">{item.hint}</span>
                    ) : null}
                    {item.kbd ? (
                      <span className="cmdk-item-kbd">{item.kbd}</span>
                    ) : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {searching ? "Searching workspace records" : resultCount}
        </div>
        <div className="cmdk-footer" role="presentation">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span className="spacer" />
          <span className="cmdk-footer-hint">
            {filtered.length > 0 ? resultCount : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------- the component ----------------------------------------- */

export function CommandPalette(): ReactElement | null {
  // Two independent slice reads — neither re-renders on unrelated
  // store changes (section navigation, conn flicker, …).
  const commandOpen = useCommandOpen();
  const theme = useTheme();
  const me = useMe();
  const role = useRole();
  const roleStatus = useRoleStatus();
  const online = useOnline();
  const audit = useAuditScopes();
  const recentScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  useCapabilityObservationsRevision(recentScope);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<EntityHits>(EMPTY_HITS);
  const [searching, setSearching] = useState(false);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [shortcutRevision, setShortcutRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cacheRef = useRef<EntityCache>(makeCache());
  useEffect(
    () =>
      subscribeShortcutPreferences(() =>
        setShortcutRevision((revision) => revision + 1),
      ),
    [],
  );
  const shortcutPreferences = useMemo(
    () => loadShortcutPreferences(),
    [shortcutRevision],
  );

  // Register on the global dialog stack (like Modal does) so Esc only
  // closes the topmost layer — a palette opened over a slideover or
  // modal must not take the surface underneath down with it.
  const dialogId = useId();
  const { isTop } = useDialogStack(dialogId);
  useEffect(() => {
    if (!commandOpen) return;
    pushDialog(dialogId);
    return () => popDialog(dialogId);
  }, [commandOpen, dialogId]);

  // Reset on open. Recents are read fresh each time so the palette
  // reflects activity from other tabs in the same browser session.
  useEffect(() => {
    if (commandOpen) {
      setQuery("");
      setActive(0);
      setHits(EMPTY_HITS);
      setRecents(loadRecents(recentScope));
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [commandOpen, recentScope]);

  useEffect(() => {
    if (!commandOpen || !dialogRef.current) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const restoreBackground = isolateDialogBackground(dialogRef.current);
    const restoreScroll = lockDocumentBodyScroll();
    return () => {
      restoreScroll();
      restoreBackground();
      queueMicrotask(() => {
        if (topDialog() === null && previouslyFocused?.isConnected) {
          previouslyFocused.focus();
        }
      });
    };
  }, [commandOpen]);

  useEffect(() => {
    if (!commandOpen) return;
    const onDialogKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        if (!isTop) return;
        event.preventDefault();
        setCommandOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement;
      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onDialogKey);
    return () => window.removeEventListener("keydown", onDialogKey);
  }, [commandOpen, isTop]);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const listboxId = useId();

  // Debounced fetch of entity hits. Only fires once the search text is
  // ≥2 chars to avoid spamming the server on every initial keystroke.
  useEffect(() => {
    if (!commandOpen) return;
    const { cats, text } = parsed;
    if (text.length < 2) {
      setHits(EMPTY_HITS);
      setSearching(false);
      return;
    }
    const fetchCats = new Set<keyof EntityHits>();
    if (cats.has("subscribers")) fetchCats.add("subscribers");
    if (cats.has("campaigns")) fetchCats.add("campaigns");
    if (cats.has("lists")) fetchCats.add("lists");
    if (cats.has("forms")) fetchCats.add("forms");
    if (cats.has("templates")) fetchCats.add("templates");
    if (cats.has("tags")) fetchCats.add("tags");
    // #59 — the server-side global search covers subscriber / list /
    // segment / suppression / tag hits, so it joins the fan-out for the
    // unprefixed, "@" and "#" searches (type-filtering happens at merge).
    if (cats.has("subscribers") || cats.has("lists") || cats.has("tags"))
      fetchCats.add("server");
    if (fetchCats.size === 0) {
      setHits(EMPTY_HITS);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    // #59 — abort the in-flight /search call when the query changes or
    // the palette closes; the wrapper threads the signal to fetch.
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await fetchEntities(
          text,
          fetchCats,
          cacheRef.current,
          controller.signal,
        );
        if (cancelled) return;
        setHits(result);
        setSearching(false);
      })();
    }, 180);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
      setSearching(false);
    };
  }, [parsed, commandOpen]);

  /* ---------- build the merged item list ----------------- */
  const items = useMemo<Item[]>(() => {
    return buildPaletteItems({
      audit,
      hits,
      online,
      parsed,
      recentScope,
      role,
      roleStatus,
      shortcutPreferences,
      theme,
    });
  }, [
    audit.error,
    audit.isAdmin,
    audit.loading,
    audit.scopes,
    hits,
    online,
    parsed,
    recentScope,
    role,
    roleStatus,
    shortcutPreferences,
    theme,
  ]);

  /* ---------- ranking + slicing -------------------------- */
  const filtered = useMemo<Item[]>(() => {
    const text = parsed.text;
    if (!text) {
      // Empty query: show recents + a curated set of nav + actions.
      const recentItems: Item[] = recents.map((r) => {
        const currentProductItem = items.find((item) => item.id === r.id);
        return {
          id: `recent:${r.id}`,
          label: r.label,
          hint: r.hint,
          group: "Recents",
          kind: "recent",
          run: () => {
            // Product-owned actions/navigation are resolved against the live
            // catalog so permissions and current behavior are not serialized.
            if (
              currentProductItem &&
              (r.kind === "action" || r.kind === "nav")
            ) {
              currentProductItem.run();
              return;
            }
            if (r.section && r.resourceId) {
              try {
                navigateDesktopSectionResource(r.section, r.resourceId);
              } catch {
                // Ignore malformed in-memory state and fall back to its safe
                // destination. No legacy record is ever adopted from disk.
                setSection(r.section);
              }
            } else if (r.section) {
              setSection(r.section);
            }
            setCommandOpen(false);
          },
        };
      });
      const remaining = items.filter(
        (it) => !recentItems.some((ri) => ri.id.endsWith(it.id)),
      );
      return [...recentItems, ...remaining].slice(0, 60);
    }
    return filterRankedPaletteItems(items, text);
  }, [items, parsed.text, recents]);

  // Clamp active when list shrinks; scroll the active row into view.
  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered.length, active]);

  useEffect(() => {
    if (!listRef.current) return;
    const row = listRef.current.querySelector<HTMLDivElement>(
      `[data-cmdk-row="${active}"]`,
    );
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!commandOpen) return null;

  const close = (): void => setCommandOpen(false);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setActive((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      if (filtered.length > 0) setActive(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      if (filtered.length > 0) setActive(filtered.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[active];
      if (it) it.run();
      return;
    }
  };

  return (
    <CommandPaletteDialog
      active={active}
      dialogRef={dialogRef}
      filtered={filtered}
      inputRef={inputRef}
      listRef={listRef}
      listboxId={listboxId}
      parsed={parsed}
      query={query}
      searching={searching}
      onActive={setActive}
      onClose={close}
      onInputKey={onKey}
      onQuery={(value) => {
        setQuery(value);
        setActive(0);
      }}
    />
  );
}

// Re-export for tests / external callers, no-op when storage is missing.
export const _internal = {
  rankFuzzy,
  parseQuery,
  loadRecents,
  pushRecent,
  filterRankedPaletteItems,
  settingsNavigationItems: SETTINGS_NAVIGATION_ITEMS,
};
