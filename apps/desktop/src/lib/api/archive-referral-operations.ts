import type { ApiResult } from "./result";

export interface ArchiveReferralRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type ArchiveReferralRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: ArchiveReferralRequestOptions,
) => Promise<ApiResult<T>>;

export interface ArchiveReferralOperationsDependencies {
  request: ArchiveReferralRequester;
}

/**
 * One row in the archive admin list. Mirrors `archive.IssueSummary`.
 * The underlying entity IS a campaign — `slug` is the canonical
 * identifier for archive operations. The admin endpoint also returns
 * `campaignId` (the campaign uuid) so callers that need to mutate can
 * drive publish / unpublish / pin off the row directly, with no
 * `listCampaigns()` join.
 *
 * Legacy `campaign_id` / `id` fields are tolerated for backwards
 * compatibility with older mock fixtures.
 */
export interface ArchiveIssue {
  slug: string;
  subject: string;
  excerpt: string;
  publishedAt: string;
  /** Featured at the top of the public archive index. */
  pinned?: boolean;
  /** 30-day view count, bot-excluded. Admin endpoint only. */
  viewCount?: number;
  /** 30-day unique-visitor count, bot-excluded. Admin endpoint only. */
  uniqueVisitors?: number;
  /**
   * Campaign uuid. Populated on the admin list response (returned by
   * `archive.IssueSummary.CampaignID`); omitted on the public read
   * path. The canonical id callers should use for publish/unpublish/pin.
   */
  campaignId?: string;
  /** Legacy snake-case alias from older fixtures; prefer `campaignId`. */
  campaign_id?: string;
  /** Legacy bare `id` from older fixtures; prefer `campaignId`. */
  id?: string;
  // Tolerate any extra fields server may attach.
  [extra: string]: unknown;
}

/**
 * One row in the admin's "Read next" preview / override list. Mirrors
 * `archive.RelatedIssue`. The `source` flag tells the slideover which
 * signal placed the row: admin-curated override, tag-overlap match,
 * or recency fallback.
 */
export interface ArchiveRelatedIssue {
  slug: string;
  subject: string;
  excerpt?: string;
  publishedAt: string;
  heroImage?: string;
  /** Relevancy score in [0, +inf); higher is more relevant. Debug-only. */
  score?: number;
  /** Which signal selected this row. */
  source?: "override" | "tags" | "recency";
}

/**
 * Wire shape for `GET /api/v1/campaigns/{id}/archive/related` and the
 * matching `/overrides` endpoint. `algorithm` is a diagnostic flag the
 * admin slideover surfaces as "Auto-scored by tags" vs "Curated".
 *
 * Mirrors `archive.RelatedList`.
 */
export interface ArchiveRelatedList {
  items: ArchiveRelatedIssue[];
  algorithm?: string;
}

/**
 * Dashboard-tile rollup. Mirrors `archive.Stats`.
 * Returned by `GET /api/v1/archive/stats`.
 */
export interface ArchiveStats {
  totalIssues: number;
  pinnedIssues: number;
  views30d: number;
  uniqueVisitors30d: number;
  topIssueSlug?: string;
  topIssueSubject?: string;
  topIssueViews?: number;
  lastPublishedAt?: string;
}

/**
 * SEO knobs accepted by `publishCampaignArchive`. Nil = leave the
 * existing column untouched; an explicit empty string clears it.
 * Matches `archive.PublishInput`.
 */
export interface ArchivePublishInput {
  slug?: string;
  excerpt?: string;
  metaDescription?: string | null;
  ogImage?: string | null;
  heroImage?: string | null;
  authorName?: string | null;
  /**
   * Absolute http(s) URL of the primary copy of this issue hosted
   * elsewhere (HN cross-post, Medium re-publish, syndicated partner
   * blog, RSS-to-email source). When set, the public archive page
   * renders `<link rel="canonical" href="...">` and the RSS feed adds
   * a per-item `<atom:link rel="canonical">` so search engines
   * de-duplicate the email-archive copy against the original. `null`
   * clears the column; `undefined` leaves it untouched. See gap
   * feature `archive-canonical-url`.
   */
  canonicalUrl?: string | null;
}

