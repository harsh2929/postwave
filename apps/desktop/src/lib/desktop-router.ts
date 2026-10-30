/** Canonical, identity-scoped desktop routing with durable browser history. */

import { useEffect, useSyncExternalStore } from "react";

import {
  alignedApprovedBackRepairIndex,
  approvedBackHasOutstandingTraversals,
  approvedBackObservedIndex,
  beginApprovedBackQuarantine,
  consumeApprovedBackTraversal,
  createApprovedBackObservation,
  issueApprovedBackTraversal,
  resolveApprovedBackPop,
  scheduleApprovedBackRecovery,
  settleApprovedBackTransition,
  type ApprovedDesktopBackAction,
  type ApprovedDesktopBackCurrent,
  type ApprovedDesktopBackObservation,
  type ApprovedDesktopBackOptions,
  type ApprovedDesktopBackResult,
  type ApprovedDesktopBackTransition,
} from "./desktop-approved-back";
import {
  PERSISTENT_DESKTOP_SECTIONS,
  routeMetaForSection,
  type PersistentDesktopSection,
} from "./desktop-routes";
import {
  clampedScrollTop,
  createDesktopHistoryState,
  desktopRouteIdentityScope,
  desktopRouteStorageKey as routeStorageKey,
  parseDesktopHistoryState as parseHistoryState,
  resolveIdentityRoute,
  routeTimestampIsCurrent,
  type DesktopHistoryState,
} from "./desktop-route-runtime";
import {
  createBrowserDesktopRouterEnvironment,
  type DesktopRouterEnvironment,
} from "./desktop-router-environment";
import {
  type LifecycleIntent,
  type LifecycleTransitionResult,
  requestLifecycleTransition,
  shouldCoordinateLifecycle,
} from "./lifecycle-coordinator";
import { registerPrivateSessionReset } from "./private-session-state";
import type { Section } from "./store";

export { desktopRouteIdentityScope };
export type { DesktopRouterEnvironment };

export type RoutableDesktopSection =
  | PersistentDesktopSection
  | "auditInvestigation";

export type DesktopRouteSource =
  | "navigation"
  | "deep-link"
  | "history"
  | "restore"
  | "identity";

export type DesktopSortDirection = "asc" | "desc";

export interface DesktopRouteFilter {
  key: string;
  value: string;
}

export interface DesktopRouteSort {
  field: string;
  direction: DesktopSortDirection;
}

export interface DesktopRouteOverlay {
  name: string;
  resourceId?: string;
}

/** Every currently rendered Settings heading that can be addressed safely. */
export const SETTINGS_ANCHORS = [
  "setup-progress",
  "api-connection",
  "ai-brand-voice-gate",
  "appearance",
  "privacy",
  "about",
  "security",
  "approve-another-device",
  "tour",
  "workspace",
  "slack",
  "sample-data",
  "outbound-webhooks",
  "desktop-updates",
  "desktop-window",
  "keyboard-shortcuts",
  "custom-fields-governance",
  "form-firewall",
  "data-privacy",
  "inactive-api-keys",
  "feature-flags",
  "export-retention",
  "approval-chain",
  "archive-domain",
  "data-exports",
  "api-keys",
  "identifier-transforms",
  "region",
  "usage",
  "your-plan",
  "workspace-profile",
  "notifications",
  "dashboard-email-digest",
  "webhook-alerts",
  "data-retention",
  "audit-access",
] as const;

export type SettingsAnchor = (typeof SETTINGS_ANCHORS)[number];

export interface DesktopRoute {
  section: RoutableDesktopSection;
  resourceId?: string;
  tab?: string;
  query?: string;
  sort?: DesktopRouteSort;
  filters?: readonly DesktopRouteFilter[];
  overlay?: DesktopRouteOverlay;
  settingsAnchor?: SettingsAnchor;
}

export interface DesktopRouteSnapshot {
  route: DesktopRoute;
  canonicalUrl: string;
  revision: number;
  source: DesktopRouteSource;
  /** Scroll position restored only for Back/Forward/reopen transitions. */
  restoreScrollTop: number | null;
}

export type DesktopRouteParseFailure =
  | "invalid-url"
  | "route-too-long"
  | "unknown-destination"
  | "invalid-path"
  | "invalid-resource"
  | "unknown-parameter"
  | "duplicate-parameter"
  | "invalid-parameter"
  | "too-many-filters";

export type DesktopRouteParseResult =
  | {
      ok: true;
      route: DesktopRoute;
      canonicalUrl: string;
      /** True when an accepted legacy/non-canonical URL should be replaced. */
      redirected: boolean;
    }
  | { ok: false; reason: DesktopRouteParseFailure };

const ROUTE_STORAGE_VERSION = 2;
const ROUTE_STORAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ROUTE_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_ROUTE_SCOPE_MAX = 8;
const MAX_PERSISTED_ROUTE_CHARS = 1024;
const MAX_ROUTE_BYTES = 4 * 1024;
const MAX_RESOURCE_CHARS = 254;
const MAX_QUERY_CHARS = 256;
const MAX_FILTERS = 16;
const MAX_FILTER_VALUE_CHARS = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const TOKEN_RE = /^[a-z][a-z0-9-]{0,47}$/u;
const RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._~+@-]{0,253}$/u;

const SECTION_SLUGS: Record<RoutableDesktopSection, string> = {
  dashboard: "dashboard",
  subscribers: "subscribers",
  tags: "tags",
  lists: "lists",
  segments: "segments",
  audienceSyncs: "audience-syncs",
  suppressions: "suppressions",
  campaigns: "campaigns",
  sequences: "sequences",
  automations: "automations",
  forms: "forms",
  templates: "templates",
  assets: "assets",
  collections: "collections",
  webhooks: "webhooks",
  track: "track",
  analytics: "analytics",
  sendtime: "send-time",
  archive: "archive",
  referrals: "referrals",
  affiliates: "affiliates",
  discounts: "discounts",
  gifts: "gifts",
  commerce: "commerce",
  reviews: "reviews",
  retentionOffers: "retention-offers",
  deliverabilityHub: "deliverability-hub",
  domains: "domains",
  dmarc: "dmarc",
  ai: "ai",
  aiChangelog: "ai-changelog",
  migrations: "migrations",
  integrations: "integrations",
  dataPlatform: "data-platform",
  approvals: "approvals",
  audit: "audit",
  privacyIncidents: "privacy-incidents",
  consent: "consent",
  mcp: "mcp",
  smsInbox: "sms-inbox",
  helpdesk: "helpdesk",
  smsSuppressions: "sms-suppressions",
  pushSuppressions: "push-suppressions",
  apiPlayground: "api-playground",
  webhookSimulator: "webhook-simulator",
  sending: "sending",
  agency: "agency",
  inboundRoutes: "inbound-routes",
  scim: "scim",
  compliance: "compliance",
  privacyPortal: "privacy-portal",
  auditSinks: "audit-sinks",
  auditAlerts: "audit-alerts",
  settings: "settings",
  auditInvestigation: "audit-investigations",
};

const SLUG_SECTIONS = new Map<string, RoutableDesktopSection>(
  Object.entries(SECTION_SLUGS).map(([section, slug]) => [
    slug,
    section as RoutableDesktopSection,
  ]),
);

interface RouteAlias {
  section: RoutableDesktopSection;
  tab?: string;
}

const LEGACY_ROUTE_ALIASES: Readonly<Record<string, RouteAlias>> = {
  outbound: { section: "webhooks", tab: "outbound" },
  "outbound-webhooks": { section: "webhooks", tab: "outbound" },
  inbound: { section: "webhooks", tab: "inbound" },
  events: { section: "track" },
  sendtime: { section: "sendtime" },
  dataplatform: { section: "dataPlatform" },
  "custom-domains": { section: "domains" },
  gift: { section: "gifts" },
  hipaa: { section: "compliance", tab: "hipaa" },
  "audit-investigation": { section: "auditInvestigation" },
};

