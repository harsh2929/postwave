/**
 * lib/landingPages.ts — every decision the landing-pages surface makes,
 * expressed with no react-native / expo / netinfo import so it is unit-testable
 * in the node vitest environment (the pattern set by lib/reviewQueue.ts and
 * lib/approvalPolicy.ts).
 *
 * THE WIRE SHAPES ARE READ OFF THE GO SOURCE, not off openapi.json:
 * `apps/api/internal/landingpages/landingpages.go` declares `LandingPage` and
 * `Conversion`, and `internal/server/analytics_realtime_routes.go:67-71` mounts
 * the four reads this app uses. Four of those facts shape this module and are
 * each easy to get wrong:
 *
 *  1. THE LIST IS A BARE ARRAY. `Deps.List` calls `writeJSON(w, 200, out)` with
 *     `out []LandingPage` — no `{items:…}` envelope. `Deps.Leads`, three
 *     handlers below it, DOES wrap: `{"items": out}`. Both parsers below accept
 *     either shape, because an envelope change that silently empties a mobile
 *     screen is the single most common failure class in this repo's mobile
 *     audit (docs/logic-audit-2026-07/mobile.md).
 *
 *  2. `metrics` IS NEVER WRITTEN. The column exists (migration 0028:282,
 *     `jsonb NOT NULL DEFAULT '{}'`) and is selected on every read, but no
 *     writer in the repository ever populates it — the public view/convert
 *     handlers record into `growth_surface_events` instead
 *     (`internal/compat/handlers.go:426,476`). So for essentially every tenant
 *     `metrics` is `{}`. `landingMetrics` therefore returns NULL, never 0, and
 *     `hasAnyMetric` exists so the UI can omit the block entirely rather than
 *     print three em-dashes on every row. Absence is not zero.
 *
 *  3. LEADS ARE CONVERSION EVENTS, AND THEY ARE CAPPED. `Repo.ListConversions`
 *     selects `growth_surface_events` rows with `event_type = 'conversion'`
 *     ordered `at DESC` with a hard `LIMIT 5000` and no cursor. `LEADS_LIMIT`
 *     lets the screen say when it is showing a truncated capture rather than
 *     implying the page has exactly 5000 leads.
 *
 *  4. THE EMAIL CAN BE EMPTY. The query is `COALESCE(email, '')` and the insert
 *     writes `NULLIF($4, '')`, so a conversion recorded without an address is a
 *     real row with an empty string. `""` must never render as a blank line
 *     pretending to be an address.
 *
 * PUBLIC URL. Built from the app origin exactly as apps/web does
 * (`apps/web/src/lib/landing-page-content.ts::publicLandingUrl` →
 * `{origin}/landing/{slug}`, rendered by `app/[locale]/landing/[slug]`). The
 * `domain` column is deliberately NOT used to build it: web ignores it too, and
 * asserting `https://{domain}/landing/{slug}` would be a URL this codebase
 * cannot show resolves. `domain` is surfaced as a labelled fact instead.
 */

/** `status` CHECK constraint on landing_pages (migration 0028:275-276). */
export const LANDING_STATUSES = ["draft", "published", "archived"] as const;

export type LandingStatus = (typeof LANDING_STATUSES)[number];

/** `Repo.ListConversions` hard-codes `LIMIT 5000`, with no cursor. */
export const LEADS_LIMIT = 5000;

export interface MobileLandingPage {
  id: string;
  slug: string;
  name: string;
  /** Widened past the union: an unrecognised status is shown verbatim. */
  status: LandingStatus | string;
  /** "" when unset — the server COALESCEs the nullable column. */
  domain: string;
  template: string;
  createdAt: string | null;
  updatedAt: string | null;
  metrics: Record<string, unknown>;
}

export interface MobileLead {
  /** "" for a conversion captured without an address. Never rendered bare. */
  email: string;
  metadata: Record<string, unknown>;
  at: string | null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** ISO timestamp or null. Go's zero time serialises as "0001-01-01T…". */
function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export function parseLandingPage(value: unknown): MobileLandingPage | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  return {
    id,
    slug: str(row["slug"]),
    name: str(row["name"]),
    status: str(row["status"]) || "draft",
    domain: str(row["domain"]),
    template: str(row["template"]),
    createdAt: timestamp(row["created_at"]),
    updatedAt: timestamp(row["updated_at"]),
    metrics: record(row["metrics"]),
  };
}