/**
 * One paid tier the tenant offers. Mirrors `paywall.Tier` in the Go
 * backend. The Archive publish slideover renders a picker driven by
 * the `active=true` subset of this list. See gap feature
 * `archive-paywall-integration`.
 */
export interface PaywallTier {
  id: string;
  name: string;
  description?: string;
  stripePriceId?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Envelope for `GET /api/v1/paywall/tiers`. Mirrors the Go handler's
 * `{tiers: Tier[]}` shape.
 */
export interface PaywallTiersResponse {
  tiers?: PaywallTier[];
}

/**
 * Envelope for `GET /api/v1/archive`. The Go handler returns
 * `{items, nextCursor}`; older mocks may use a bare array or `data`.
 */
export interface ArchiveListResponse {
  items?: ArchiveIssue[];
  data?: ArchiveIssue[];
  results?: ArchiveIssue[];
  nextCursor?: string;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`Archive field ${key} must be a string.`);
  }
  return value;
}

function readOptionalCount(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new TypeError(`Archive field ${key} must be a non-negative integer.`);
  }
  return value;
}

export function parseArchiveListResponse(value: unknown): {
  items: ArchiveIssue[];
  nextCursor?: string;
} {
  const envelope =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const rawItems = Array.isArray(value)
    ? value
    : envelope
      ? (envelope.items ?? envelope.results ?? envelope.data ?? [])
      : null;
  if (!Array.isArray(rawItems)) {
    throw new TypeError("Archive response items must be an array.");
  }

  const items = rawItems.map((raw, index): ArchiveIssue => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`Archive issue ${index + 1} must be an object.`);
    }
    const record = raw as Record<string, unknown>;
    const slug = record.slug;
    const subject = record.subject;
    const excerpt = record.excerpt;
    const publishedAt = record.publishedAt;
    if (
      typeof slug !== "string" ||
      typeof subject !== "string" ||
      typeof excerpt !== "string" ||
      typeof publishedAt !== "string" ||
      Number.isNaN(Date.parse(publishedAt))
    ) {
      throw new TypeError(
        `Archive issue ${index + 1} has an invalid core projection.`,
      );
    }
    if (record.pinned !== undefined && typeof record.pinned !== "boolean") {
      throw new TypeError(
        `Archive issue ${index + 1} field pinned must be a boolean.`,
      );
    }
    return {
      slug,
      subject,
      excerpt,
      publishedAt,
      pinned: record.pinned,
      viewCount: readOptionalCount(record, "viewCount"),
      uniqueVisitors: readOptionalCount(record, "uniqueVisitors"),
      campaignId: readOptionalString(record, "campaignId"),
      campaign_id: readOptionalString(record, "campaign_id"),
      id: readOptionalString(record, "id"),
    };
  });

  const nextCursor = envelope?.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    typeof nextCursor !== "string"
  ) {
    throw new TypeError("Archive nextCursor must be a string.");
  }
  return {
    items,
    ...(typeof nextCursor === "string" && nextCursor ? { nextCursor } : {}),
  };
}

/**
 * Wire shape returned by
 *   GET /api/v1/admin/archive/issues/{slug}/preview
 *
 * Carries the rendered HTML body for an issue so the desktop's
 * archive slideover can paint a sandboxed iframe preview alongside
 * the edit form — parity with Substack / Beehiiv / Ghost / Buttondown
 * in-editor previews.
 *
 * Mirrors `archive.PreviewResponse` in the Go backend.
 */
export interface ArchiveIssuePreview {
  slug: string;
  subject: string;
  /** Rendered HTML body — operator-authored, untrusted. The desktop
   *  renders this inside a `sandbox=""` iframe via `TemplatePreview`,
   *  which strips on*-handlers and javascript: URLs before injection. */
  htmlBody: string;
  publishedAt: string;
  pinned?: boolean;
  excerpt?: string;
  metaDescription?: string;
  ogImage?: string;
  heroImage?: string;
  authorName?: string;
  canonicalUrl?: string;
  /** Campaign uuid — handy for analytics drilldowns. Omitted when the
   *  caller already has it from the row that triggered the preview. */
  campaignId?: string;
}

