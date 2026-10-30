// SPDX-License-Identifier: MIT

const MAX_SESSION_URL_LENGTH = 2_048;
const MAX_ORIGIN_LENGTH = 512;
const BOOTSTRAP_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export function portalSessionOrigin(
  value: string,
  allowedOrigin: string,
): string {
  const parsed = parsePortalSessionUrl(value, allowedOrigin);
  return parsed?.origin ?? "";
}

export function withPortalTheme(
  value: string,
  theme: "light" | "dark" | undefined,
  allowedOrigin: string,
  parentOrigin?: string,
): string {
  const parsed = parsePortalSessionUrl(value, allowedOrigin);
  if (!parsed) return "about:blank";
  if (theme) parsed.searchParams.set("theme", theme);
  // `undefined` means "not supplied" — the parameter is genuinely optional for
  // a direct caller of this function. Any OTHER value, including "", means the
  // caller meant to supply one, so an unusable value fails closed exactly as a
  // malformed origin already did.
  //
  // `if (parentOrigin)` conflated the two, and the empty string is the likelier
  // mistake: an env var that did not load, `props.origin ?? ""`, an
  // uninitialised field. PostwaveAuditPortal types the prop as REQUIRED, so ""
  // is always a caller error there — and it was the one that failed silently.
  // The iframe rendered, the portal booted, and onLoaded/onError never fired,
  // because the SPA correctly refuses to postMessage without a targetOrigin
  // (apps/audit-portal/src/App.tsx). A malformed origin blanked the frame and
  // was obvious; an empty one produced a working-looking portal with dead
  // callbacks and nothing to point at.
  if (parentOrigin !== undefined) {
    const normalizedParent = normalizePortalOrigin(parentOrigin);
    if (!normalizedParent) return "about:blank";
    parsed.searchParams.set("parent_origin", normalizedParent);
  }
  return parsed.toString();
}

function parsePortalSessionUrl(
  value: string,
  allowedOrigin: string,
): URL | null {
  if (value.length === 0 || value.length > MAX_SESSION_URL_LENGTH) return null;
  const expectedOrigin = normalizePortalOrigin(allowedOrigin);
  if (!expectedOrigin) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== expectedOrigin ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/portal/audit" ||
      parsed.search ||
      !parsed.hash.startsWith("#bootstrap=")
    ) {
      return null;
    }
    const token = parsed.hash.slice("#bootstrap=".length);
    if (
      token.length < 64 ||
      token.length > 1_800 ||
      !BOOTSTRAP_TOKEN.test(token)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizePortalOrigin(value: string): string {
  if (value.length === 0 || value.length > MAX_ORIGIN_LENGTH) return "";
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}