/** Accepts the bare array the handler sends, and an `{items:[…]}` envelope. */
export function parseLandingPageList(payload: unknown): MobileLandingPage[] {
  const items = record(payload)["items"];
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(items)
      ? (items as unknown[])
      : [];
  return source
    .map(parseLandingPage)
    .filter((page): page is MobileLandingPage => page !== null);
}

export function parseLead(value: unknown): MobileLead | null {
  const row = record(value);
  const at = timestamp(row["at"]);
  const email = str(row["email"]);
  // A conversion with neither an address nor a time carries no information a
  // person could act on, and is far more likely to be a shape mismatch.
  if (!email && !at) return null;
  return { email, metadata: record(row["metadata"]), at };
}

/** `Deps.Leads` wraps in `{items:…}`; a bare array is accepted for symmetry. */
export function parseLeadList(payload: unknown): MobileLead[] {
  const items = record(payload)["items"];
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(items)
      ? (items as unknown[])
      : [];
  return source
    .map(parseLead)
    .filter((lead): lead is MobileLead => lead !== null);
}

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

export interface LandingStatusPresentation {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  /**
   * Whether the page is reachable by the public right now. Only `published`
   * rows are served: `Repo.PublicLandingPage` filters `status = 'published'`
   * and the RLS policy `landing_pages_public_lookup` requires it too.
   */
  live: boolean;
}

export function landingStatusPresentation(
  status: string,
): LandingStatusPresentation {
  switch (status.trim().toLowerCase()) {
    case "published":
      return { label: "Published", tone: "success", live: true };
    case "draft":
      return { label: "Draft", tone: "warning", live: false };
    case "archived":
      return { label: "Archived", tone: "neutral", live: false };
    default:
      // Never let an unknown status read as live. Show it verbatim so an
      // operator can report exactly what they saw.
      return { label: status.trim() || "Unknown", tone: "neutral", live: false };
  }
}

export const LANDING_STATUS_FILTERS = [
  "all",
  "published",
  "draft",
  "archived",
] as const;

export type LandingStatusFilter = (typeof LANDING_STATUS_FILTERS)[number];

export function landingStatusCounts(
  pages: readonly MobileLandingPage[],
): Record<LandingStatusFilter, number> {
  const counts: Record<LandingStatusFilter, number> = {
    all: pages.length,
    published: 0,
    draft: 0,
    archived: 0,
  };
  for (const page of pages) {
    const status = page.status.trim().toLowerCase();
    if (status === "published") counts.published += 1;
    else if (status === "draft") counts.draft += 1;
    else if (status === "archived") counts.archived += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Filter / order
// ---------------------------------------------------------------------------

/**
 * Free text matches name OR slug — the slug is what appears in the URL a
 * colleague pastes into chat, so it is at least as likely a search term as the
 * editor-visible name. Mirrors `filterLandingPages` in apps/web.
 */
export function filterLandingPages(
  pages: readonly MobileLandingPage[],
  options: { q?: string; status?: LandingStatusFilter },
): MobileLandingPage[] {
  const needle = (options.q ?? "").trim().toLowerCase();
  const status = options.status ?? "all";
  return pages.filter((page) => {
    if (status !== "all" && page.status.trim().toLowerCase() !== status) {
      return false;
    }
    if (!needle) return true;
    return (
      page.name.toLowerCase().includes(needle) ||
      page.slug.toLowerCase().includes(needle)
    );
  });
}

/**
 * Order is a product decision, not a server one: `Repo.List` returns
 * `created_at DESC`, which buries the page someone published this morning
 * under every page ever created. Most-recently-EDITED first answers the
 * question this screen exists for ("what is live, and what changed"). Rows
 * with no parsable `updated_at` sort last rather than to the epoch, so junk
 * data cannot take the head of the list.
 */
export function orderLandingPages(
  pages: readonly MobileLandingPage[],
): MobileLandingPage[] {
  return [...pages].sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : Number.NaN;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : Number.NaN;
    const aMissing = Number.isNaN(at);
    const bMissing = Number.isNaN(bt);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return bt - at;
  });
}

