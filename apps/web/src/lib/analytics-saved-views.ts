// SPDX-License-Identifier: AGPL-3.0-only
//
// Saved views for the tenant Analytics page (desktop SavedViewsMenu +
// saved-views-storage). A saved view is a NAMED SNAPSHOT OF THE PAGE'S URL
// STATE: the window (?range) and tab (?tab) the page owns, plus the fields
// lib/analytics-view-params defines (?metric, ?focus, ?compare, ?group_by).
// Applying one writes those params back to the URL, so a saved view and a
// shared link are the same thing and every reader of the URL agrees.
//
// Storage is this browser's localStorage, scoped by workspace AND user so a
// shared browser never shows one account's views to another. Nothing here is
// sent to the server. Pure apart from the storage handle passed in, so the
// contract is unit-testable.

import { normalizeRange, type RangeValue } from "@/lib/analytics-format";
import {
  ANALYTICS_PATH,
  parseAnalyticsView,
  type FocusMetric,
  type GroupedDimension,
} from "@/lib/analytics-view-params";

export const MAX_SAVED_VIEWS = 20;
export const MAX_VIEW_NAME = 60;
const MAX_VIEW_ID = 128;
const KEY_PREFIX = "postwave.web.analytics-saved-views.v1:";
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const CHART_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** The Analytics page's tabs (page.tsx TAB_VALUES). */
export const ANALYTICS_TABS = [
  "overview",
  "campaign",
  "audience",
  "reach",
  "lifecycle",
] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

export function asAnalyticsTab(value: string | null | undefined): AnalyticsTab {
  return ANALYTICS_TABS.find((tab) => tab === value) ?? "overview";
}

/** Everything a saved view restores. */
export interface AnalyticsViewState {
  range: RangeValue;
  tab: AnalyticsTab;
  metric: FocusMetric | null;
  focus: string | null;
  compare: boolean;
  groupBy: GroupedDimension | null;
  breakdownMetric?: "opens" | "clicks" | "bounces";
  breakdownDays?: 7 | 30 | 90;
}

export interface SavedView extends AnalyticsViewState {
  id: string;
  name: string;
}

/** Read the full view state off a location.search string. */
export function readAnalyticsViewState(search: string): AnalyticsViewState {
  const params = new URLSearchParams(search);
  const view = parseAnalyticsView(search);
  return {
    range: normalizeRange(params.get("range")),
    tab: asAnalyticsTab(params.get("tab")),
    metric: view.metric,
    focus: view.focus,
    compare: view.compare,
    groupBy: view.groupBy,
    ...(view.breakdownMetric ? { breakdownMetric: view.breakdownMetric } : {}),
    ...(view.breakdownDays ? { breakdownDays: view.breakdownDays } : {}),
  };
}

export function sameViewState(
  a: AnalyticsViewState,
  b: AnalyticsViewState,
): boolean {
  return (
    a.range === b.range &&
    a.tab === b.tab &&
    a.metric === b.metric &&
    a.focus === b.focus &&
    a.compare === b.compare &&
    a.groupBy === b.groupBy &&
    a.breakdownMetric === b.breakdownMetric &&
    a.breakdownDays === b.breakdownDays
  );
}

/**
 * The /app/analytics href that restores `view`. Params outside the saved
 * contract are kept; every saved field is written (or removed when it is the
 * page default), matching how the page and useAnalyticsView write them.
 */
export function savedViewHref(
  view: AnalyticsViewState,
  currentSearch = "",
): string {
  const params = new URLSearchParams(currentSearch);
  const put = (key: string, value: string | null) => {
    if (value === null) params.delete(key);
    else params.set(key, value);
  };
  put("range", view.range === "30d" ? null : view.range);
  put("tab", view.tab === "overview" ? null : view.tab);
  put("metric", view.metric);
  put("focus", view.focus);
  put("compare", view.compare ? null : "off");
  put("group_by", view.groupBy);
  put("breakdown_metric", view.breakdownMetric ?? null);
  put("breakdown_days", view.breakdownDays ? String(view.breakdownDays) : null);
  const query = params.toString();
  return query ? `${ANALYTICS_PATH}?${query}` : ANALYTICS_PATH;
}