const SETTINGS_ANCHOR_SET = new Set<string>(SETTINGS_ANCHORS);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeDecodePathSegment(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded || decoded.includes("%") || CONTROL_RE.test(decoded)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function isResourceId(value: string): boolean {
  return (
    value.length <= MAX_RESOURCE_CHARS &&
    byteLength(value) <= MAX_RESOURCE_CHARS * 2 &&
    RESOURCE_RE.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function isBoundedText(value: string, maxChars: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim() === value &&
    !CONTROL_RE.test(value)
  );
}

function normalizeFilters(
  filters: readonly DesktopRouteFilter[] | undefined,
): DesktopRouteFilter[] | null {
  if (!filters || filters.length === 0) return [];
  if (filters.length > MAX_FILTERS) return null;
  const seen = new Set<string>();
  const normalized: DesktopRouteFilter[] = [];
  for (const filter of filters) {
    if (
      !TOKEN_RE.test(filter.key) ||
      seen.has(filter.key) ||
      !isBoundedText(filter.value, MAX_FILTER_VALUE_CHARS)
    ) {
      return null;
    }
    seen.add(filter.key);
    normalized.push({ key: filter.key, value: filter.value });
  }
  normalized.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return normalized;
}

function canonicalSection(section: Section): RouteAlias | null {
  switch (section) {
    case "outboundWebhooks":
      return { section: "webhooks", tab: "outbound" };
    case "hipaa":
      return { section: "compliance", tab: "hipaa" };
    case "aeoSensor":
      return null;
    default:
      return { section: section as RoutableDesktopSection };
  }
}

/** Convert a legacy Section navigation request into a canonical route. */
export function routeForDesktopSection(section: Section): DesktopRoute {
  const canonical = canonicalSection(section);
  if (!canonical) return { section: "dashboard" };
  return {
    section: canonical.section,
    ...(canonical.tab ? { tab: canonical.tab } : {}),
  };
}

function hasValidRouteScalars(route: DesktopRoute): boolean {
  return (
    Object.prototype.hasOwnProperty.call(SECTION_SLUGS, route.section) &&
    (route.resourceId === undefined || isResourceId(route.resourceId)) &&
    (route.tab === undefined || TOKEN_RE.test(route.tab)) &&
    (route.query === undefined || isBoundedText(route.query, MAX_QUERY_CHARS))
  );
}

function hasValidRouteSort(sort: DesktopRouteSort | undefined): boolean {
  return (
    sort === undefined ||
    (TOKEN_RE.test(sort.field) &&
      (sort.direction === "asc" || sort.direction === "desc"))
  );
}

function hasValidRouteOverlay(
  overlay: DesktopRouteOverlay | undefined,
): boolean {
  return (
    overlay === undefined ||
    (TOKEN_RE.test(overlay.name) &&
      (overlay.resourceId === undefined || isResourceId(overlay.resourceId)))
  );
}

function hasValidSettingsAnchor(route: DesktopRoute): boolean {
  return (
    route.settingsAnchor === undefined ||
    (route.section === "settings" &&
      SETTINGS_ANCHOR_SET.has(route.settingsAnchor))
  );
}

function normalizedRouteValue(
  route: DesktopRoute,
  filters: DesktopRouteFilter[],
): DesktopRoute {
  const normalized: DesktopRoute = { section: route.section };
  if (route.resourceId) normalized.resourceId = route.resourceId;
  if (route.tab) normalized.tab = route.tab;
  if (route.query) normalized.query = route.query;
  if (route.sort) normalized.sort = { ...route.sort };
  if (filters.length > 0) normalized.filters = filters;
  if (route.overlay) normalized.overlay = { ...route.overlay };
  if (route.settingsAnchor) normalized.settingsAnchor = route.settingsAnchor;
  return normalized;
}

function normalizeRoute(route: DesktopRoute): DesktopRoute | null {
  if (
    !hasValidRouteScalars(route) ||
    !hasValidRouteSort(route.sort) ||
    !hasValidRouteOverlay(route.overlay) ||
    !hasValidSettingsAnchor(route)
  ) {
    return null;
  }
  const filters = normalizeFilters(route.filters);
  if (filters === null) return null;
  return normalizedRouteValue(route, filters);
}

/**
 * Serialize a validated route. Invalid programmatic input throws so a caller
 * cannot quietly put a malformed or unbounded intent into browser history.
 */
export function serializeDesktopRoute(route: DesktopRoute): string {
  const normalized = normalizeRoute(route);
  if (!normalized) throw new TypeError("Invalid desktop route");

  let path = `/app/${SECTION_SLUGS[normalized.section]}`;
  if (normalized.resourceId) {
    path += `/${encodeURIComponent(normalized.resourceId)}`;
  }
  const params = new URLSearchParams();
  if (normalized.tab) params.set("tab", normalized.tab);
  if (normalized.query) params.set("q", normalized.query);
  if (normalized.sort) {
    params.set("sort", normalized.sort.field);
    params.set("dir", normalized.sort.direction);
  }
  for (const filter of normalized.filters ?? []) {
    params.set(`f.${filter.key}`, filter.value);
  }
  if (normalized.overlay) {
    params.set("overlay", normalized.overlay.name);
    if (normalized.overlay.resourceId) {
      params.set("overlayId", normalized.overlay.resourceId);
    }
  }
  if (normalized.settingsAnchor) {
    params.set("anchor", normalized.settingsAnchor);
  }
  const query = params.toString();
  const serialized = query ? `${path}?${query}` : path;
  if (byteLength(serialized) > MAX_ROUTE_BYTES) {
    throw new TypeError("Desktop route exceeds the maximum length");
  }
  return serialized;
}

function parseInputUrl(input: string | URL): URL | null {
  try {
    if (input instanceof URL) return new URL(input.toString());
    if (
      typeof input !== "string" ||
      input.length === 0 ||
      input.trim() !== input ||
      CONTROL_RE.test(input) ||
      input.includes("\\")
    ) {
      return null;
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(input)) {
      const absolute = new URL(input);
      if (!/^(https?|tauri):$/u.test(absolute.protocol)) return null;
      return absolute;
    }
    return new URL(
      input.startsWith("/") ? input : `/${input}`,
      "https://postwave.local",
    );
  } catch {
    return null;
  }
}

function parseLegacyAnalyticsHash(url: URL): DesktopRouteParseResult | null {
  const hash = url.hash.replace(/^#\/?/u, "");
  if (hash !== "analytics" && !hash.startsWith("analytics?")) return null;
  const queryIndex = hash.indexOf("?");
  const params = new URLSearchParams(
    queryIndex >= 0 ? hash.slice(queryIndex + 1) : "",
  );
  const filters: DesktopRouteFilter[] = [];
  const seen = new Set<string>();
  for (const [key, value] of params.entries()) {
    if (
      (key !== "metric" && key !== "range" && key !== "focus") ||
      seen.has(key) ||
      !isBoundedText(value, MAX_FILTER_VALUE_CHARS)
    ) {
      return { ok: false, reason: "invalid-parameter" };
    }
    seen.add(key);
    filters.push({ key, value });
  }
  const route: DesktopRoute = {
    section: "analytics",
    ...(filters.length > 0 ? { filters } : {}),
  };
  const normalized = normalizeRoute(route);
  if (!normalized) return { ok: false, reason: "invalid-parameter" };
  return {
    ok: true,
    route: normalized,
    canonicalUrl: serializeDesktopRoute(route),
    redirected: true,
  };
}

type DesktopRouteParseFailureResult = Extract<
  DesktopRouteParseResult,
  { ok: false }
>;

interface RouteParseStep<T> {
  value: T;
}

interface ParsedRoutePath {
  url: URL;
  alias: RouteAlias | undefined;
  section: RoutableDesktopSection;
  resourceId: string | undefined;
}

interface ParsedRouteQuery {
  values: Map<string, string>;
  filters: DesktopRouteFilter[];
}

function parseFailure(
  reason: DesktopRouteParseFailure,
): DesktopRouteParseFailureResult {
  return { ok: false, reason };
}

function isParseFailure<T>(
  result: RouteParseStep<T> | DesktopRouteParseFailureResult,
): result is DesktopRouteParseFailureResult {
  return "ok" in result;
}

function parseRouteInputBoundary(
  input: string | URL,
): RouteParseStep<URL> | DesktopRouteParseFailureResult {
  const raw = typeof input === "string" ? input : input.toString();
  if (byteLength(raw) > MAX_ROUTE_BYTES) {
    return parseFailure("route-too-long");
  }
  const rawPath = raw.split("?", 1)[0] ?? raw;
  // URL normalisation resolves encoded dot segments before pathname parsing.
  // Reject those (and encoded separators/double-encoding) at the raw boundary
  // so `/approvals/%2e%2e` cannot canonicalize into another destination.
  if (/%(?:2e|2f|5c|25)/iu.test(rawPath)) {
    return parseFailure("invalid-path");
  }
  const url = parseInputUrl(input);
  if (!url || url.username || url.password) {
    return parseFailure("invalid-url");
  }
  return { value: url };
}

function parseRoutePath(
  url: URL,
): RouteParseStep<ParsedRoutePath> | DesktopRouteParseFailureResult {
  const rawSegments = url.pathname.split("/").filter(Boolean);
  if (rawSegments[0]?.toLowerCase() === "app") rawSegments.shift();
  if (rawSegments.length > 2) return parseFailure("invalid-path");

  const rawSlug = rawSegments[0] ?? "dashboard";
  const slug = safeDecodePathSegment(rawSlug)?.toLowerCase();
  if (!slug) return parseFailure("invalid-path");
  const alias = LEGACY_ROUTE_ALIASES[slug];
  const section = SLUG_SECTIONS.get(slug) ?? alias?.section;
  if (!section) return parseFailure("unknown-destination");

  const encodedResource = rawSegments[1];
  const resourceId =
    encodedResource === undefined
      ? undefined
      : safeDecodePathSegment(encodedResource);
  if (resourceId === null || (resourceId && !isResourceId(resourceId))) {
    return parseFailure("invalid-resource");
  }
  return { value: { url, alias, section, resourceId } };
}

const ROUTE_QUERY_KEYS = new Set([
  "tab",
  "q",
  "sort",
  "dir",
  "overlay",
  "overlayId",
  "anchor",
]);

function isAllowedRouteQueryKey(
  key: string,
  section: RoutableDesktopSection,
): boolean {
  return (
    ROUTE_QUERY_KEYS.has(key) || (key === "email" && section === "subscribers")
  );
}

function parseRouteQuery(
  url: URL,
  section: RoutableDesktopSection,
): RouteParseStep<ParsedRouteQuery> | DesktopRouteParseFailureResult {
  const values = new Map<string, string>();
  const filters: DesktopRouteFilter[] = [];
  const filterKeys = new Set<string>();
  for (const [key, value] of url.searchParams.entries()) {
    if (values.has(key)) return parseFailure("duplicate-parameter");
    if (key.startsWith("f.")) {
      const filterKey = key.slice(2);
      if (!TOKEN_RE.test(filterKey)) return parseFailure("invalid-parameter");
      if (filterKeys.has(filterKey)) return parseFailure("duplicate-parameter");
      filterKeys.add(filterKey);
      filters.push({ key: filterKey, value });
      continue;
    }
    if (!isAllowedRouteQueryKey(key, section)) {
      return parseFailure("unknown-parameter");
    }
    values.set(key, value);
  }
  if (filters.length > MAX_FILTERS) return parseFailure("too-many-filters");
  return { value: { values, filters } };
}

function resolvedRouteResource(
  resourceId: string | undefined,
  values: Map<string, string>,
): string | undefined | null {
  const legacyEmail = values.get("email");
  if (legacyEmail === undefined) return resourceId;
  if (resourceId !== undefined || !isResourceId(legacyEmail)) return null;
  return legacyEmail;
}

function resolvedRouteTab(
  alias: RouteAlias | undefined,
  values: Map<string, string>,
): string | undefined | null {
  const requested = values.get("tab");
  if (alias?.tab && requested && alias.tab !== requested) return null;
  const tab = requested ?? alias?.tab;
  return tab === undefined || TOKEN_RE.test(tab) ? tab : null;
}

function resolvedRouteQuery(
  values: Map<string, string>,
): string | undefined | null {
  const query = values.get("q");
  return query === undefined || isBoundedText(query, MAX_QUERY_CHARS)
    ? query
    : null;
}

function resolvedRouteSort(
  values: Map<string, string>,
): DesktopRouteSort | undefined | null {
  const field = values.get("sort");
  const direction = values.get("dir");
  if (direction !== undefined && field === undefined) return null;
  if (field !== undefined && !TOKEN_RE.test(field)) return null;
  if (direction !== undefined && direction !== "asc" && direction !== "desc") {
    return null;
  }
  return field
    ? { field, direction: (direction ?? "asc") as DesktopSortDirection }
    : undefined;
}

function resolvedRouteOverlay(
  values: Map<string, string>,
): DesktopRouteOverlay | undefined | null {
  const name = values.get("overlay");
  const resourceId = values.get("overlayId");
  if (resourceId !== undefined && name === undefined) return null;
  if (name !== undefined && !TOKEN_RE.test(name)) return null;
  if (resourceId !== undefined && !isResourceId(resourceId)) return null;
  if (!name) return undefined;
  return resourceId ? { name, resourceId } : { name };
}

function resolvedSettingsAnchor(
  section: RoutableDesktopSection,
  values: Map<string, string>,
): SettingsAnchor | undefined | null {
  const anchor = values.get("anchor");
  if (anchor === undefined) return undefined;
  if (section !== "settings" || !SETTINGS_ANCHOR_SET.has(anchor)) return null;
  return anchor as SettingsAnchor;
}

function buildParsedDesktopRoute(
  path: ParsedRoutePath,
  query: ParsedRouteQuery,
): DesktopRouteParseResult {
  const resourceId = resolvedRouteResource(path.resourceId, query.values);
  const tab = resolvedRouteTab(path.alias, query.values);
  const textQuery = resolvedRouteQuery(query.values);
  const sort = resolvedRouteSort(query.values);
  const filters = normalizeFilters(query.filters);
  const overlay = resolvedRouteOverlay(query.values);
  const settingsAnchor = resolvedSettingsAnchor(path.section, query.values);
  if (
    resourceId === null ||
    tab === null ||
    textQuery === null ||
    sort === null ||
    filters === null ||
    overlay === null ||
    settingsAnchor === null
  ) {
    return parseFailure(
      resourceId === null ? "invalid-resource" : "invalid-parameter",
    );
  }

  const route = normalizedRouteValue(
    {
      section: path.section,
      resourceId,
      tab,
      query: textQuery,
      sort,
      overlay,
      settingsAnchor,
    },
    filters,
  );
  const canonicalUrl = serializeDesktopRoute(route);
  return {
    ok: true,
    route,
    canonicalUrl,
    redirected: `${path.url.pathname}${path.url.search}` !== canonicalUrl,
  };
}

/** Strictly parse a desktop URL and return its canonical representation. */
export function parseDesktopRoute(
  input: string | URL,
): DesktopRouteParseResult {
  const inputStep = parseRouteInputBoundary(input);
  if (isParseFailure(inputStep)) return inputStep;
  const url = inputStep.value;
  if (url.hash) {
    return parseLegacyAnalyticsHash(url) ?? parseFailure("invalid-url");
  }
  const pathStep = parseRoutePath(url);
  if (isParseFailure(pathStep)) return pathStep;
  const queryStep = parseRouteQuery(url, pathStep.value.section);
  if (isParseFailure(queryStep)) return queryStep;
  return buildParsedDesktopRoute(pathStep.value, queryStep.value);
}

interface PersistedDesktopRoute {
  route: DesktopRoute;
  scrollTop: number;
}

interface SessionDesktopRoute extends PersistedDesktopRoute {
  touchedAt: number;
}

interface DurableDesktopRoute {
  version: typeof ROUTE_STORAGE_VERSION;
  section: PersistentDesktopSection;
  savedAt: number;
}

const PERSISTENT_SECTION_SET = new Set<RoutableDesktopSection>(
  PERSISTENT_DESKTOP_SECTIONS,
);

function safePersistentSection(route: DesktopRoute): PersistentDesktopSection {
  if (PERSISTENT_SECTION_SET.has(route.section)) {
    return route.section as PersistentDesktopSection;
  }
  return route.section === "auditInvestigation" ? "audit" : "dashboard";
}

function defaultSnapshot(): DesktopRouteSnapshot {
  const route: DesktopRoute = { section: "dashboard" };
  return {
    route,
    canonicalUrl: serializeDesktopRoute(route),
    revision: 0,
    source: "restore",
    restoreScrollTop: null,
  };
}

export interface DesktopNavigateOptions {
  replace?: boolean;
  source?: DesktopRouteSource;
  /** Re-checked after lifecycle review so stale identity-bound intents cannot commit. */
  isStillCurrent?: () => boolean;
}

export interface DesktopHistoryTransition {
  from: DesktopRoute;
  to: DesktopRoute;
}

interface DesktopHistoryTransitionGuard {
  shouldIntercept(transition: DesktopHistoryTransition): boolean;
  request(
    transition: DesktopHistoryTransition,
    resume: () => Promise<void>,
  ): Promise<unknown>;
}

interface PendingDesktopHistoryTransition {
  parsed: Extract<DesktopRouteParseResult, { ok: true }>;
  state: DesktopHistoryState | null;
  targetIndex: number | null;
  delta: number;
  phase: "rolling-back" | "reviewing" | "resuming";
  resumeResolve: (() => void) | null;
}

/** Testable history controller; the application uses the singleton below. */
export class DesktopRouterController {
  readonly #environment: DesktopRouterEnvironment;
  readonly #listeners = new Set<() => void>();
  #snapshot: DesktopRouteSnapshot;
  #identityScope: string | null = null;
  readonly #sessionRoutes = new Map<string, SessionDesktopRoute>();
  // Monotonic position for lossless Back/Forward lifecycle rollback.
  #historyIndex = 0;
  #historyTransitionGuard: DesktopHistoryTransitionGuard | null = null;
  #pendingHistoryTransition: PendingDesktopHistoryTransition | null = null;
  #approvedBackTransition: ApprovedDesktopBackTransition | null = null;
  #unsubscribePop: (() => void) | null = null;

  constructor(environment: DesktopRouterEnvironment) {
    this.#environment = environment;
    const parsed = parseDesktopRoute(environment.location());
    const initialState = parseHistoryState(environment.historyState());
    this.#historyIndex = initialState?.index ?? 0;
    const initialScroll =
      parsed.ok && initialState?.canonicalUrl === parsed.canonicalUrl
        ? clampedScrollTop(initialState.scrollTop)
        : null;
    this.#snapshot = parsed.ok
      ? {
          route: parsed.route,
          canonicalUrl: parsed.canonicalUrl,
          revision: 0,
          source: "restore",
          restoreScrollTop: initialScroll,
        }
      : defaultSnapshot();
    this.#replaceCurrent("restore", this.#snapshot.restoreScrollTop ?? 0);
    this.#unsubscribePop = environment.subscribePopState((state) => {
      this.#onPopState(state);
    });
  }

  getSnapshot = (): DesktopRouteSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  dispose(): void {
    this.#unsubscribePop?.();
    this.#unsubscribePop = null;
    this.#listeners.clear();
    this.#pendingHistoryTransition?.resumeResolve?.();
    this.#pendingHistoryTransition = null;
    this.#finishApprovedBackTransition("failed");
    this.#historyTransitionGuard = null;
  }

  setHistoryTransitionGuard(guard: DesktopHistoryTransitionGuard | null): void {
    this.#historyTransitionGuard = guard;
  }

  navigate(route: DesktopRoute, options: DesktopNavigateOptions = {}): void {
    const canonicalUrl = serializeDesktopRoute(route);
    const parsed = parseDesktopRoute(canonicalUrl);
    if (!parsed.ok) throw new TypeError("Invalid desktop route");
    const source = options.source ?? "navigation";
    const sameRoute = canonicalUrl === this.#snapshot.canonicalUrl;
    if (sameRoute && !options.replace && source !== "deep-link") return;

    this.#syncHistoryIndexFromEnvironment();
    const replacing = options.replace || sameRoute;
    const nextIndex = replacing ? this.#historyIndex : this.#historyIndex + 1;
    const state = this.#historyState(canonicalUrl, source, 0, nextIndex);
    try {
      if (replacing) {
        this.#environment.replaceState(state, canonicalUrl);
      } else {
        this.#environment.pushState(state, canonicalUrl);
      }
    } catch {
      // Hardened/custom-protocol webviews can disable History writes. Keep
      // in-memory navigation functional; reload persistence still uses the
      // identity-scoped route store when available.
    }
    this.#historyIndex = nextIndex;
    if (this.#approvedBackTransition !== null) {
      this.#approvedBackTransition.physicalIndex = nextIndex;
    }
    this.#snapshot = {
      route: parsed.route,
      canonicalUrl,
      revision: this.#snapshot.revision + 1,
      source,
      restoreScrollTop: null,
    };
    this.#persistCurrent(0);
    this.#emit();
  }

  /**
   * Perform one pre-reviewed Back transition to an exact expected entry.
   *
   * The caller owns lifecycle coordination. The one-shot target prevents the
   * ensuing popstate from opening a second lifecycle review, while refusing a
   * blind Back when this controller has no prior indexed entry.
   */
  navigateApprovedBackTo(
    route: DesktopRoute,
    { isStillCurrent, timeoutMs = 1_000 }: ApprovedDesktopBackOptions = {},
  ): Promise<ApprovedDesktopBackResult> {
    if (
      this.#historyIndex <= 0 ||
      this.#pendingHistoryTransition !== null ||
      this.#approvedBackTransition !== null
    ) {
      return Promise.resolve("failed");
    }
    const canonicalUrl = serializeDesktopRoute(route);
    const parsed = parseDesktopRoute(canonicalUrl);
    if (!parsed.ok) throw new TypeError("Invalid desktop route");
    return new Promise((resolve) => {
      const transition: ApprovedDesktopBackTransition = {
        expectedCanonicalUrl: parsed.canonicalUrl,
        expectedIndex: this.#historyIndex - 1,
        isStillCurrent,
        outstandingTraversals: [],
        physicalIndex: this.#historyIndex,
        protectedCanonicalUrl: this.#snapshot.canonicalUrl,
        protectedIndex: this.#historyIndex,
        protectedRevision: this.#snapshot.revision,
        protectedScope: this.#identityScope,
        phase: "seeking",
        recoveryTimeout: null,
        restorationResult: "failed",
        settled: false,
        timeout: setTimeout(
          () => {
            if (this.#approvedBackTransition !== transition) return;
            this.#quarantineTimedOutApprovedBack(transition);
          },
          Math.max(1, timeoutMs),
        ),
        resolve,
      };
      this.#approvedBackTransition = transition;
      const issued = this.#issueApprovedBackTraversal(transition, {
        kind: "go",
        delta: -1,
        fallbackIndex: this.#historyIndex,
        target: {
          canonicalUrl: parsed.canonicalUrl,
          index: transition.expectedIndex,
          purpose: "origin",
          scope: this.#identityScope,
        },
      });
      if (!issued) {
        this.#finishApprovedBackTransition("failed");
      }
    });
  }

  recordScroll(scrollTop: number): void {
    const current = parseHistoryState(this.#environment.historyState());
    if (this.#approvedBackTransition !== null) {
      const parsedLocation = parseDesktopRoute(this.#environment.location());
      if (
        !parsedLocation.ok ||
        parsedLocation.canonicalUrl !== this.#snapshot.canonicalUrl ||
        current?.canonicalUrl !== this.#snapshot.canonicalUrl ||
        (this.#approvedBackTransition.physicalIndex !== null &&
          current.index !== this.#approvedBackTransition.physicalIndex)
      ) {
        return;
      }
    }
    const next = clampedScrollTop(scrollTop);
    if (
      current &&
      current.canonicalUrl === this.#snapshot.canonicalUrl &&
      current.scrollTop === next &&
      current.scope === this.#identityScope
    ) {
      return;
    }
    try {
      this.#environment.replaceState(
        this.#historyState(
          this.#snapshot.canonicalUrl,
          this.#snapshot.source,
          next,
        ),
        this.#snapshot.canonicalUrl,
      );
    } catch {
      /* keep the current in-memory route */
    }
    this.#persistCurrent(next);
  }

  setIdentity(user: string | null, tenant: string | null): void {
    const nextScope = desktopRouteIdentityScope(user, tenant);
    if (nextScope === this.#identityScope) return;
    const previousScope = this.#identityScope;
    const currentState = parseHistoryState(this.#environment.historyState());
    if (currentState?.index !== null && currentState?.index !== undefined) {
      this.#historyIndex = currentState.index;
    }
    const resolution = resolveIdentityRoute(
      previousScope,
      nextScope,
      currentState,
      this.#snapshot.route.section,
    );
    this.#identityScope = nextScope;

    if (resolution.kind === "clear") {
      // Keep a harmless section location, but never retain record/query/filter
      // state after the identity boundary is intentionally cleared.
      this.#setRestoredRoute(
        { section: this.#snapshot.route.section },
        "identity",
        0,
      );
      return;
    }

    if (resolution.kind === "adopt-current") {
      this.#replaceCurrent("identity", resolution.scrollTop);
      this.#persistCurrent(resolution.scrollTop);
      return;
    }

    // `restore-scoped` implies a non-null next scope.
    const persisted =
      this.#readSessionRoute(resolution.scope) ??
      this.#readPersisted(resolution.scope);
    this.#setRestoredRoute(
      persisted?.route ?? { section: "dashboard" },
      "identity",
      persisted?.scrollTop ?? 0,
    );
  }

  /** Erase exact process routes and downgrade the mounted URL for sign-out. */
  prepareForSignOut(): void {
    const previousScope = this.#identityScope;
    this.#sessionRoutes.clear();
    this.#identityScope = null;
    if (previousScope) {
      try {
        this.#environment.removeStorage(routeStorageKey(previousScope));
      } catch {
        // The shared storage sweep will make another best-effort attempt.
      }
    }
    this.#setRestoredRoute(
      { section: safePersistentSection(this.#snapshot.route) },
      "identity",
      0,
    );
  }

  #onPopState(rawState: unknown): void {
    const parsed = parseDesktopRoute(this.#environment.location());
    const state = parseHistoryState(rawState);
    const observation = createApprovedBackObservation(
      parsed.ok ? parsed.canonicalUrl : null,
      state,
    );
    const current = this.#approvedBackCurrent();
    const approvedBack = this.#approvedBackTransition;
    if (approvedBack !== null) {
      const matchedTraversal = consumeApprovedBackTraversal(approvedBack);
      const observedIndex = approvedBackObservedIndex(
        observation,
        matchedTraversal,
      );
      if (observedIndex !== null) {
        this.#historyIndex = Math.max(0, Math.trunc(observedIndex));
        approvedBack.physicalIndex = this.#historyIndex;
      } else {
        approvedBack.physicalIndex = null;
      }
      const action = resolveApprovedBackPop(
        approvedBack,
        current,
        observation,
        matchedTraversal,
        approvedBack.physicalIndex,
      );
      if (action.kind === "apply") {
        if (parsed.ok && state !== null) {
          this.#applyHistoryRoute(parsed, state);
          this.#finishApprovedBackIfDrained(approvedBack, action.result);
        } else {
          this.#repairApprovedBackAtCurrentPosition(
            approvedBack,
            this.#historyIndex,
          );
          this.#finishApprovedBackIfDrained(approvedBack, "failed");
        }
        return;
      }
      if (action.kind === "go") {
        if (action.fallbackIndex !== null) {
          this.#historyIndex = Math.max(0, Math.trunc(action.fallbackIndex));
          approvedBack.physicalIndex = this.#historyIndex;
        }
        if (this.#issueApprovedBackTraversal(approvedBack, action)) {
          this.#completeApprovedBackSilentAlignment(approvedBack);
          this.#scheduleApprovedBackRecoveryIfNeeded(approvedBack);
          return;
        }
      }
      const repairIndex =
        action.kind === "go" ? action.fallbackIndex : action.index;
      if (repairIndex === null) return;
      this.#repairApprovedBackAtCurrentPosition(approvedBack, repairIndex);
      this.#finishApprovedBackIfDrained(
        approvedBack,
        action.kind === "go" ? approvedBack.restorationResult : action.result,
      );
      return;
    }
    if (this.#pendingHistoryTransition) {
      this.#handlePendingHistoryPop(parsed, state);
      return;
    }
    if (!parsed.ok) {
      this.#setRestoredRoute({ section: "dashboard" }, "history", 0);
      return;
    }
    if (
      this.#identityScope &&
      state?.scope != null &&
      state.scope !== this.#identityScope
    ) {
      const persisted = this.#readPersisted(this.#identityScope);
      this.#setRestoredRoute(
        persisted?.route ?? { section: "dashboard" },
        "identity",
        persisted?.scrollTop ?? 0,
      );
      return;
    }
    if (
      parsed.canonicalUrl !== this.#snapshot.canonicalUrl &&
      this.#historyTransitionGuard?.shouldIntercept({
        from: this.#snapshot.route,
        to: parsed.route,
      })
    ) {
      this.#beginGuardedHistoryTransition(parsed, state);
      return;
    }
    this.#applyHistoryRoute(parsed, state);
  }

  #approvedBackCurrent(): ApprovedDesktopBackCurrent {
    return {
      canonicalUrl: this.#snapshot.canonicalUrl,
      index: this.#historyIndex,
      revision: this.#snapshot.revision,
      scope: this.#identityScope,
    };
  }

  #readApprovedBackObservation(): ApprovedDesktopBackObservation {
    const parsed = parseDesktopRoute(this.#environment.location());
    return createApprovedBackObservation(
      parsed.ok ? parsed.canonicalUrl : null,
      parseHistoryState(this.#environment.historyState()),
    );
  }

  #issueApprovedBackTraversal(
    transition: ApprovedDesktopBackTransition,
    action: Extract<ApprovedDesktopBackAction, { kind: "go" }>,
  ): boolean {
    const result = issueApprovedBackTraversal(transition, action, {
      go: (delta) => this.#environment.go(delta),
      location: () => this.#environment.location(),
      observation: () => this.#readApprovedBackObservation(),
    });
    if (result.observedIndex !== null) {
      this.#historyIndex = Math.max(0, Math.trunc(result.observedIndex));
      transition.physicalIndex = this.#historyIndex;
    }
    return result.issued;
  }

  #completeApprovedBackSilentAlignment(
    transition: ApprovedDesktopBackTransition,
  ): void {
    if (this.#approvedBackTransition !== transition) return;
    const alignedIndex = alignedApprovedBackRepairIndex(
      transition,
      this.#readApprovedBackObservation(),
      transition.physicalIndex,
    );
    if (alignedIndex === null) return;
    this.#repairApprovedBackAtCurrentPosition(transition, alignedIndex);
    this.#finishApprovedBackIfDrained(transition, transition.restorationResult);
  }

  #finishApprovedBackIfDrained(
    transition: ApprovedDesktopBackTransition,
    result: ApprovedDesktopBackResult,
  ): void {
    if (this.#approvedBackTransition !== transition) return;
    if (approvedBackHasOutstandingTraversals(transition)) return;
    this.#finishApprovedBackTransition(result);
  }

  #scheduleApprovedBackRecoveryIfNeeded(
    transition: ApprovedDesktopBackTransition,
  ): void {
    const alignedIndex = (): number | null =>
      alignedApprovedBackRepairIndex(
        transition,
        this.#readApprovedBackObservation(),
        transition.physicalIndex,
      );
    scheduleApprovedBackRecovery(transition, {
      alignedIndex,
      finish: () =>
        this.#finishApprovedBackIfDrained(
          transition,
          transition.restorationResult,
        ),
      isCurrent: () => this.#approvedBackTransition === transition,
      physicalIndex: () => transition.physicalIndex,
      repair: (index) =>
        this.#repairApprovedBackAtCurrentPosition(transition, index),
    });
  }

  #quarantineTimedOutApprovedBack(
    transition: ApprovedDesktopBackTransition,
  ): void {
    const action = beginApprovedBackQuarantine(
      transition,
      this.#approvedBackCurrent(),
      transition.physicalIndex,
    );
    if (action?.kind === "repair") {
      this.#repairApprovedBackAtCurrentPosition(transition, action.index);
    } else if (action?.kind === "go") {
      if (action.fallbackIndex !== null) {
        this.#historyIndex = Math.max(0, Math.trunc(action.fallbackIndex));
        transition.physicalIndex = this.#historyIndex;
      }
      if (!this.#issueApprovedBackTraversal(transition, action)) {
        if (action.fallbackIndex !== null) {
          this.#repairApprovedBackAtCurrentPosition(
            transition,
            action.fallbackIndex,
          );
        }
      }
    }
    if (this.#approvedBackTransition !== transition) return;
    this.#completeApprovedBackSilentAlignment(transition);
    if (this.#approvedBackTransition !== transition) return;
    const retainForLatePop = approvedBackHasOutstandingTraversals(transition);
    this.#settleApprovedBackTransition(
      transition,
      transition.restorationResult,
      retainForLatePop,
    );
    if (retainForLatePop) {
      this.#scheduleApprovedBackRecoveryIfNeeded(transition);
    }
  }

  #repairApprovedBackAtCurrentPosition(
    transition: ApprovedDesktopBackTransition,
    observedIndex: number,
  ): void {
    if (transition.recoveryTimeout !== null) {
      clearTimeout(transition.recoveryTimeout);
      transition.recoveryTimeout = null;
    }
    const safeIndex = Math.max(0, Math.trunc(observedIndex));
    this.#historyIndex = safeIndex;
    transition.physicalIndex = safeIndex;
    try {
      this.#environment.replaceState(
        this.#historyState(
          this.#snapshot.canonicalUrl,
          this.#snapshot.source,
          0,
          safeIndex,
        ),
        this.#snapshot.canonicalUrl,
      );
    } catch {
      /* keep the authoritative in-memory route */
    }
    transition.protectedCanonicalUrl = this.#snapshot.canonicalUrl;
    transition.protectedIndex = safeIndex;
    transition.protectedRevision = this.#snapshot.revision;
    transition.protectedScope = this.#identityScope;
    this.#persistCurrent(0);
  }

  #settleApprovedBackTransition(
    transition: ApprovedDesktopBackTransition,
    result: ApprovedDesktopBackResult,
    retainForLatePop: boolean,
  ): void {
    const released = settleApprovedBackTransition(
      transition,
      result,
      retainForLatePop,
    );
    if (released && this.#approvedBackTransition === transition) {
      this.#approvedBackTransition = null;
    }
  }

  #finishApprovedBackTransition(result: ApprovedDesktopBackResult): void {
    const transition = this.#approvedBackTransition;
    if (!transition) return;
    this.#settleApprovedBackTransition(transition, result, false);
  }

  #applyHistoryRoute(
    parsed: Extract<DesktopRouteParseResult, { ok: true }>,
    state: DesktopHistoryState | null,
  ): void {
    if (state?.index !== null && state?.index !== undefined) {
      this.#historyIndex = state.index;
      if (this.#approvedBackTransition !== null) {
        this.#approvedBackTransition.physicalIndex = state.index;
      }
    }
    this.#snapshot = {
      route: parsed.route,
      canonicalUrl: parsed.canonicalUrl,
      revision: this.#snapshot.revision + 1,
      source: "history",
      restoreScrollTop:
        state?.canonicalUrl === parsed.canonicalUrl
          ? clampedScrollTop(state.scrollTop)
          : 0,
    };
    this.#replaceCurrent("history", this.#snapshot.restoreScrollTop ?? 0);
    this.#persistCurrent(this.#snapshot.restoreScrollTop ?? 0);
    this.#emit();
  }

  #beginGuardedHistoryTransition(
    parsed: Extract<DesktopRouteParseResult, { ok: true }>,
    state: DesktopHistoryState | null,
  ): void {
    const targetIndex = state?.index ?? null;
    const delta = targetIndex === null ? 0 : this.#historyIndex - targetIndex;
    const transition: PendingDesktopHistoryTransition = {
      parsed,
      state,
      targetIndex,
      delta,
      phase: targetIndex !== null && delta !== 0 ? "rolling-back" : "reviewing",
      resumeResolve: null,
    };
    this.#pendingHistoryTransition = transition;

    if (transition.phase === "rolling-back") {
      try {
        this.#environment.go(delta);
        return;
      } catch {
        transition.phase = "reviewing";
      }
    }

    // Compatibility for pre-index history entries: keep the current route
    // mounted while the decision is open, then replace this history position
    // with the target only after the user resolves the lifecycle review.
    this.#replaceCurrent(this.#snapshot.source, 0);
    this.#requestGuardedHistoryTransition(transition);
  }

  #handlePendingHistoryPop(
    parsed: DesktopRouteParseResult,
    state: DesktopHistoryState | null,
  ): void {
    const transition = this.#pendingHistoryTransition;
    if (!transition) return;

    if (
      transition.phase === "rolling-back" &&
      parsed.ok &&
      parsed.canonicalUrl === this.#snapshot.canonicalUrl
    ) {
      transition.phase = "reviewing";
      this.#requestGuardedHistoryTransition(transition);
      return;
    }

    if (
      transition.phase === "resuming" &&
      parsed.ok &&
      parsed.canonicalUrl === transition.parsed.canonicalUrl &&
      (transition.targetIndex === null ||
        state?.index === transition.targetIndex)
    ) {
      this.#pendingHistoryTransition = null;
      this.#applyHistoryRoute(transition.parsed, state ?? transition.state);
      transition.resumeResolve?.();
      return;
    }

    // Back/Forward pressed again while a decision is open: restore the route
    // being protected and leave the existing review as the sole transition.
    const observedIndex = state?.index ?? null;
    if (observedIndex !== null && observedIndex !== this.#historyIndex) {
      try {
        this.#environment.go(this.#historyIndex - observedIndex);
      } catch {
        this.#replaceCurrent(this.#snapshot.source, 0);
      }
    } else if (
      !parsed.ok ||
      parsed.canonicalUrl !== this.#snapshot.canonicalUrl
    ) {
      this.#replaceCurrent(this.#snapshot.source, 0);
    }
  }

  #requestGuardedHistoryTransition(
    transition: PendingDesktopHistoryTransition,
  ): void {
    const guard = this.#historyTransitionGuard;
    if (!guard || this.#pendingHistoryTransition !== transition) {
      this.#pendingHistoryTransition = null;
      return;
    }
    void guard
      .request(
        { from: this.#snapshot.route, to: transition.parsed.route },
        () => this.#resumeGuardedHistoryTransition(transition),
      )
      .catch(() => undefined)
      .finally(() => {
        if (
          this.#pendingHistoryTransition === transition &&
          transition.phase === "reviewing"
        ) {
          this.#pendingHistoryTransition = null;
        }
      });
  }

  #resumeGuardedHistoryTransition(
    transition: PendingDesktopHistoryTransition,
  ): Promise<void> {
    if (
      this.#pendingHistoryTransition !== transition ||
      transition.phase !== "reviewing"
    ) {
      return Promise.resolve();
    }
    transition.phase = "resuming";
    return new Promise((resolve) => {
      transition.resumeResolve = resolve;
      if (transition.targetIndex !== null && transition.delta !== 0) {
        try {
          this.#environment.go(-transition.delta);
          return;
        } catch {
          // Fall through to the pre-index replacement path.
        }
      }
      this.#pendingHistoryTransition = null;
      this.#applyHistoryRoute(transition.parsed, transition.state);
      resolve();
    });
  }

  #setRestoredRoute(
    route: DesktopRoute,
    source: DesktopRouteSource,
    scrollTop: number,
  ): void {
    const canonicalUrl = serializeDesktopRoute(route);
    const parsed = parseDesktopRoute(canonicalUrl);
    if (!parsed.ok) return;
    this.#snapshot = {
      route: parsed.route,
      canonicalUrl,
      revision: this.#snapshot.revision + 1,
      source,
      restoreScrollTop: clampedScrollTop(scrollTop),
    };
    this.#replaceCurrent(source, scrollTop);
    this.#persistCurrent(scrollTop);
    this.#emit();
  }

  #replaceCurrent(source: DesktopRouteSource, scrollTop: number): void {
    this.#syncHistoryIndexFromEnvironment();
    try {
      this.#environment.replaceState(
        this.#historyState(
          this.#snapshot.canonicalUrl,
          source,
          clampedScrollTop(scrollTop),
        ),
        this.#snapshot.canonicalUrl,
      );
    } catch {
      /* keep the current in-memory route */
    }
  }

  #syncHistoryIndexFromEnvironment(): void {
    const current = parseHistoryState(this.#environment.historyState());
    if (current?.index !== null && current?.index !== undefined) {
      this.#historyIndex = current.index;
      if (this.#approvedBackTransition !== null) {
        this.#approvedBackTransition.physicalIndex = current.index;
      }
    }
  }

  #historyState(
    canonicalUrl: string,
    source: DesktopRouteSource,
    scrollTop: number,
    index = this.#historyIndex,
  ): DesktopHistoryState {
    return createDesktopHistoryState({
      canonicalUrl,
      scope: this.#identityScope,
      source,
      scrollTop,
      index,
    });
  }

  #pruneSessionRoutes(now: number): void {
    for (const [scope, record] of this.#sessionRoutes) {
      if (
        !routeTimestampIsCurrent(record.touchedAt, SESSION_ROUTE_TTL_MS, now)
      ) {
        this.#sessionRoutes.delete(scope);
      }
    }
    if (this.#sessionRoutes.size <= SESSION_ROUTE_SCOPE_MAX) return;
    const oldest = [...this.#sessionRoutes.entries()].sort(
      ([, left], [, right]) => left.touchedAt - right.touchedAt,
    );
    for (const [scope] of oldest.slice(
      0,
      this.#sessionRoutes.size - SESSION_ROUTE_SCOPE_MAX,
    )) {
      this.#sessionRoutes.delete(scope);
    }
  }

  #readSessionRoute(scope: string): PersistedDesktopRoute | null {
    const now = Date.now();
    this.#pruneSessionRoutes(now);
    const record = this.#sessionRoutes.get(scope);
    if (!record) return null;
    record.touchedAt = now;
    return { route: record.route, scrollTop: record.scrollTop };
  }

  #readPersisted(scope: string): PersistedDesktopRoute | null {
    const key = routeStorageKey(scope);
    try {
      const value = this.#environment.getStorage(key);
      if (!value) return null;
      if (value.length > MAX_PERSISTED_ROUTE_CHARS) {
        this.#environment.removeStorage(key);
        return null;
      }
      const decoded = JSON.parse(value) as unknown;
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        this.#environment.removeStorage(key);
        return null;
      }
      const record = decoded as Partial<DurableDesktopRoute>;
      if (
        record.version !== ROUTE_STORAGE_VERSION ||
        !record.section ||
        !PERSISTENT_SECTION_SET.has(record.section) ||
        !routeTimestampIsCurrent(
          record.savedAt ?? Number.NaN,
          ROUTE_STORAGE_TTL_MS,
          Date.now(),
        )
      ) {
        // Exact v1 URLs can contain subscriber emails, raw resource IDs,
        // customer searches, filters, overlays, and tab state. Never adopt
        // them into the destination-only v2 record.
        this.#environment.removeStorage(key);
        return null;
      }
      const canonical = JSON.stringify({
        version: ROUTE_STORAGE_VERSION,
        section: record.section,
        savedAt: record.savedAt!,
      } satisfies DurableDesktopRoute);
      if (canonical !== value) this.#environment.setStorage(key, canonical);
      return { route: { section: record.section }, scrollTop: 0 };
    } catch {
      try {
        this.#environment.removeStorage(key);
      } catch {
        // Storage is optional; remain on the safe default route.
      }
      return null;
    }
  }

  #persistCurrent(scrollTop: number): void {
    if (!this.#identityScope) return;
    const now = Date.now();
    this.#sessionRoutes.set(this.#identityScope, {
      route: this.#snapshot.route,
      scrollTop: clampedScrollTop(scrollTop),
      touchedAt: now,
    });
    this.#pruneSessionRoutes(now);
    try {
      this.#environment.setStorage(
        routeStorageKey(this.#identityScope),
        JSON.stringify({
          version: ROUTE_STORAGE_VERSION,
          section: safePersistentSection(this.#snapshot.route),
          savedAt: now,
        } satisfies DurableDesktopRoute),
      );
    } catch {
      // Storage can be unavailable in hardened/private webviews. Browser
      // history still works for the current process.
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const desktopRouter = new DesktopRouterController(
  createBrowserDesktopRouterEnvironment(),
);
let desktopScrollReader: (() => number) | null = null;

registerPrivateSessionReset("desktop-router", () => {
  desktopRouter.prepareForSignOut();
});

desktopRouter.setHistoryTransitionGuard({
  shouldIntercept: (transition) =>
    !isInPlaceSettingsAnchorTransition(transition.from, transition.to) &&
    !isInPlacePersistentTabTransition(transition.from, transition.to) &&
    shouldCoordinateLifecycle("route-change"),
  request: (transition, resume) =>
    requestLifecycleTransition(
      desktopRouteLifecycleIntent(transition.from, transition.to),
      resume,
    ),
});

function captureDesktopRouteScroll(): void {
  if (!desktopScrollReader) return;
  try {
    desktopRouter.recordScroll(desktopScrollReader());
  } catch {
    // A detached content node must never block navigation.
  }
}

export function getDesktopRouteSnapshot(): DesktopRouteSnapshot {
  return desktopRouter.getSnapshot();
}

export function getDesktopRoute(): DesktopRoute {
  return desktopRouter.getSnapshot().route;
}

export function subscribeDesktopRoute(listener: () => void): () => void {
  return desktopRouter.subscribe(listener);
}

export function navigateDesktopRoute(
  route: DesktopRoute,
  options?: DesktopNavigateOptions,
): void {
  void requestDesktopRouteNavigation(route, options);
}

export function navigateDesktopSection(
  section: Section,
  options?: DesktopNavigateOptions,
): void {
  void requestDesktopRouteNavigation(routeForDesktopSection(section), options);
}

export function navigateDesktopResource(
  section: RoutableDesktopSection,
  resourceId: string,
  options?: DesktopNavigateOptions,
): void {
  void requestDesktopRouteNavigation({ section, resourceId }, options);
}

/**
 * Replace one exact overlay after its owning controller has explicitly closed
 * or completed the task. Back/Forward and ordinary route changes must keep
 * using the lifecycle-coordinated navigation helpers above.
 */
export function replaceDesktopRouteAfterExplicitOverlayClose(
  section: RoutableDesktopSection,
  overlayName: string,
): boolean {
  const current = desktopRouter.getSnapshot().route;
  if (
    current.section !== section ||
    current.overlay?.name !== overlayName ||
    current.overlay.resourceId !== undefined
  ) {
    return false;
  }
  const next = { ...current };
  delete next.overlay;
  captureDesktopRouteScroll();
  desktopRouter.navigate(next, { replace: true, source: "navigation" });
  return true;
}

/** Compatibility helper for record launchers that still carry Section. */
export function navigateDesktopSectionResource(
  section: Section,
  resourceId: string,
  options?: DesktopNavigateOptions,
): void {
  const base = routeForDesktopSection(section);
  void requestDesktopRouteNavigation({ ...base, resourceId }, options);
}

/**
 * Guard a typed destination change with the same process-wide lifecycle
 * registry used by quit, sign-out, workspace switching, and update restart.
 * Existing void navigation helpers intentionally remain source-compatible;
 * callers that need an explicit outcome can await this function.
 */
export function requestDesktopRouteNavigation(
  route: DesktopRoute,
  options?: DesktopNavigateOptions,
): Promise<LifecycleTransitionResult> {
  // Validate before returning so malformed internal routes retain the former
  // synchronous TypeError behavior of DesktopRouterController.navigate().
  const canonicalUrl = serializeDesktopRoute(route);
  const parsed = parseDesktopRoute(canonicalUrl);
  if (!parsed.ok) throw new TypeError("Invalid desktop route");

  const current = desktopRouter.getSnapshot();
  const source = options?.source ?? "navigation";
  if (options?.isStillCurrent?.() === false) {
    return Promise.resolve("cancelled");
  }
  const sameRoute = canonicalUrl === current.canonicalUrl;
  if (sameRoute && !options?.replace && source !== "deep-link") {
    return Promise.resolve("proceeded");
  }

  let routeApplied = false;
  const proceed = (): void => {
    if (options?.isStillCurrent?.() === false) return;
    captureDesktopRouteScroll();
    desktopRouter.navigate(parsed.route, options);
    routeApplied = true;
  };
  if (
    isInPlaceSettingsAnchorTransition(current.route, parsed.route) ||
    isInPlacePersistentTabTransition(current.route, parsed.route) ||
    !shouldCoordinateLifecycle("route-change")
  ) {
    proceed();
    return Promise.resolve(routeApplied ? "proceeded" : "cancelled");
  }

  return requestLifecycleTransition(
    desktopRouteLifecycleIntent(current.route, parsed.route),
    proceed,
  ).then((result) =>
    result === "proceeded" && !routeApplied ? "cancelled" : result,
  );
}

/**
 * Close a route-owned transient surface through the exact entry that launched
 * it. This is intentionally separate from ordinary Back/Forward: the caller
 * must supply the recorded origin, lifecycle review runs once up front, and a
 * missing history entry is reported so the caller can safely replace instead.
 */
export async function requestDesktopRouteBackNavigation(
  expectedRoute: DesktopRoute,
  isStillCurrent?: () => boolean,
): Promise<LifecycleTransitionResult> {
  const canonicalUrl = serializeDesktopRoute(expectedRoute);
  const parsed = parseDesktopRoute(canonicalUrl);
  if (!parsed.ok) throw new TypeError("Invalid desktop route");

  const current = desktopRouter.getSnapshot();
  if (isStillCurrent?.() === false) return "cancelled";
  if (current.canonicalUrl === parsed.canonicalUrl) return "proceeded";

  let backResult: ApprovedDesktopBackResult | "not-started" = "not-started";
  const proceed = async (): Promise<void> => {
    if (isStillCurrent?.() === false) {
      backResult = "superseded";
      return;
    }
    captureDesktopRouteScroll();
    backResult = await desktopRouter.navigateApprovedBackTo(parsed.route, {
      isStillCurrent,
    });
    if (isStillCurrent?.() === false) backResult = "superseded";
  };
  const classifyResult = (
    lifecycleResult: LifecycleTransitionResult,
  ): LifecycleTransitionResult => {
    if (lifecycleResult !== "proceeded") return lifecycleResult;
    if (backResult === "applied") return "proceeded";
    if (backResult === "superseded") return "cancelled";
    return "failed";
  };
  if (
    isInPlacePersistentTabTransition(current.route, parsed.route) ||
    !shouldCoordinateLifecycle("route-change")
  ) {
    await proceed();
    return classifyResult("proceeded");
  }

  const result = await requestLifecycleTransition(
    desktopRouteLifecycleIntent(current.route, parsed.route),
    proceed,
  );
  return classifyResult(result);
}

/**
 * Settings anchor changes move focus/scroll inside one mounted document. They
 * cannot abandon a draft, upload, or operation, so lifecycle review would be
 * both misleading and destructive to navigation flow. Every other route
 * field must remain identical for this narrow fast path.
 */
export function isInPlaceSettingsAnchorTransition(
  from: DesktopRoute,
  to: DesktopRoute,
): boolean {
  if (from.section !== "settings" || to.section !== "settings") return false;
  const fromBase = serializeDesktopRoute({
    ...from,
    settingsAnchor: undefined,
  });
  const toBase = serializeDesktopRoute({ ...to, settingsAnchor: undefined });
  return fromBase === toBase && from.settingsAnchor !== to.settingsAnchor;
}

/**
 * API Playground tabs intentionally share one lifted controller: drafts,
 * responses, cancellation, and encrypted-history ownership survive while the
 * visible subview changes. Only an exact tab-only transition on that route is
 * in-place; resource, overlay, section, or any other route change still runs
 * the lifecycle review.
 */
export function isInPlacePersistentTabTransition(
  from: DesktopRoute,
  to: DesktopRoute,
): boolean {
  if (from.section !== "apiPlayground" || to.section !== "apiPlayground") {
    return false;
  }
  const fromBase = serializeDesktopRoute({ ...from, tab: undefined });
  const toBase = serializeDesktopRoute({ ...to, tab: undefined });
  return fromBase === toBase && from.tab !== to.tab;
}

function desktopRouteLifecycleIntent(
  from: DesktopRoute,
  to: DesktopRoute,
): LifecycleIntent {
  const target = routeMetaForSection(to.section).title;
  const origin = routeMetaForSection(from.section).title;
  return {
    kind: "route-change",
    disposition: "navigate",
    title: `Leave ${origin}?`,
    description: `Moosewave will check drafts, active operations, and recoverable work before opening ${target}.`,
    confirmLabel: `Open ${target}`,
    targetLabel: target,
  };
}

export function setDesktopRouterIdentity(
  user: string | null,
  tenant: string | null,
): void {
  desktopRouter.setIdentity(user, tenant);
}

export function recordDesktopRouteScroll(scrollTop: number): void {
  desktopRouter.recordScroll(scrollTop);
}

export function registerDesktopRouteScrollReader(
  reader: () => number,
): () => void {
  desktopScrollReader = reader;
  return () => {
    if (desktopScrollReader === reader) desktopScrollReader = null;
  };
}

export function useDesktopRouteSnapshot(): DesktopRouteSnapshot {
  return useSyncExternalStore(
    desktopRouter.subscribe,
    desktopRouter.getSnapshot,
    desktopRouter.getSnapshot,
  );
}

export function useDesktopRoute(): DesktopRoute {
  return useDesktopRouteSnapshot().route;
}

/**
 * Route-backed top-level tab state. Defaults stay out of the URL; selecting a
 * different tab creates history, so Back returns to the previous subview.
 */
export function useDesktopRouteTab<const T extends string>(
  section: RoutableDesktopSection,
  allowed: readonly T[],
  fallback: T,
): readonly [T, (next: T) => void] {
  const route = useDesktopRoute();
  const active =
    route.section === section &&
    route.tab !== undefined &&
    allowed.includes(route.tab as T)
      ? (route.tab as T)
      : fallback;
  useEffect(() => {
    if (
      route.section !== section ||
      route.tab === undefined ||
      allowed.includes(route.tab as T)
    ) {
      return;
    }
    navigateDesktopRoute(
      { ...route, tab: undefined },
      { replace: true, source: "navigation" },
    );
  }, [allowed, route, section]);
  const setTab = (next: T): void => {
    if (!allowed.includes(next)) return;
    const current = getDesktopRoute();
    const base: DesktopRoute =
      current.section === section ? current : { section };
    navigateDesktopRoute({
      ...base,
      ...(next === fallback ? { tab: undefined } : { tab: next }),
    });
  };
  return [active, setTab] as const;
}

/** Build a stable Settings anchor from a rendered heading when supported. */
export function settingsAnchorFromHeading(
  heading: string,
): SettingsAnchor | null {
  const slug = heading
    .trim()
    .toLowerCase()
    .replace(/&/gu, "and")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return SETTINGS_ANCHOR_SET.has(slug) ? (slug as SettingsAnchor) : null;
}

/** Runtime assertion used by tests and release checks for all 54 routes. */
export function persistentDesktopRouteCount(): number {
  return PERSISTENT_DESKTOP_SECTIONS.length;
}