// ---------------------------------------------------------------------------
// Metrics — see header note 2. Null means "not measured", never zero.
// ---------------------------------------------------------------------------

export interface LandingMetrics {
  views: number | null;
  conversions: number | null;
  /** Whole percent, 0–100. */
  conversionRate: number | null;
}

function numeric(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const raw = source[key];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (raw !== null && raw !== undefined && raw !== "" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/**
 * Key aliases are copied verbatim from apps/web's `landingMetrics`
 * (src/lib/landing-list-helpers.ts:71) so the two clients cannot disagree about
 * what a given payload means.
 */
export function landingMetrics(
  page: Pick<MobileLandingPage, "metrics">,
): LandingMetrics {
  const m = page.metrics;
  const views = numeric(m, ["views", "view", "total_views", "visits"]);
  const conversions = numeric(m, [
    "conversions",
    "conversion",
    "total_conversions",
    "signups",
  ]);
  const explicit = numeric(m, ["conversion_rate", "conversionRate"]);
  let conversionRate: number | null = null;
  if (explicit !== null) {
    conversionRate = Math.round(explicit <= 1 ? explicit * 100 : explicit);
  } else if (views !== null && conversions !== null) {
    conversionRate = views > 0 ? Math.round((conversions / views) * 100) : 0;
  }
  return { views, conversions, conversionRate };
}

/** False when the server measured nothing — the block is then omitted. */
export function hasAnyMetric(metrics: LandingMetrics): boolean {
  return metrics.views !== null || metrics.conversions !== null;
}

// ---------------------------------------------------------------------------
// Public URL
// ---------------------------------------------------------------------------

/** Locale-agnostic public path. Mirrors apps/web `publicLandingPath`. */
export function publicLandingPath(slug: string): string {
  return `/landing/${encodeURIComponent(slug)}`;
}

/**
 * Absolute public URL, or null when there is nothing honest to build: a page
 * with no slug has no address, and a page that is not published is not served
 * (`Repo.PublicLandingPage` filters `status = 'published'`), so offering a
 * copyable link to it would hand someone a 404 to paste into a campaign.
 */
export function publicLandingUrl(
  origin: string,
  page: Pick<MobileLandingPage, "slug" | "status">,
): string | null {
  const slug = page.slug.trim();
  if (!slug) return null;
  if (!landingStatusPresentation(page.status).live) return null;
  return `${origin.replace(/\/+$/u, "")}${publicLandingPath(slug)}`;
}

/** Why the copyable link is absent, in the user's terms. */
export function publicUrlUnavailableReason(
  page: Pick<MobileLandingPage, "slug" | "status">,
): string | null {
  if (!page.slug.trim()) return "This page has no slug, so it has no address.";
  if (!landingStatusPresentation(page.status).live) {
    return "Draft and archived pages aren't served publicly, so there's no link to share yet.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/** `""` is a real row (see header note 4); it gets words, not a blank line. */
export function leadDisplayEmail(lead: MobileLead): string {
  return lead.email || "No email captured";
}

export function leadsTruncated(count: number): boolean {
  return count >= LEADS_LIMIT;
}

export interface LeadDetail {
  key: string;
  value: string;
}

/**
 * Whatever the capture actually carried, rendered as label/value pairs. The
 * metadata blob is caller-supplied JSON (`POST /api/public/landing-pages/
 * {slug}/convert` passes `body.Metadata` straight through), so there is no
 * fixed schema to lay out — inventing field names would be inventing data.
 * Keys are sorted for a stable order, objects are JSON-stringified, and both
 * the count and each value are bounded so one hostile payload cannot blow the
 * row's height out.
 */
export function leadDetails(
  lead: MobileLead,
  options: { maxEntries?: number; maxValueLength?: number } = {},
): LeadDetail[] {
  const maxEntries = options.maxEntries ?? 4;
  const maxValueLength = options.maxValueLength ?? 60;
  const out: LeadDetail[] = [];
  for (const key of Object.keys(lead.metadata).sort()) {
    if (out.length >= maxEntries) break;
    const value = formatMetadataValue(lead.metadata[key], maxValueLength);
    if (!value) continue;
    out.push({ key: humanizeKey(key), value });
  }
  return out;
}

function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/gu, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function formatMetadataValue(value: unknown, max: number): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") text = value.trim();
  else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
  const flat = text.replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
