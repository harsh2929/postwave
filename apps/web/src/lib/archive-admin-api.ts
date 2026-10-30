/**
 * lib/archive-admin-api.ts — public archive settings and reader tipping.
 *
 * Three `/api/v1/admin/archive/*` paths were reached by desktop and by no web
 * file: tenant-settings, domain and domain/verify.
 *
 * AMOUNTS ARE IN CENTS. `tips_suggested_amounts: [300, 500, 1000, 2500]` is
 * $3 / $5 / $10 / $25, and `tips_min_amount: 100` is $1. Rendered without
 * dividing, a reader is offered a $300 tip. This is the SECOND cents trap in
 * this sweep after api-usage, and it is the more dangerous of the two because
 * these numbers are shown to the public rather than to an operator.
 *
 * An empty `tenant_archive_slug` means the archive has no address yet, which
 * is why the settings below have nowhere to apply — worth saying rather than
 * rendering a form that appears live.
 *
 * This module also owns the authenticated operational projection used by the
 * Archive page. Public delivery controls intentionally do not live here: the
 * web surface can inspect published issues and an admin can remove one in an
 * emergency, but publishing/editing/pinning remain review-gated.
 */
import { api } from "@/lib/api";
import { archiveRSSURL, archiveSitemapURL } from "@/lib/archive-api";
import {
  requireCustomDomainOperation,
  requireCustomDomainValueUnchanged,
} from "@/lib/custom-domain-operational-availability";
import { defaultLocale } from "@/i18n/locales";

export interface ArchiveSettings {
  tenant_archive_slug: string;
  archive_domain: string;
  archive_title: string;
  archive_tagline: string;
  tips_enabled: boolean;
  tips_currency: string;
  /** CENTS. Divide before display. */
  tips_suggested_amounts: number[];
  /** CENTS. */
  tips_min_amount: number;
  tips_message: string;
  archive_bar_default_enabled: boolean;
  view_in_browser_default_enabled: boolean;
}

type ArchiveSignalInput = AbortSignal | { signal: AbortSignal };