/**
 * Per-tenant public-archive config row. Mirrors
 * `archive.TenantSettings` in the Go backend.
 *
 * All four fields are always present on the response — missing columns
 * are returned as `""` so the settings form can bind to plain inputs
 * without a null-guard.
 *
 * `tenant_archive_slug` controls the public archive URL, e.g.
 *   https://archive.moosewave.com/{tenant_archive_slug}
 * `archive_domain` is the optional vanity host (CNAME'd to Moosewave).
 * `archive_title` + `archive_tagline` render on the public landing page.
 */
export interface ArchiveTenantSettings {
  tenant_archive_slug: string;
  archive_domain: string;
  archive_title: string;
  archive_tagline: string;
}

/**
 * PATCH-style PUT body for `putArchiveTenantSettings`. Omit a field to
 * leave its column untouched; send an explicit empty string to clear
 * it. Mirrors `archive.TenantSettingsInput` (pointer fields = optional
 * on the wire).
 */
export interface ArchiveTenantSettingsInput {
  tenant_archive_slug?: string;
  archive_domain?: string;
  archive_title?: string;
  archive_tagline?: string;
}

/**
 * Custom-domain verification envelope. Mirrors `archive.CustomDomainStatus`
 * in the Go backend (apps/api/internal/archive/custom_domain.go).
 *
 * The lifecycle the desktop renders:
 *   1. Operator types a domain into the `archive_domain` settings field
 *      and saves via `putArchiveTenantSettings` → status is "pending"
 *      (or absent if the verification row hasn't been materialised yet).
 *   2. Operator copies `cname_target` and creates the CNAME at their
 *      DNS provider; clicks "Verify" → backend runs DNS check,
 *      transitions status to "verified" or "failed" + sets last_error.
 *   3. Edge starts issuing the Let's Encrypt cert; `ssl_status` walks
 *      pending → issuing → issued (typically <90s).
 *
 * Gap feature: `archive-archive-domain-ui`.
 */
export interface ArchiveCustomDomainStatus {
  /** Operator-configured archive_domain ("" when none). Read-only on
   *  this envelope — change via `putArchiveTenantSettings`. */
  domain: string;
  /** Hostname operators add as a CNAME value (e.g.
   *  "custom-domains.moosewave.com"). */
  cname_target: string;
  /** Optional TXT-record verification token for DNS providers that
   *  reject CNAMEs on the apex. Add a TXT record at
   *  `_postwave-verify.{domain}` with value `postwave-verify={token}`. */
  verification_token: string;
  /** One of pending / verified / failed. */
  status: "pending" | "verified" | "failed";
  /** RFC3339 UTC; empty when never checked. */
  last_checked_at?: string;
  /** RFC3339 UTC; set on the first transition into 'verified' and
   *  preserved across re-checks. */
  verified_at?: string;
  /** Human-readable failure reason from the most-recent check; empty
   *  on success. */
  last_error?: string;
  /** Managed-cert state. The edge issues certs on-demand once status
   *  is "verified" — typical pending → issuing → issued in <90s. */
  ssl_status: "pending" | "issuing" | "issued" | "failed";
  /** Most-recent issuance failure reason from the edge. */
  ssl_last_error?: string;
}

/**
 * One milestone tier. Mirrors the Go `referrals.Milestone`. Field names
 * are `count` (NOT `referrals_required`) and `reward_label`; optional
 * structural reward metadata is stored in the backend's `milestones_v2`.
 */
/** Refined Referrals PR 1 enum. Anything outside this set falls
 *  back to "custom" on the server side. */
export type ReferralRewardKind = "swag" | "free" | "annual" | "custom";

