/**
 * podcast-feed — pure URL-building logic behind PodcastTokensCard
 * (backlog #52). Kept JSX-free so the node-environment vitest suite
 * can import it directly.
 *
 * Public surface it mirrors (apps/api/internal/podcast/podcast.go):
 *   GET /api/public/podcast/{tenant_slug}/feed.xml          — public feed,
 *       free episodes only; suitable for Apple/Spotify directory listing.
 *   GET /api/public/podcast/{tenant_slug}/feed/{token}.xml  — per-subscriber
 *       tokenized feed; entitlement-aware (premium episodes included when
 *       the subscriber's tier allows). Token travels as a path segment so
 *       strict podcast aggregators that strip query params still work.
 */

/** Strip trailing slashes from the API base so joins are clean. */
function trimBase(base: string): string {
  return String(base ?? "").replace(/\/+$/, "");
}

/** Public (un-tokenized) RSS feed URL — free episodes only. */
export function publicPodcastFeedUrl(base: string, tenantSlug: string): string {
  return `${trimBase(base)}/api/public/podcast/${encodeURIComponent(tenantSlug)}/feed.xml`;
}

/**
 * Per-subscriber tokenized feed URL. The token is the raw secret the
 * mint POST returns ONCE — the server never re-issues it. Prefer the
 * server-returned `feed_url` when present; this builder is the
 * fallback for environments where the mint response omits it.
 */
export function tokenizedPodcastFeedUrl(
  base: string,
  tenantSlug: string,
  token: string,
): string {
  return `${trimBase(base)}/api/public/podcast/${encodeURIComponent(tenantSlug)}/feed/${encodeURIComponent(token)}.xml`;
}

/**
 * Resolve the tenant slug the public podcast routes key on. The
 * Settings page persists it at `postwave_tenant_slug` (same source the
 * Archive page uses for public-archive URLs). Returns null when unset
 * so the card can render an honest "configure your tenant slug"
 * placeholder instead of a broken URL.
 */
export function readTenantSlug(
  storage: Pick<Storage, "getItem"> | undefined,
): string | null {
  try {
    const v = storage?.getItem("postwave_tenant_slug");
    if (!v || !v.trim()) return null;
    return v
      .toLowerCase()
      .trim()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  } catch {
    return null;
  }
}

/** Loose email shape check for the lookup input — mirrors the page-level
 *  validators used elsewhere (GiftSubscriptions, Subscribers). */
export function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