function archiveRequestSignal(
  input?: ArchiveSignalInput,
): AbortSignal | undefined {
  return input && "signal" in input ? input.signal : input;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function getArchiveSettings(
  signal?: ArchiveSignalInput,
): Promise<ArchiveSettings> {
  const res = await api.get<ArchiveSettings>(
    "/api/v1/admin/archive/tenant-settings",
    { signal: archiveRequestSignal(signal) },
  );
  return parseArchiveSettings(res);
}

function parseArchiveSettings(
  res: Partial<ArchiveSettings> | null | undefined,
): ArchiveSettings {
  return {
    tenant_archive_slug: str(res?.tenant_archive_slug),
    archive_domain: str(res?.archive_domain),
    archive_title: str(res?.archive_title),
    archive_tagline: str(res?.archive_tagline),
    tips_enabled: res?.tips_enabled === true,
    tips_currency: str(res?.tips_currency) || "usd",
    tips_suggested_amounts: asArray<number>(res?.tips_suggested_amounts).map(
      num,
    ),
    tips_min_amount: num(res?.tips_min_amount),
    tips_message: str(res?.tips_message),
    archive_bar_default_enabled: res?.archive_bar_default_enabled === true,
    view_in_browser_default_enabled:
      res?.view_in_browser_default_enabled === true,
  };
}

/** Cents to a currency string. The wire speaks cents; readers see money. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format((Number.isFinite(cents) ? cents : 0) / 100);
}

/** True when the archive has no address, so nothing below is reachable. */
export function archiveHasNoAddress(s: ArchiveSettings): boolean {
  return !s.tenant_archive_slug && !s.archive_domain;
}

/**
 * The four reader-facing URLs for a tenant's public archive.
 *
 * Built entirely on the client from the tenant settings the admin already
 * loaded — there is no server endpoint that hands these out, which is why
 * desktop's ArchiveShareControls composes them the same way.
 *
 * TWO DIFFERENT ORIGINS, and the distinction is load-bearing:
 *
 *   - With a custom domain the vanity host is CNAME'd at Moosewave and the API
 *     rewrites `/`, `/feed.xml`, and `/sitemap.xml` onto the tenant's public
 *     paths (apps/api/internal/archive/custom_domain.go:customDomainArchivePath).
 *     All three therefore hang off the vanity root.
 *   - Without one, the INDEX is served by this web app at
 *     `/{locale}/archive/{slug}`, while the feed and sitemap are rendered by
 *     the API. Pointing all three at one origin would hand out two dead links.
 *
 * Returns null when the archive has no address at all: callers must disable
 * their copy/open affordances rather than emit a URL that resolves nowhere.
 */
export interface ArchiveShareTargets {
  /** Human-readable base shown next to the controls. */
  indexBase: string;
  publicIndexUrl: string;
  rssUrl: string;
  sitemapUrl: string;
}

/** Normalizes a configured archive domain to a bare, safe https host. */
function archiveVanityHost(rawDomain: string): string | null {
  const trimmed = rawDomain.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed
    .replace(/^https?:\/\//iu, "")
    .replace(/\/+$/u, "");
  if (!withoutScheme || CONTROL_CHARACTER_RE.test(withoutScheme)) return null;
  try {
    const parsed = new URL(`https://${withoutScheme}`);
    // A configured value carrying a path, query, credentials, or a different
    // host than we asked for is not a bare vanity host; refusing it keeps a
    // malformed setting from becoming a link we hand a reader.
    if (
      parsed.host !== withoutScheme.toLowerCase() ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.host;
  } catch {
    return null;
  }
}

export function archiveShareTargets(
  settings: ArchiveSettings,
  appOrigin: string,
): ArchiveShareTargets | null {
  const host = archiveVanityHost(settings.archive_domain);
  if (host) {
    const base = `https://${host}`;
    return {
      indexBase: base,
      publicIndexUrl: base,
      rssUrl: `${base}/feed.xml`,
      sitemapUrl: `${base}/sitemap.xml`,
    };
  }
  const slug = settings.tenant_archive_slug.trim();
  if (!slug || !ARCHIVE_SLUG_RE.test(slug) || slug.length > 64) return null;
  // `useAppOrigin` yields "" until the first client effect runs, which keeps
  // the rendered link a deterministic relative path across hydration.
  const base = `${appOrigin.replace(/\/+$/u, "")}/${defaultLocale}/archive/${encodeURIComponent(slug)}`;
  return {
    indexBase: base,
    publicIndexUrl: base,
    rssUrl: archiveRSSURL(slug),
    sitemapUrl: archiveSitemapURL(slug),
  };
}

/**
 * The public web version of ONE published campaign — the "Web version" card on
 * a campaign's activity page (desktop's CampaignWebVersionCard).
 *
 * It hangs off the same index as `archiveShareTargets`, for the same reason:
 * with a vanity host the API rewrites `/{campaign_slug}` onto the tenant's
 * public archive (custom_domain.go treats the first path segment as the
 * campaign slug), and without one this app serves the issue at
 * `/{locale}/archive/{tenant}/{campaign_slug}`. No server endpoint hands the
 * URL out, so it is composed here and only here.
 *
 * Null — never a guess — when the archive has no address or the campaign's
 * slug is not one the public route would accept; the caller then says what is
 * missing instead of offering a link that resolves nowhere.
 */
export function archiveIssueUrl(
  settings: ArchiveSettings,
  appOrigin: string,
  campaignArchiveSlug: string,
): string | null {
  const targets = archiveShareTargets(settings, appOrigin);
  const slug = campaignArchiveSlug.trim();
  if (
    !targets ||
    !slug ||
    slug.length > 64 ||
    !ARCHIVE_SLUG_RE.test(slug)
  ) {
    return null;
  }
  return `${targets.publicIndexUrl}/${encodeURIComponent(slug)}`;
}

export interface ArchiveDomain {
  domain: string;
  cname_target: string;
  verification_token: string;
  /** DNS state: pending | verified | failed. */
  status: "pending" | "verified" | "failed" | string;
  last_checked_at: string;
  verified_at: string;
  last_error: string;
  /** Managed-certificate state, tracked separately from DNS verification. */
  ssl_status: "pending" | "issuing" | "issued" | "failed" | string;
  ssl_last_error: string;
}

/**
 * The custom archive domain.
 *
 * BOTH STATUS FIELDS DEFAULT TO "pending" WITH NO DOMAIN SET. Rendered as-is
 * that reads as work in progress — a verification underway, a certificate
 * being issued — when in fact nothing has been requested. `domain` being empty
 * is what distinguishes "not configured" from "configured and waiting", so it
 * has to be consulted before either status is shown.
 *
 * `status` and `ssl_status` are also NOT the same question. A domain can pass
 * DNS verification and still have no certificate, so collapsing them into one
 * badge hides the half that is still blocking.
 */
export async function getArchiveDomain(
  signal?: ArchiveSignalInput,
): Promise<ArchiveDomain> {
  const r = await api.get<Partial<ArchiveDomain>>(
    "/api/v1/admin/archive/domain",
    { signal: archiveRequestSignal(signal) },
  );
  return parseArchiveDomain(r);
}

/** Runs the configured domain's synchronous DNS check and returns its verdict. */
export async function verifyArchiveDomain(
  signal?: ArchiveSignalInput,
): Promise<ArchiveDomain> {
  requireCustomDomainOperation("verification");
  const r = await api.post<Partial<ArchiveDomain>>(
    "/api/v1/admin/archive/domain/verify",
    {},
    { signal: archiveRequestSignal(signal) },
  );
  return parseArchiveDomain(r);
}

/** DNS's textual hostname ceiling; desktop's input uses the same bound. */
export const MAX_ARCHIVE_DOMAIN_LENGTH = 253;

/**
 * Normalizes an operator-typed archive host to the form the server stores:
 * trimmed and lower-case. Shape and reserved-suffix rules stay server-side
 * (`archive.ValidateArchiveDomain`), whose sentence is rendered verbatim; only
 * values no hostname can be are refused here, before a request is spent.
 */
export function normalizeArchiveDomainInput(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length > MAX_ARCHIVE_DOMAIN_LENGTH) {
    throw new ArchiveInputError(
      `An archive domain must be ${MAX_ARCHIVE_DOMAIN_LENGTH} characters or fewer.`,
    );
  }
  if (CONTROL_CHARACTER_RE.test(value) || /[\s/?#@\\]/u.test(value)) {
    throw new ArchiveInputError(
      "Enter a bare hostname such as news.example.com, with no scheme, path, or spaces.",
    );
  }
  return value;
}

/**
 * Saves the archive vanity host: PUT tenant-settings with ONLY
 * `archive_domain`. The server merges PATCH-style (a present key is written,
 * an absent key is untouched), so no other archive setting can be clobbered
 * by this call. An empty string clears the column.
 *
 * Changing the stored hostname is a custom-domain registration (or, when
 * clearing it, a removal) under the shared release policy, so the same
 * fail-closed guard the agency-branding write uses runs before any request.
 */
export async function saveArchiveDomain(options: {
  previous: string;
  next: string;
  signal?: AbortSignal;
}): Promise<ArchiveSettings> {
  const next = normalizeArchiveDomainInput(options.next);
  requireCustomDomainValueUnchanged(options.previous, next);
  const res = await api.put<Partial<ArchiveSettings>>(
    "/api/v1/admin/archive/tenant-settings",
    { archive_domain: next },
    { requireOnline: true, maxAttempts: 1, signal: options.signal },
  );
  return parseArchiveSettings(res);
}

/**
 * Deletes the verification row so the vanity host stops routing to this
 * archive. The configured `archive_domain` column is deliberately NOT cleared
 * (the server answers 204 and leaves it); clearing the host is a separate
 * save. Idempotent server-side.
 */
export async function removeArchiveDomainVerification(options: {
  signal?: AbortSignal;
} = {}): Promise<void> {
  requireCustomDomainOperation("removal");
  await api.delete<unknown>("/api/v1/admin/archive/domain", {
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
  });
}

/** True when a status value describes nothing because no domain was requested. */
export function domainNotRequested(d: ArchiveDomain): boolean {
  return d.domain.trim() === "";
}

function parseArchiveDomain(r: Partial<ArchiveDomain>): ArchiveDomain {
  return {
    domain: str(r?.domain),
    cname_target: str(r?.cname_target),
    verification_token: str(r?.verification_token),
    status: str(r?.status),
    last_checked_at: str(r?.last_checked_at),
    verified_at: str(r?.verified_at),
    last_error: str(r?.last_error),
    ssl_status: str(r?.ssl_status),
    ssl_last_error: str(r?.ssl_last_error),
  };
}

// ---------------------------------------------------------------------------
// Authenticated archive operations
// ---------------------------------------------------------------------------

const ARCHIVE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/u;
const UNSAFE_CONTENT_CHARACTER_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_SEARCH_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 2_000;
const MAX_EXCERPT_LENGTH = 280;
const MAX_HTML_LENGTH = 1_500_000;
const MAX_URL_LENGTH = 2_048;

export class ArchiveContractError extends Error {
  readonly code = "archive_contract_error";

  constructor(message: string) {
    super(message);
    this.name = "ArchiveContractError";
  }
}

export class ArchiveInputError extends Error {
  readonly code = "archive_input_error";

  constructor(message: string) {
    super(message);
    this.name = "ArchiveInputError";
  }
}

export interface ArchiveIssueSummary {
  slug: string;
  subject: string;
  excerpt: string;
  publishedAt: string;
  pinned: boolean;
  viewCount: number;
  uniqueVisitors: number;
  /** Internal operation handle. Never render this value into the DOM or URL. */
  campaignId: string;
}

export interface ArchiveIssuePage {
  items: ArchiveIssueSummary[];
  nextCursor: string | null;
}

export interface ArchiveStats {
  totalIssues: number;
  pinnedIssues: number;
  views30d: number;
  uniqueVisitors30d: number;
  topIssueSlug: string | null;
  topIssueSubject: string | null;
  topIssueViews: number | null;
  lastPublishedAt: string | null;
}

export interface ArchiveIssuePreview {
  slug: string;
  subject: string;
  excerpt: string;
  htmlBody: string;
  publishedAt: string;
  pinned: boolean;
  /** Internal operation handle. Never render this value into the DOM or URL. */
  campaignId: string;
}

export interface ArchiveUnpublishReceipt {
  ok: true;
}

function contractRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArchiveContractError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function contractString(
  record: Record<string, unknown>,
  key: string,
  options: { min?: number; max: number; pattern?: RegExp },
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length < (options.min ?? 0) ||
    value.length > options.max ||
    CONTROL_CHARACTER_RE.test(value) ||
    (options.pattern && !options.pattern.test(value))
  ) {
    throw new ArchiveContractError(`Archive field ${key} is malformed.`);
  }
  return value;
}

function optionalContractString(
  record: Record<string, unknown>,
  key: string,
  max: number,
): string | null {
  const value = record[key];
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > max ||
    CONTROL_CHARACTER_RE.test(value)
  ) {
    throw new ArchiveContractError(`Archive field ${key} is malformed.`);
  }
  return value;
}

function contractDate(
  record: Record<string, unknown>,
  key: string,
  optional = false,
): string | null {
  const value = record[key];
  if (optional && (value === undefined || value === null || value === "")) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ArchiveContractError(`Archive field ${key} is not a valid date.`);
  }
  return value;
}