/** One-line description of what a view restores, for the menu row. */
export function describeViewState(view: AnalyticsViewState): string {
  const parts = [`Last ${view.range.replace("d", " days")}`];
  if (view.tab !== "overview") parts.push(`${view.tab} tab`);
  if (view.metric) parts.push(`${view.metric} focused`);
  if (view.groupBy) parts.push(`by ${view.groupBy}`);
  if (view.breakdownMetric) parts.push(`${view.breakdownMetric} breakdown`);
  if (view.breakdownDays) parts.push(`${view.breakdownDays}-day breakdown`);
  if (!view.compare) parts.push("no prior-period comparison");
  return parts.join(" · ");
}

export function savedViewsStorageKey(tenantId: string, userId: string): string {
  return `${KEY_PREFIX}${tenantId}:${userId}`;
}

function canonicalSavedView(raw: unknown): SavedView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim() : "";
  if (
    typeof c.id !== "string" ||
    !c.id ||
    c.id.length > MAX_VIEW_ID ||
    CONTROL_RE.test(c.id) ||
    !name ||
    name.length > MAX_VIEW_NAME ||
    CONTROL_RE.test(name) ||
    (c.range !== "7d" && c.range !== "30d" && c.range !== "90d") ||
    typeof c.compare !== "boolean"
  ) {
    return null;
  }
  const metric =
    typeof c.metric === "string"
      ? parseAnalyticsView(`metric=${encodeURIComponent(c.metric)}`).metric
      : null;
  return {
    id: c.id,
    name,
    range: c.range,
    tab: asAnalyticsTab(typeof c.tab === "string" ? c.tab : null),
    metric,
    focus:
      typeof c.focus === "string" && CHART_ID.test(c.focus) ? c.focus : null,
    compare: c.compare,
    groupBy:
      c.groupBy === "campaign" || c.groupBy === "domain" ? c.groupBy : null,
    ...(c.breakdownMetric === "opens" ||
    c.breakdownMetric === "clicks" ||
    c.breakdownMetric === "bounces"
      ? { breakdownMetric: c.breakdownMetric }
      : {}),
    ...(c.breakdownDays === 7 ||
    c.breakdownDays === 30 ||
    c.breakdownDays === 90
      ? { breakdownDays: c.breakdownDays }
      : {}),
  };
}

/** Keep only well-formed, uniquely-identified views, capped at the limit. */
export function sanitizeSavedViews(candidate: unknown): SavedView[] {
  if (!Array.isArray(candidate)) return [];
  const out: SavedView[] = [];
  const ids = new Set<string>();
  for (const raw of candidate.slice(0, MAX_SAVED_VIEWS * 2)) {
    const view = canonicalSavedView(raw);
    if (!view || ids.has(view.id)) continue;
    ids.add(view.id);
    out.push(view);
    if (out.length >= MAX_SAVED_VIEWS) break;
  }
  return out;
}

export type SavedViewsStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): SavedViewsStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSavedViews(
  tenantId: string,
  userId: string,
  store: SavedViewsStore | null = defaultStore(),
): SavedView[] {
  if (!store) return [];
  try {
    const raw = store.getItem(savedViewsStorageKey(tenantId, userId));
    return raw ? sanitizeSavedViews(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Persist the list. Throws when storage is unavailable or full. */
export function writeSavedViews(
  tenantId: string,
  userId: string,
  views: SavedView[],
  store: SavedViewsStore | null = defaultStore(),
): void {
  if (!store) {
    throw new Error("This browser isn't letting Moosewave save views here.");
  }
  store.setItem(
    savedViewsStorageKey(tenantId, userId),
    JSON.stringify(sanitizeSavedViews(views)),
  );
}

export function newSavedViewId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `v-${uuid}`;
  } catch {
    // Fall through to the non-secret local id below.
  }
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Validate a name typed into the naming dialog. Null = acceptable. */
export function savedViewNameProblem(
  name: string,
  existing: SavedView[],
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the view a name.";
  if (trimmed.length > MAX_VIEW_NAME) {
    return `Keep the name to ${MAX_VIEW_NAME} characters or fewer.`;
  }
  if (CONTROL_RE.test(trimmed)) return "Remove the control characters.";
  if (existing.some((v) => v.name.toLowerCase() === trimmed.toLowerCase())) {
    return "You already have a view with that name.";
  }
  return null;
}
