// Pure, dependency-free predicates for the public locale-routed subscriber
// pages. Extracted from middleware.ts so they can be unit-tested without
// pulling in next-intl / next/server (which don't resolve under vitest).

// Public path prefixes that opt into locale routing. Anything else (notably
// /app/...) does not.
export const PUBLIC_LOCALIZED_PREFIXES = [
  "/forms",
  "/preferences",
  "/gift",
  "/landing",
  "/archive",
] as const;

export function isPublicLocalizedPath(pathname: string): boolean {
  return PUBLIC_LOCALIZED_PREFIXES.some((prefix) => {
    // `/forms` is special: bare `/forms` is the marketing capability page
    // ((marketing)/forms), while only `/forms/<slug>` is a hosted (localized)
    // subscriber form. Locale-routing bare `/forms` sends it to `/en/forms`,
    // which has no [locale]/forms index and hard-404s (audit MKTP-001). So only
    // sub-paths of `/forms` opt into locale routing; the bare path falls through
    // to the marketing route. Other prefixes keep bare→locale behavior.
    if (prefix === "/forms") return pathname.startsWith(`${prefix}/`);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

// The subset of public pages the product itself tells customers to iframe.
// The dashboard's embed panel and public/embed.js both build
// `<iframe src="…/forms/<slug>">`, and landing pages are framed the same way.
// Everything else under PUBLIC_LOCALIZED_PREFIXES is the opposite case:
// /preferences and /gift render subscriber PII against a capability token and
// must stay unframeable, or a third-party page can overlay them and harvest
// clicks against a real subscriber's identity.
const FRAMEABLE_PUBLIC_PREFIXES = ["/forms", "/landing"] as const;

/**
 * True for pages that must be embeddable on arbitrary customer origins.
 *
 * Accepts an optionally locale-prefixed path (`/es/forms/<slug>`) because the
 * middleware evaluates this before next-intl rewrites.
 */
export function isEmbeddablePublicPath(pathname: string): boolean {
  const withoutLocale = pathname.replace(/^\/[a-z]{2}(?=\/)/i, "");
  return FRAMEABLE_PUBLIC_PREFIXES.some((prefix) =>
    withoutLocale.startsWith(`${prefix}/`),
  );
}