export interface ReferralMilestone {
  count: number;
  reward_label: string;
  /** PR 1: structural enum. May be absent on legacy programs that
   *  encoded the kind as a "[kind] label" prefix; in that case the
   *  desktop UI parses the prefix as a one-off fallback. */
  reward_kind?: ReferralRewardKind;
  /** Optional per-milestone cash-equivalent value in minor currency units. */
  reward_value_cents?: number;
  /** ISO 4217 currency code for `reward_value_cents`. */
  reward_currency?: string;
  /** Optional fulfilment/product identifier for this milestone reward. */
  reward_sku?: string;
  /** PR 2: optional Library asset id for reward art. Stored inside
   *  the milestones_v2 jsonb on the server — no schema change. */
  reward_image_asset_id?: string;
}

/** PR 4: payout fulfilment status. */
export type ReferralPayoutStatus = "pending" | "sent" | "delivered" | "skipped";

export interface ReferralPayoutRow {
  id: string;
  referrer_id: string;
  referee_id: string;
  created_at: string;
  payout_status: ReferralPayoutStatus;
  payout_note: string;
  fraud_score: number;
}

/** Lifecycle of a milestone payout (GET/PATCH /api/v1/referrals/payouts).
 *  Distinct from the legacy {@link ReferralPayoutStatus} fulfilment enum. */
export type ReferralMilestonePayoutStatus = "pending" | "approved" | "paid";

/** One milestone-reward payout row — mirrors referrals/payouts.go. */
export interface ReferralMilestonePayout {
  id: string;
  referrer_id: string;
  /** Milestone threshold (referral count) that unlocked the reward. */
  milestone: number;
  reward_label: string;
  status: ReferralMilestonePayoutStatus;
  created_at: string;
  updated_at: string;
}

export interface ReferralMilestonePayoutListResponse {
  items: ReferralMilestonePayout[];
  total: number;
}

/** Refined Referrals PR 1 — admin analytics bundle. */
export interface ReferralStatsResponse {
  funnel: {
    conversions_7d: number;
    conversions_30d: number;
    conversions_90d: number;
    clicks_total: number;
    fraud_filtered_count: number;
  };
  top_referrers: {
    subscriber_id: string;
    count: number;
    last_at: string;
  }[];
  recent: {
    referrer_id: string;
    referee_id: string;
    created_at: string;
  }[];
}

/** Mirrors the Go `referrals.Program`. */
export interface ReferralProgram {
  id: string;
  tenantId?: string;
  milestones: ReferralMilestone[];
  active: boolean;
  /** PR 4: optional end date for time-bound programs. */
  expiresAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /**
   * Referee-reward + verification settings (D11#3). The backend POST is a
   * FULL replace, so these MUST be round-tripped through the editor —
   * `setReferralProgram` previously sent only milestones+expires_at, which
   * silently wiped every field below on any milestone save/delete. JSON
   * keys are snake_case to match the Go response.
   */
  referee_reward_kind?: string;
  referee_reward_label?: string;
  referee_reward_image_asset_id?: string;
  reward_value_cents?: number;
  reward_currency?: string;
  reward_sku?: string;
  verification_window_days?: number;
}

/** Mirrors the Go `referrals.SubscriberView`. */
export interface ReferralSubscriberView {
  share_url: string;
  ref_code: string;
  referrals_count: number;
  milestones_unlocked: ReferralMilestone[];
}

