// SPDX-License-Identifier: AGPL-3.0-only

export type BillingRedirectPurpose = "checkout" | "portal";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function safeBillingRedirectURL(
  raw: string | null | undefined,
  purpose: BillingRedirectPurpose,
  currentOrigin = typeof window !== "undefined" ? window.location.origin : undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
      return trimmed.startsWith("/app/billing") ? trimmed : null;
    }

    const url = new URL(trimmed);
    if (url.protocol !== "https:" && !isLocalURL(url)) return null;
    if (url.username || url.password) return null;
    url.hash = "";

    if (isStripeURL(url, purpose)) return url.toString();
    if (currentOrigin && sameOrigin(url, currentOrigin) && url.pathname.startsWith("/app/billing")) {
      return url.toString();
    }
    if (isLocalURL(url) && url.pathname.startsWith("/app/billing")) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

export function safeExternalHTTPSURL(
  raw: string | null | undefined,
  allowedRelativePrefixes: string[] = [],
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    // Segment-boundary match via the same helper safeNextPath uses. A bare
    // startsWith let "/app/migrations/oauth/callbackEVIL" satisfy the
    // "/app/migrations/oauth/callback" prefix, and skipped the control-char
    // and "."/".." rejection the sibling validator applies.
    return allowedRelativePrefixes.some((prefix) =>
      isSafeRelativePath(trimmed, prefix),
    )
      ? trimmed
      : null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function safeInvoiceDownloadURL(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return isStripeInvoiceURL(url) ? url.toString() : null;
  } catch {
    return null;
  }
}

// SafeNextPathOptions controls the allow-list for `?next=` redirect
// destinations after an auth flow (login, TOTP challenge, magic-link
// consume). The base allow-list is always /app and /app/*; callers
// can extend with extra-allowed prefixes (e.g. the login page also
// allows /verify-email to complete the email-verification flow).
export interface SafeNextPathOptions {
  extraPrefixes?: readonly string[];
}

/**
 * Request header the middleware uses to forward the current path to server
 * components, which cannot otherwise read it.
 *
 * It is set from `req.nextUrl` on every middleware-handled request, so an
 * inbound header of the same name from a client is always overwritten rather
 * than trusted. Consumers must still pass the value through
 * {@link safeNextPath} — a forwarded path is a *hint*, and the allow-list is
 * what makes it safe to redirect to.
 */
export const PATHNAME_HEADER = "x-postwave-pathname";

// safeNextPath is the centralised auth-flow `?next=` validator.
// Audit finding (frontend nav): two private copies in login/page.tsx
// and totp-challenge/page.tsx had already diverged (/verify-email
// allowed in one, not the other) and neither was test-covered.
// The middleware also writes `?next=` server-side; both layers now
// share the same allow-list semantics.
export function safeNextPath(
  value: string | null,
  opts: SafeNextPathOptions = {},
): string {
  if (!value) return "/app";
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/app";
  }
  // Reject anything that isn't a same-origin absolute path. `//host`
  // is a protocol-relative URL and would redirect to a different
  // origin; `https://` is similarly dangerous.
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/app";
  if (isSafeRelativePath(decoded, "/app")) return decoded;
  for (const prefix of opts.extraPrefixes ?? []) {
    if (isSafeRelativePath(decoded, prefix)) return decoded;
  }
  return "/app";
}

function isSafeRelativePath(value: string, prefix: string): boolean {
  if (!prefix.startsWith("/") || prefix.startsWith("//")) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value, "https://app.postwave.local");
  } catch {
    return false;
  }
  if (url.origin !== "https://app.postwave.local") return false;
  if (url.pathname.split("/").some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

export function safeImageURL(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && !isLocalURL(url)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isStripeURL(url: URL, purpose: BillingRedirectPurpose): boolean {
  const host = url.hostname.toLowerCase();
  if (purpose === "checkout") {
    return (
      host === "checkout.stripe.com" ||
      host === "buy.stripe.com" ||
      host === "checkout.stripe.example"
    );
  }
  return host === "billing.stripe.com" || host === "billing.stripe.example";
}

function isStripeInvoiceURL(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === "invoice.stripe.com" ||
    host === "pay.stripe.com" ||
    host === "billing.stripe.com" ||
    host === "invoice.stripe.example" ||
    host === "pay.stripe.example"
  );
}

function isLocalURL(url: URL): boolean {
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname.toLowerCase());
}

function sameOrigin(url: URL, origin: string): boolean {
  try {
    return url.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
