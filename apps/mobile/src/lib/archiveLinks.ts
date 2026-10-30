/**
 * archiveLinks — build the tenant's PUBLIC archive URLs, or refuse.
 *
 * The public resolver is `WHERE tenant_archive_slug = $1`
 * (apps/api/internal/archive/archive.go TenantBySlug), served from
 * ARCHIVE_PUBLIC_BASE_URL or from a verified vanity `archive_domain`. Both
 * values come from GET /api/v1/admin/archive/tenant-settings.
 *
 * Mobile previously built `${PUBLIC_APP_BASE_URL}/archive/{workspaceSlug}/…`.
 * `workspaceSlug` is the AUTH workspace slug — a different, independently-set,
 * nullable column from `tenant_archive_slug` — and the app origin is not the
 * archive origin, so both halves of the URL were wrong and every shared link
 * 404'd. Desktop hit the identical bug and documents the fix verbatim at
 * apps/desktop/src/pages/Archive.tsx:78-107; this is that fix, ported.
 *
 * The contract these functions keep: return `null` rather than guess. A screen
 * that gets null must disable Open/Share/RSS with an explanation, because a
 * dead link shared into Slack is worse than a disabled button.
 */
import { normalizeExternalAppUrl } from "./config";

/**
 * Path-based public archive host. Overridable per build so a staging app does
 * not hand out production links. Kept local to this module (rather than
 * config.ts) because it is only meaningful for archive URLs.
 */
export const ARCHIVE_PUBLIC_HOST =
  normalizeExternalAppUrl(
    process.env.EXPO_PUBLIC_ARCHIVE_URL || "https://archive.moosewave.com",
  )?.replace(/\/$/, "") ?? "https://archive.moosewave.com";

/** The two resolver inputs, exactly as the tenant-settings endpoint returns them. */
export interface ArchivePublicIdentity {
  /** Verified vanity host, CNAME'd to Moosewave and serving the tenant at root. */
  archiveDomain?: string | undefined;
  /** The column the public resolver actually matches on. */
  tenantArchiveSlug?: string | undefined;
}

function trimTrailingSlash(value: string | null): string | null {
  return value ? value.replace(/\/$/, "") : null;
}

function cleanHost(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/**
 * The tenant's public archive index base, or null when no public archive is
 * configured. Vanity domain wins; otherwise the shared host plus the slug.
 */
export function archiveIndexBase(
  identity: ArchivePublicIdentity | null | undefined,
): string | null {
  if (!identity) return null;
  const domain = cleanHost(identity.archiveDomain ?? "");
  if (domain) {
    return trimTrailingSlash(normalizeExternalAppUrl(`https://${domain}`));
  }
  const slug = (identity.tenantArchiveSlug ?? "").trim();
  if (!slug) return null;
  return trimTrailingSlash(
    normalizeExternalAppUrl(
      `${ARCHIVE_PUBLIC_HOST}/${encodeURIComponent(slug)}`,
    ),
  );
}

/** Public URL for one issue, or null when the tenant has no public archive. */
export function archiveIssueURL(
  identity: ArchivePublicIdentity | null | undefined,
  issueSlug: string,
): string | null {
  const base = archiveIndexBase(identity);
  const issue = issueSlug.trim();
  if (!base || !issue) return null;
  return normalizeExternalAppUrl(`${base}/${encodeURIComponent(issue)}`);
}

/**
 * RSS feed. This one is served by the API, not the archive host —
 * GET /api/public/archive/{tenant_slug}/feed.xml (newsletter_feed.go) resolves
 * the SAME `tenant_archive_slug` column, so a vanity domain does not change it.
 */
export function archiveFeedURL(
  apiBase: string,
  identity: ArchivePublicIdentity | null | undefined,
): string | null {
  const base = apiBase.trim().replace(/\/+$/, "");
  const slug = (identity?.tenantArchiveSlug ?? "").trim();
  if (!base || !slug) return null;
  return normalizeExternalAppUrl(
    `${base}/api/public/archive/${encodeURIComponent(slug)}/feed.xml`,
  );
}

/**
 * One sentence explaining why the link affordances are disabled, or null when
 * they are not. Kept here so every call site says the same thing.
 */
export function archiveLinkBlockedReason(
  identity: ArchivePublicIdentity | null | undefined,
  { loaded = true, failed = false } = {},
): string | null {
  if (archiveIndexBase(identity)) return null;
  // A FAILED settings read (403 for a viewer role, or an offline fetch) never
  // becomes `loaded`, so reporting "Checking…" leaves the affordance stuck on a
  // sentence that will never come true. Say what actually happened.
  if (failed) {
    return "Your archive settings couldn't be read, so a public link can't be built. Try again when you're back online, or ask an admin.";
  }
  if (!loaded) return "Checking whether this workspace has a public archive…";
  return "No public archive is configured yet — set an archive slug or custom domain from the web admin.";
}
