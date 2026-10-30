/**
 * archiveContracts — the runtime boundary for the published-issue surfaces.
 *
 * Split out of `deliverabilityContracts.ts` when that module reached its
 * 450-line ceiling, following the `suppressionContracts.ts` precedent: the
 * coercion primitives stay in one place and each feature area owns its own
 * parsers. Same three rules — coerce numerics behind a finite check, drop
 * malformed rows rather than render half a row, and throw a typed error when
 * the ENVELOPE itself is unrecognisable so the screen shows an honest error
 * instead of "nothing published yet".
 *
 * Deliberately does NOT re-export through deliverabilityContracts: that would
 * make the two modules mutually importing, and a class binding (WireShapeError)
 * in an import cycle is a live temporal-dead-zone hazard at module-eval time.
 */
import {
  bool,
  itemsOf,
  numberOr,
  str,
  WireShapeError,
} from "./deliverabilityContracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapRows<T>(
  value: unknown,
  resource: string,
  parse: (row: Record<string, unknown>) => T | null,
): T[] {
  const out: T[] = [];
  for (const row of itemsOf(value, resource)) {
    if (!isRecord(row)) continue;
    const parsed = parse(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export interface ArchiveIssue {
  slug: string;
  subject: string;
  excerpt: string;
  publishedAt: string;
  pinned: boolean;
  viewCount: number;
  uniqueVisitors: number;
  /**
   * The campaign this issue was published from. `archive.IssueSummary` ships
   * it as `campaignId,omitempty` on the ADMIN list projection only, and it is
   * the path parameter every archive mutation takes
   * (POST /api/v1/campaigns/{id}/unpublish-archive). Empty string means the
   * server did not send one — a row without it cannot be unpublished, and the
   * UI must say so rather than POST to `/campaigns//unpublish-archive`.
   */
  campaignId: string;
}

export interface ArchivePage {
  items: ArchiveIssue[];
  nextCursor: string | null;
}

/**
 * `pinned`, `viewCount` and `uniqueVisitors` all ship on the wire
 * (archive.IssueSummary) and were previously read through a local cast in the
 * screen. They are first-class here.
 */
export function parseArchivePage(value: unknown): ArchivePage {
  const items = mapRows(value, "archive", (row) => {
    const slug = str(row.slug).trim();
    if (!slug) return null;
    return {
      slug,
      subject: str(row.subject),
      excerpt: str(row.excerpt),
      publishedAt: str(row.publishedAt),
      pinned: bool(row.pinned),
      viewCount: Math.max(0, numberOr(row.viewCount, 0)),
      uniqueVisitors: Math.max(0, numberOr(row.uniqueVisitors, 0)),
      campaignId: str(row.campaignId).trim(),
    };
  });
  const cursor = isRecord(value) ? str(value.nextCursor).trim() : "";
  return { items, nextCursor: cursor || null };
}

/**
 * The admin preview projection — GET /api/v1/admin/archive/issues/{slug}/preview
 * (archive.IssueDetail). Distinct from the list row: it carries the rendered
 * `htmlBody` plus the SEO/authorship fields, and it is readable WITHOUT the
 * tenant having any public archive routing configured at all.
 */
export interface ArchiveIssuePreview {
  slug: string;
  subject: string;
  htmlBody: string;
  publishedAt: string;
  pinned: boolean;
  excerpt: string;
  authorName: string;
  metaDescription: string;
  canonicalUrl: string;
  campaignId: string;
}

export function parseArchiveIssuePreview(value: unknown): ArchiveIssuePreview {
  if (!isRecord(value)) throw new WireShapeError("archive issue preview");
  const slug = str(value.slug).trim();
  if (!slug) throw new WireShapeError("archive issue preview");
  return {
    slug,
    subject: str(value.subject),
    htmlBody: str(value.htmlBody),
    publishedAt: str(value.publishedAt),
    pinned: bool(value.pinned),
    excerpt: str(value.excerpt),
    authorName: str(value.authorName),
    metaDescription: str(value.metaDescription),
    canonicalUrl: str(value.canonicalUrl),
    campaignId: str(value.campaignId).trim(),
  };
}

export interface ArchiveTenantSettings {
  tenantArchiveSlug: string;
  archiveDomain: string;
  archiveTitle: string;
}

export function parseArchiveTenantSettings(
  value: unknown,
): ArchiveTenantSettings {
  if (!isRecord(value)) throw new WireShapeError("archive settings");
  return {
    tenantArchiveSlug: str(value.tenant_archive_slug).trim(),
    archiveDomain: str(value.archive_domain).trim(),
    archiveTitle: str(value.archive_title).trim(),
  };
}
