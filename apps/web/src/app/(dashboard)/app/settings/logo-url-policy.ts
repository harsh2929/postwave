// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether the dashboard is allowed to RENDER a workspace logo URL.
//
// The dashboard's `img-src` (src/middleware.ts) is `'self' data: blob:` plus
// the configured Moosewave assets origin and the reCAPTCHA hosts — the `https:`
// wildcard applies only to published-archive paths. So a logo hosted on the
// operator's own CDN — exactly what the field's placeholder used to suggest —
// is blocked before a byte is fetched: the <img> fires onError, the console
// logs a CSP violation, a report is POSTed to /api/csp-report, and the UI told
// the operator their URL was broken. It is not; the page's policy is.
//
// The value is still saved and still used where the policy permits (published
// archive pages), so this only decides what the settings preview may attempt.

/** Origin images may be loaded from in the dashboard, or null when unset. */
export function configuredAssetsOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export type LogoPreviewVerdict =
  /** Nothing to preview. */
  | { kind: "empty" }
  /** Renderable here: same-origin, data:/blob:, or the assets origin. */
  | { kind: "allowed" }
  /** A syntactically invalid URL — the operator really did mistype it. */
  | { kind: "invalid" }
  /** Valid, but this page's CSP will not load it. */
  | { kind: "blocked"; origin: string; allowedOrigin: string | null };

/**
 * Classify a logo URL for the settings preview.
 *
 * `pageOrigin` is the origin the dashboard is served from ('self'); pass
 * `window.location.origin` at the call site so this stays pure and testable.
 */
export function classifyLogoPreview(
  rawUrl: string,
  pageOrigin: string | null,
): LogoPreviewVerdict {
  const value = rawUrl.trim();
  if (!value) return { kind: "empty" };

  // Relative paths resolve against the page origin, which `'self'` covers.
  if (value.startsWith("/") && !value.startsWith("//")) {
    return { kind: "allowed" };
  }
  if (/^(data|blob):/i.test(value)) return { kind: "allowed" };

  let parsed: URL;
  try {
    parsed = new URL(value, pageOrigin ?? undefined);
  } catch {
    return { kind: "invalid" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { kind: "invalid" };
  }

  const allowedOrigin = configuredAssetsOrigin();
  if (parsed.origin === pageOrigin || parsed.origin === allowedOrigin) {
    return { kind: "allowed" };
  }
  return { kind: "blocked", origin: parsed.origin, allowedOrigin };
}

/** Operator-facing explanation for a blocked preview. */
export function logoPreviewBlockedMessage(
  verdict: Extract<LogoPreviewVerdict, { kind: "blocked" }>,
): string {
  const allowed = verdict.allowedOrigin
    ? `only from ${verdict.allowedOrigin}`
    : "only from this workspace's own asset host";
  return (
    `Preview unavailable here: this page's security policy loads images ` +
    `${allowed}, so ${verdict.origin} cannot be shown in the dashboard.`
  );
}