function contractCount(
  record: Record<string, unknown>,
  key: string,
  optionalZero = false,
): number {
  const value = record[key];
  // The Go projection currently uses `omitempty` for per-row zero counts.
  if (optionalZero && (value === undefined || value === null)) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ArchiveContractError(
      `Archive field ${key} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function contractBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean {
  if (typeof record[key] !== "boolean") {
    throw new ArchiveContractError(`Archive field ${key} must be a boolean.`);
  }
  return record[key];
}

function contractHTMLBody(record: Record<string, unknown>): string {
  const value = record.htmlBody;
  if (
    typeof value !== "string" ||
    value.length > MAX_HTML_LENGTH ||
    UNSAFE_CONTENT_CHARACTER_RE.test(value)
  ) {
    throw new ArchiveContractError("Archive field htmlBody is malformed.");
  }
  return value;
}

function parseIssueSummary(value: unknown, index: number): ArchiveIssueSummary {
  const record = contractRecord(value, `Archive issue ${index + 1}`);
  return {
    slug: contractString(record, "slug", {
      min: 1,
      max: 64,
      pattern: ARCHIVE_SLUG_RE,
    }),
    subject: contractString(record, "subject", { max: MAX_SUBJECT_LENGTH }),
    excerpt: contractString(record, "excerpt", { max: MAX_EXCERPT_LENGTH }),
    publishedAt: contractDate(record, "publishedAt")!,
    pinned: contractBoolean(record, "pinned"),
    viewCount: contractCount(record, "viewCount", true),
    uniqueVisitors: contractCount(record, "uniqueVisitors", true),
    campaignId: contractString(record, "campaignId", {
      min: 36,
      max: 36,
      pattern: CANONICAL_UUID_RE,
    }),
  };
}

export function parseArchiveIssuePage(
  value: unknown,
  expectedLimit = 25,
): ArchiveIssuePage {
  const record = contractRecord(value, "Archive issue page");
  if (!Array.isArray(record.items) || record.items.length > expectedLimit) {
    throw new ArchiveContractError(
      "Archive issue page items must be a bounded array.",
    );
  }
  const items = record.items.map(parseIssueSummary);
  const slugs = new Set<string>();
  const campaignIds = new Set<string>();
  for (const item of items) {
    if (slugs.has(item.slug) || campaignIds.has(item.campaignId)) {
      throw new ArchiveContractError(
        "Archive issue page contains duplicate identities.",
      );
    }
    slugs.add(item.slug);
    campaignIds.add(item.campaignId);
  }
  const cursor = record.nextCursor;
  if (
    cursor !== undefined &&
    cursor !== null &&
    (typeof cursor !== "string" ||
      cursor.length === 0 ||
      cursor.length > MAX_CURSOR_LENGTH ||
      CONTROL_CHARACTER_RE.test(cursor))
  ) {
    throw new ArchiveContractError("Archive pagination cursor is malformed.");
  }
  if (items.length === 0 && typeof cursor === "string") {
    throw new ArchiveContractError(
      "Archive issue page cannot advance without any items.",
    );
  }
  return {
    items,
    nextCursor: typeof cursor === "string" ? cursor : null,
  };
}

function validatedSearch(value: string | undefined): string | undefined {
  const query = value?.trim();
  if (!query) return undefined;
  if (query.length > MAX_SEARCH_LENGTH || CONTROL_CHARACTER_RE.test(query)) {
    throw new ArchiveInputError(
      `Archive search must be ${MAX_SEARCH_LENGTH} characters or fewer and contain no control characters.`,
    );
  }
  return query;
}

function validatedCursor(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > MAX_CURSOR_LENGTH || CONTROL_CHARACTER_RE.test(value)) {
    throw new ArchiveInputError("Archive pagination cursor is malformed.");
  }
  return value;
}

export async function listArchiveIssues(
  options: {
    cursor?: string;
    limit?: number;
    q?: string;
    signal?: AbortSignal;
  } = {},
): Promise<ArchiveIssuePage> {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ArchiveInputError("Archive page size must be between 1 and 100.");
  }
  const response = await api.get<unknown>("/api/v1/archive", {
    query: {
      cursor: validatedCursor(options.cursor),
      limit,
      q: validatedSearch(options.q),
    },
    signal: options.signal,
  });
  return parseArchiveIssuePage(response, limit);
}

export function parseArchiveStats(value: unknown): ArchiveStats {
  const record = contractRecord(value, "Archive stats");
  const topIssueSlug = optionalContractString(record, "topIssueSlug", 64);
  if (topIssueSlug && !ARCHIVE_SLUG_RE.test(topIssueSlug)) {
    throw new ArchiveContractError("Archive field topIssueSlug is malformed.");
  }
  const topIssueSubject = optionalContractString(
    record,
    "topIssueSubject",
    MAX_SUBJECT_LENGTH,
  );
  const topViewsRaw = record.topIssueViews;
  const topIssueViews =
    topViewsRaw === undefined || topViewsRaw === null
      ? null
      : contractCount(record, "topIssueViews");
  const hasAnyTopIssue = Boolean(
    topIssueSlug || topIssueSubject || topIssueViews !== null,
  );
  if (hasAnyTopIssue && (!topIssueSlug || topIssueViews === null)) {
    throw new ArchiveContractError(
      "Archive top-issue statistics are incomplete.",
    );
  }
  const totalIssues = contractCount(record, "totalIssues");
  const pinnedIssues = contractCount(record, "pinnedIssues");
  const views30d = contractCount(record, "views30d");
  const uniqueVisitors30d = contractCount(record, "uniqueVisitors30d");
  if (pinnedIssues > totalIssues || uniqueVisitors30d > views30d) {
    throw new ArchiveContractError("Archive statistics are inconsistent.");
  }
  return {
    totalIssues,
    pinnedIssues,
    views30d,
    uniqueVisitors30d,
    topIssueSlug,
    topIssueSubject,
    topIssueViews,
    lastPublishedAt: contractDate(record, "lastPublishedAt", true),
  };
}

export async function getArchiveStats(
  signal?: AbortSignal,
): Promise<ArchiveStats> {
  const response = await api.get<unknown>("/api/v1/archive/stats", { signal });
  return parseArchiveStats(response);
}

function optionalURL(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = optionalContractString(record, key, MAX_URL_LENGTH);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported scheme");
    }
  } catch {
    throw new ArchiveContractError(`Archive field ${key} is not an HTTP URL.`);
  }
  return value;
}

export function parseArchiveIssuePreview(
  value: unknown,
  expectedSlug: string,
): ArchiveIssuePreview {
  if (!ARCHIVE_SLUG_RE.test(expectedSlug) || expectedSlug.length > 64) {
    throw new ArchiveInputError("Archive issue slug is malformed.");
  }
  const record = contractRecord(value, "Archive issue preview");
  const slug = contractString(record, "slug", {
    min: 1,
    max: 64,
    pattern: ARCHIVE_SLUG_RE,
  });
  if (slug !== expectedSlug) {
    throw new ArchiveContractError(
      "Archive preview identity did not match the requested issue.",
    );
  }
  // Validate the rest of the authenticated wire projection, but do not retain
  // author identity or destination/image URLs in the query cache because this
  // inspection surface does not display them.
  optionalContractString(record, "metaDescription", 160);
  optionalURL(record, "ogImage");
  optionalURL(record, "heroImage");
  optionalContractString(record, "authorName", 100);
  optionalURL(record, "canonicalUrl");
  return {
    slug,
    subject: contractString(record, "subject", { max: MAX_SUBJECT_LENGTH }),
    excerpt:
      optionalContractString(record, "excerpt", MAX_EXCERPT_LENGTH) ?? "",
    htmlBody: contractHTMLBody(record),
    publishedAt: contractDate(record, "publishedAt")!,
    pinned: contractBoolean(record, "pinned"),
    campaignId: contractString(record, "campaignId", {
      min: 36,
      max: 36,
      pattern: CANONICAL_UUID_RE,
    }),
  };
}

export async function getArchiveIssuePreview(
  slug: string,
  signal?: AbortSignal,
): Promise<ArchiveIssuePreview> {
  if (
    slug.length > 64 ||
    !ARCHIVE_SLUG_RE.test(slug) ||
    CONTROL_CHARACTER_RE.test(slug)
  ) {
    throw new ArchiveInputError("Archive issue slug is malformed.");
  }
  const response = await api.get<unknown>(
    `/api/v1/admin/archive/issues/${encodeURIComponent(slug)}/preview`,
    { requireOnline: true, maxAttempts: 1, signal },
  );
  return parseArchiveIssuePreview(response, slug);
}

export function parseArchiveUnpublishReceipt(
  value: unknown,
): ArchiveUnpublishReceipt {
  const record = contractRecord(value, "Archive unpublish receipt");
  if (record.ok !== true) {
    throw new ArchiveContractError(
      "Archive unpublish response did not confirm success.",
    );
  }
  return { ok: true };
}

export interface ArchivePinReceipt {
  ok: true;
  pinned: boolean;
}

/**
 * The pin receipt carries the resulting state, not just success.
 *
 * `setPinned` is idempotent server-side, so a receipt whose `pinned` disagrees
 * with what was asked means the row we are about to re-render is not the row
 * the server changed. Treating that as success would leave the list showing a
 * featured badge the public archive does not have.
 */
export function parseArchivePinReceipt(
  value: unknown,
  requested: boolean,
): ArchivePinReceipt {
  const record = contractRecord(value, "Archive pin receipt");
  if (record.ok !== true) {
    throw new ArchiveContractError(
      "Archive pin response did not confirm success.",
    );
  }
  if (contractBoolean(record, "pinned") !== requested) {
    throw new ArchiveContractError(
      "Archive pin response reported a different state than requested.",
    );
  }
  return { ok: true, pinned: requested };
}

/**
 * Feature (pin) or unfeature an already-published issue.
 *
 * This reorders the public index — pinned issues sort first — and publishes
 * nothing: an issue must already be archive-public for the server to find it
 * (`ErrNotFound` → "issue not published or not yours"). The two verbs are
 * separate mounted routes rather than one route with a flag, so each path is
 * written as its own literal.
 */
export async function setArchiveIssuePinned(options: {
  campaignId: string;
  pinned: boolean;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<ArchivePinReceipt> {
  if (!CANONICAL_UUID_RE.test(options.campaignId)) {
    throw new ArchiveInputError("Archive campaign identity is malformed.");
  }
  if (!CANONICAL_UUID_RE.test(options.idempotencyKey)) {
    throw new ArchiveInputError("Archive operation key is malformed.");
  }
  const id = encodeURIComponent(options.campaignId);
  const request = {
    requireOnline: true,
    maxAttempts: 1,
    idempotencyKey: options.idempotencyKey,
    signal: options.signal,
  } as const;
  const response = options.pinned
    ? await api.post<unknown>(
        `/api/v1/campaigns/${id}/archive/pin`,
        undefined,
        request,
      )
    : await api.post<unknown>(
        `/api/v1/campaigns/${id}/archive/unpin`,
        undefined,
        request,
      );
  return parseArchivePinReceipt(response, options.pinned);
}

export async function unpublishArchiveIssue(options: {
  campaignId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<ArchiveUnpublishReceipt> {
  if (!CANONICAL_UUID_RE.test(options.campaignId)) {
    throw new ArchiveInputError("Archive campaign identity is malformed.");
  }
  if (!CANONICAL_UUID_RE.test(options.idempotencyKey)) {
    throw new ArchiveInputError("Archive operation key is malformed.");
  }
  const response = await api.post<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(options.campaignId)}/unpublish-archive`,
    undefined,
    {
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    },
  );
  return parseArchiveUnpublishReceipt(response);
}
