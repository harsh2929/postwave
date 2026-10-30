import { Resource } from "./_base.js";

/**
 * One row of `GET /api/v1/archive` — mirrors `archive.IssueSummary`
 * (apps/api/internal/archive/archive.go).
 *
 * The optional fields are optional on the WIRE, not merely in the SDK:
 * `campaignId`, `viewCount` and `uniqueVisitors` carry `omitempty` and are
 * populated only on the admin-authenticated list, so the unauthenticated
 * public index omits them entirely. `pinned` always ships.
 */
export interface ArchiveIssueSummary {
  slug: string;
  subject: string;
  excerpt: string;
  publishedAt: string;
  /** Always present; the public index renders it as a "Featured" tag. */
  pinned: boolean;
  /** Admin list only — the join key for the per-issue analytics drilldown. */
  campaignId?: string;
  /** Admin list only — 30-day view aggregate. */
  viewCount?: number;
  /** Admin list only — 30-day unique-visitor aggregate. */
  uniqueVisitors?: number;
}

/** `GET /api/v1/archive/{slug}` — mirrors `archive.IssueDetail`. */
export interface ArchiveIssueDetail {
  slug: string;
  subject: string;
  htmlBody: string;
  publishedAt: string;
  pinned?: boolean;
  metaDescription?: string;
  ogImage?: string;
  heroImage?: string;
  authorName?: string;
  canonicalUrl?: string;
  excerpt?: string;
  /** Admin path only. */
  campaignId?: string;
}

export interface ArchiveListPage {
  items: ArchiveIssueSummary[];
  nextCursor?: string;
}

/**
 * Query params for {@link ArchiveResource.list}.
 *
 * `q` is a case-insensitive substring match against subject + slug. The
 * handler reads it through `listsearch.ReadQuery`, which accepts BOTH `query`
 * and `q` (`query` wins when both are present); the SDK sends `q` so a single
 * spelling is used across clients. It has always been honoured server-side —
 * omitting it from the SDK is why callers were filtering one 50-row page
 * client-side and reporting an authoritative "Nothing matches" for anything
 * older than the first page.
 */
export interface ArchiveListParams {
  limit?: number;
  cursor?: string;
  q?: string;
}

export interface PublishToArchiveInput {
  slug?: string;
  excerpt?: string;
}

/**
 * Read-only access to the public campaign archive plus admin
 * publish / unpublish toggles.
 */

export class ArchiveResource extends Resource {
  /** Tenant-scoped admin list. */
  list(opts?: ArchiveListParams): Promise<ArchiveListPage> {
    const query: Record<string, string | number | undefined> = {};
    if (opts?.limit !== undefined) query.limit = opts.limit;
    if (opts?.cursor) query.cursor = opts.cursor;
    const q = opts?.q?.trim();
    if (q) query.q = q;
    return this.client.request("GET", "/api/v1/archive", { query });
  }

  /**
   * A tenant's PUBLIC archive index — the reader-facing view.
   *
   * Distinct from `list()` above, which is the authenticated owner's view of
   * their own archive. This one resolves a public tenant slug and deliberately
   * exposes neither internal campaign identifiers nor traffic aggregates, which
   * is why it is a separate operation rather than a flag: the two answers have
   * different audiences and must not be able to become the same response by
   * accident.
   *
   * `security: []` in the surface spec — no key required. The SDK sends one
   * anyway when configured, which the gateway ignores here.
   */
  publicIndex(
    tenantSlug: string,
    opts?: { limit?: number; cursor?: string; query?: string },
  ): Promise<ArchiveListPage> {
    const query: Record<string, string | number | undefined> = {};
    if (opts?.limit !== undefined) query.limit = opts.limit;
    if (opts?.cursor) query.cursor = opts.cursor;
    const q = opts?.query?.trim();
    if (q) query.query = q;
    return this.client.request(
      "GET",
      `/api/public/archive/${encodeURIComponent(tenantSlug)}`,
      { query },
    );
  }

  /** One published issue from a tenant's public archive, by its archive slug. */
  publicIssue(tenantSlug: string, campaignSlug: string): Promise<ArchiveIssueDetail> {
    return this.client.request(
      "GET",
      `/api/public/archive/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(campaignSlug)}`,
    );
  }

  publish(campaignId: string, input: PublishToArchiveInput = {}): Promise<{ ok: boolean }> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/publish-archive`,
      { body: input },
    );
  }

  unpublish(campaignId: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/unpublish-archive`,
    );
  }
}