/** GET /api/v1/archive — tenant-scoped list of published issues. */
export function createListArchive({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function listArchive(
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<ApiResult<ArchiveListResponse>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<ArchiveListResponse>(`/api/v1/archive${qs ? `?${qs}` : ""}`);
  };
}

/**
 * POST /api/v1/campaigns/{id}/publish-archive — flips archive_public=true
 * on the campaign and stamps slug / excerpt / optional SEO knobs.
 *
 * Backwards compatible: callers passing only `{slug, excerpt}` still
 * work. SEO fields are PATCH-style — `null` clears, `undefined`
 * leaves untouched.
 */
export function createPublishCampaignArchive({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function publishCampaignArchive(
    campaignId: string | number,
    input: ArchivePublishInput = {},
  ): Promise<ApiResult<{ ok: boolean }>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
      slug: input.slug ?? "",
      excerpt: input.excerpt ?? "",
    };
    if (input.metaDescription !== undefined) {
      body.metaDescription = input.metaDescription ?? "";
    }
    if (input.ogImage !== undefined) body.ogImage = input.ogImage ?? "";
    if (input.heroImage !== undefined) body.heroImage = input.heroImage ?? "";
    if (input.authorName !== undefined)
      body.authorName = input.authorName ?? "";
    // canonicalUrl: nil leaves alone; null/empty string clears the
    // column (server-side trims + NULLIFs). See gap feature
    // `archive-canonical-url`.
    if (input.canonicalUrl !== undefined) {
      body.canonicalUrl = input.canonicalUrl ?? "";
    }
    return request<{ ok: boolean }>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/publish-archive`,
      { method: "POST", body: JSON.stringify(body) },
    );
  };
}

/**
 * GET /api/v1/paywall/tiers — list the tenant's named paid tiers.
 * Returns active + inactive; callers filter to `active=true` for
 * picker UIs. See gap feature `archive-paywall-integration`.
 */
export function createListPaywallTiers({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function listPaywallTiers(): Promise<ApiResult<PaywallTiersResponse>> {
    return request<PaywallTiersResponse>("/api/v1/paywall/tiers");
  };
}

/**
 * POST /api/v1/paywall/tiers — create or update a named tier. Pass
 * `id` to update; omit to insert. Empty `name` is rejected
 * server-side with `{code:"name_required"}`.
 */
export function createUpsertPaywallTier({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function upsertPaywallTier(input: {
    id?: string;
    name: string;
    description?: string;
    stripePriceId?: string;
    active?: boolean;
  }): Promise<ApiResult<{ ok: boolean; id: string }>> {
    return request<{ ok: boolean; id: string }>("/api/v1/paywall/tiers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/**
 * DELETE /api/v1/paywall/tiers/{id} — soft-delete (flip
 * `active=false`). Hard delete is avoided because campaigns
 * reference tier ids.
 */
export function createDeactivatePaywallTier({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function deactivatePaywallTier(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/paywall/tiers/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/** POST /api/v1/campaigns/{id}/unpublish-archive — remove from archive. */
export function createUnpublishCampaignArchive({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function unpublishCampaignArchive(
    campaignId: string | number,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/unpublish-archive`,
      { method: "POST", body: JSON.stringify({}) },
    );
  };
}

/** GET /api/v1/archive/stats — headline tiles for the Archive page. */
export function createGetArchiveStats({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function getArchiveStats(): Promise<ApiResult<ArchiveStats>> {
    return request<ArchiveStats>("/api/v1/archive/stats");
  };
}

/** POST /api/v1/campaigns/{id}/archive/pin — float to top of archive index. */
export function createPinArchive({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function pinArchive(
    campaignId: string | number,
  ): Promise<ApiResult<{ ok: boolean; pinned: boolean }>> {
    return request<{ ok: boolean; pinned: boolean }>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/archive/pin`,
      { method: "POST", body: JSON.stringify({}) },
    );
  };
}

/** POST /api/v1/campaigns/{id}/archive/unpin */
export function createUnpinArchive({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function unpinArchive(
    campaignId: string | number,
  ): Promise<ApiResult<{ ok: boolean; pinned: boolean }>> {
    return request<{ ok: boolean; pinned: boolean }>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/archive/unpin`,
      { method: "POST", body: JSON.stringify({}) },
    );
  };
}

/**
 * GET /api/v1/campaigns/{id}/archive/related — preview the
 * "Read next" carousel for a published archive issue.
 *
 * The backend scorer ranks candidate sibling issues by tag overlap,
 * recency, and 30d view popularity (with admin-curated overrides
 * winning when present). Mirrors `archive.RelatedList`.
 *
 * Gap feature: `archive-related-issues`.
 */
export function createGetArchiveRelatedPreview({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function getArchiveRelatedPreview(
    campaignId: string | number,
    opts: { limit?: number } = {},
  ): Promise<ApiResult<ArchiveRelatedList>> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<ArchiveRelatedList>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/archive/related${qs ? `?${qs}` : ""}`,
    );
  };
}

/**
 * GET /api/v1/campaigns/{id}/archive/related/overrides — read the
 * admin-curated override list for this issue's "Read next" carousel.
 * Returns an empty `items` list (algorithm="override") when the
 * operator hasn't curated anything — the public surface falls back
 * to the auto scorer.
 */
export function createGetArchiveRelatedOverrides({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function getArchiveRelatedOverrides(
    campaignId: string | number,
  ): Promise<ApiResult<ArchiveRelatedList>> {
    return request<ArchiveRelatedList>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/archive/related/overrides`,
    );
  };
}

/**
 * PUT /api/v1/campaigns/{id}/archive/related/overrides — replace
 * the admin override list. Order is preserved (rank = array index).
 *
 * Pass an empty array to clear overrides and fall back to the
 * auto-scoring path on the public surface.
 */
export function createSetArchiveRelatedOverrides({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function setArchiveRelatedOverrides(
    campaignId: string | number,
    relatedCampaignIds: string[],
  ): Promise<ApiResult<{ ok: boolean; count: number }>> {
    return request<{ ok: boolean; count: number }>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/archive/related/overrides`,
      {
        method: "PUT",
        body: JSON.stringify({ relatedCampaignIds }),
      },
    );
  };
}

/**
 * GET /api/v1/admin/archive/issues/{slug}/preview — fetch the
 * rendered HTML body for a published archive issue so the admin
 * slideover can render an in-app sandboxed iframe preview (parity
 * with Substack / Beehiiv / Ghost / Buttondown in-editor previews).
 *
 * Tenant-scoped — slug is resolved against the caller's tenant.
 * Returns 404 if the issue isn't `archive_public=true` for this
 * tenant. The handler is gated by `read:reports` OR `admin` scope
 * so viewer-role accounts can preview alongside editor + admin.
 *
 * Backend: `apps/api/internal/archive/archive.go` AdminPreview.
 * Gap feature: `archive-html-preview-admin`.
 */
export function createGetArchiveIssuePreview({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function getArchiveIssuePreview(
    slug: string,
  ): Promise<ApiResult<ArchiveIssuePreview>> {
    return request<ArchiveIssuePreview>(
      `/api/v1/admin/archive/issues/${encodeURIComponent(slug)}/preview`,
    );
  };
}

/**
 * GET /api/v1/admin/archive/tenant-settings — read the per-tenant
 * public-archive config row (slug, custom domain, title, tagline).
 * Returns a zero-valued envelope for newly-provisioned tenants so the
 * settings form can render without a 404 special-case.
 */
export function createGetArchiveTenantSettings({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function getArchiveTenantSettings(): Promise<
    ApiResult<ArchiveTenantSettings>
  > {
    return request<ArchiveTenantSettings>(
      "/api/v1/admin/archive/tenant-settings",
    );
  };
}

/**
 * PUT /api/v1/admin/archive/tenant-settings — upsert the per-tenant
 * archive config. PATCH-style: only fields whose key is present in
 * the body are mutated, so the UI can save one field at a time
 * without clobbering the others.
 *
 * Errors surface as structured codes the desktop maps to friendly
 * toasts:
 *   - 400 invalid_slug   — kebab-case violation or >64 chars
 *   - 409 slug_taken     — another publication owns that slug
 */
export function createPutArchiveTenantSettings({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function putArchiveTenantSettings(
    input: ArchiveTenantSettingsInput,
  ): Promise<ApiResult<ArchiveTenantSettings>> {
    return request<ArchiveTenantSettings>(
      "/api/v1/admin/archive/tenant-settings",
      { method: "PUT", body: JSON.stringify(input) },
    );
  };
}

/**
 * GET /api/v1/admin/archive/domain — fetch custom-domain verification
 * status (CNAME target, status, last-checked, SSL state). Returns an
 * empty-domain envelope when the tenant hasn't configured a vanity
 * host yet — the UI binds the empty form against that.
 *
 * Gap feature: `archive-archive-domain-ui`. The backend has been wired
 * since gap feature `archive-custom-domain-honor`; this is the admin
 * read surface for the verification panel.
 */
export function createGetArchiveCustomDomain({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function getArchiveCustomDomain(): Promise<
    ApiResult<ArchiveCustomDomainStatus>
  > {
    return request<ArchiveCustomDomainStatus>("/api/v1/admin/archive/domain");
  };
}

/**
 * POST /api/v1/admin/archive/domain/verify — re-run the CNAME check
 * against the currently-configured archive_domain on
 * tenant_public_settings. Returns the updated status envelope.
 *
 * 400 `no_domain` — no archive_domain configured (caller must PUT
 *                   /tenant-settings first).
 * 400 `invalid_domain` — shape / reserved-suffix validation failed.
 * 409 `domain_taken`  — another publication owns that domain.
 */
export function createVerifyArchiveCustomDomain({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function verifyArchiveCustomDomain(): Promise<
    ApiResult<ArchiveCustomDomainStatus>
  > {
    return request<ArchiveCustomDomainStatus>(
      "/api/v1/admin/archive/domain/verify",
      { method: "POST" },
    );
  };
}

/**
 * DELETE /api/v1/admin/archive/domain — un-verify the configured
 * archive_domain. The `archive_domain` column itself is NOT cleared
 * (mirrors Substack's "remove domain" semantics); call
 * `putArchiveTenantSettings({ archive_domain: "" })` separately if
 * the operator wants to drop the configured host entirely.
 *
 * Returns 204 No Content on success. Idempotent.
 */
export function createDeleteArchiveCustomDomain({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function deleteArchiveCustomDomain(): Promise<ApiResult<void>> {
    return request<void>("/api/v1/admin/archive/domain", { method: "DELETE" });
  };
}

/**
 * GET /api/v1/referral-programs/current — singleton active program.
 *
 * Returns 404 when no program is configured yet; callers should treat
 * that as the "Create program" empty state, not a hard error.
 */
export function createGetReferralProgram({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function getReferralProgram(): Promise<ApiResult<ReferralProgram>> {
    return request<ReferralProgram>("/api/v1/referral-programs/current");
  };
}

/** Refined Referrals PR 1: bundled admin stats. */
export function createGetReferralStats({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function getReferralStats(): Promise<
    ApiResult<ReferralStatsResponse>
  > {
    return request<ReferralStatsResponse>("/api/v1/referrals/stats");
  };
}

/**
 * GET /api/v1/referrals/payouts?status=&limit= — milestone-reward
 * payout queue for the admin fulfilment view.
 */
export function createListReferralPayouts({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function listReferralPayouts(
    opts: { status?: ReferralMilestonePayoutStatus; limit?: number } = {},
  ): Promise<ApiResult<ReferralMilestonePayoutListResponse>> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<ReferralMilestonePayoutListResponse>(
      `/api/v1/referrals/payouts${qs ? `?${qs}` : ""}`,
    );
  };
}

/**
 * PATCH /api/v1/referrals/payouts/{id} — advance a payout's status.
 * Legal transitions: pending→approved, approved→paid; anything else
 * 409s with an invalid-transition error. Returns the updated row.
 */
export function createUpdateReferralPayout({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function updateReferralPayout(
    id: string,
    status: "approved" | "paid",
  ): Promise<ApiResult<ReferralMilestonePayout>> {
    return request<ReferralMilestonePayout>(
      `/api/v1/referrals/payouts/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
  };
}

/** Refined Referrals PR 1: signup-time conversion credit. */
export function createCreditReferral({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function creditReferral(input: {
    subscriber_id: string;
  }): Promise<ApiResult<{ credited: boolean; reason?: string }>> {
    return request<{ credited: boolean; reason?: string }>(
      "/api/v1/referrals/credit",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/**
 * POST /api/v1/referral-programs — set / replace the active program.
 *
 * This is a full replacement contract. New operational callers must preserve
 * every stored reward/verification field and provide exactly one stale-write
 * precondition. The production route remains unmounted while the referral
 * runtime is release-gated; legacy SDK compatibility still permits an
 * unconditional request at the dormant handler boundary.
 */
export function createSetReferralProgram({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function setReferralProgram(input: {
    milestones: ReferralMilestone[];
    expires_at?: string | null;
    expected_program_id?: string;
    expect_no_active_program?: boolean;
    // D11#3: the POST is a full replace — callers must spread the current
    // program's referee-reward + verification settings or they are wiped.
    referee_reward_kind?: string;
    referee_reward_label?: string;
    referee_reward_image_asset_id?: string;
    reward_value_cents?: number;
    reward_currency?: string;
    reward_sku?: string;
    verification_window_days?: number;
  }): Promise<ApiResult<ReferralProgram>> {
    return request<ReferralProgram>("/api/v1/referral-programs", {
      method: "POST",
      body: JSON.stringify({
        milestones: input.milestones,
        expires_at: input.expires_at ?? null,
        expected_program_id: input.expected_program_id,
        expect_no_active_program: input.expect_no_active_program,
        referee_reward_kind: input.referee_reward_kind,
        referee_reward_label: input.referee_reward_label,
        referee_reward_image_asset_id: input.referee_reward_image_asset_id,
        reward_value_cents: input.reward_value_cents,
        reward_currency: input.reward_currency,
        reward_sku: input.reward_sku,
        verification_window_days: input.verification_window_days,
      }),
    });
  };
}

/** GET /api/v1/subscribers/{id}/referral — per-subscriber view. */
export function createGetSubscriberReferral({
  request,
}: ArchiveReferralOperationsDependencies) {
  return function getSubscriberReferral(
    subscriberId: string | number,
  ): Promise<ApiResult<ReferralSubscriberView>> {
    return request<ReferralSubscriberView>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/referral`,
    );
  };
}

export function createArchiveReferralOperationsMethods(
  dependencies: ArchiveReferralOperationsDependencies,
) {
  return {
    listArchive: createListArchive(dependencies),
    publishCampaignArchive: createPublishCampaignArchive(dependencies),
    listPaywallTiers: createListPaywallTiers(dependencies),
    upsertPaywallTier: createUpsertPaywallTier(dependencies),
    deactivatePaywallTier: createDeactivatePaywallTier(dependencies),
    unpublishCampaignArchive: createUnpublishCampaignArchive(dependencies),
    getArchiveStats: createGetArchiveStats(dependencies),
    pinArchive: createPinArchive(dependencies),
    unpinArchive: createUnpinArchive(dependencies),
    getArchiveRelatedPreview: createGetArchiveRelatedPreview(dependencies),
    getArchiveRelatedOverrides: createGetArchiveRelatedOverrides(dependencies),
    setArchiveRelatedOverrides: createSetArchiveRelatedOverrides(dependencies),
    getArchiveIssuePreview: createGetArchiveIssuePreview(dependencies),
    getArchiveTenantSettings: createGetArchiveTenantSettings(dependencies),
    putArchiveTenantSettings: createPutArchiveTenantSettings(dependencies),
    getArchiveCustomDomain: createGetArchiveCustomDomain(dependencies),
    verifyArchiveCustomDomain: createVerifyArchiveCustomDomain(dependencies),
    deleteArchiveCustomDomain: createDeleteArchiveCustomDomain(dependencies),
    getReferralProgram: createGetReferralProgram(dependencies),
    getReferralStats: createGetReferralStats(dependencies),
    listReferralPayouts: createListReferralPayouts(dependencies),
    updateReferralPayout: createUpdateReferralPayout(dependencies),
    creditReferral: createCreditReferral(dependencies),
    setReferralProgram: createSetReferralProgram(dependencies),
    getSubscriberReferral: createGetSubscriberReferral(dependencies),
  };
}
