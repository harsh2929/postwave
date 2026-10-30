/**
 * Reads the one-time bootstrap from the URL fragment and removes all
 * credential-bearing URL state before any network request is made.
 */
export function consumePortalBootstrap(
  location: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  history: Pick<History, "replaceState"> = window.history,
): string {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const bootstrap = params.get("bootstrap")?.trim() ?? "";
  const safePath = location.pathname.startsWith("/portal/audit/")
    ? "/portal/audit"
    : location.pathname;

  // The portal accepts only one non-secret query parameter. Dropping every
  // other key also scrubs legacy ?token= / ?bootstrap= links before browser
  // telemetry, support tooling, or a copied address can retain them.
  const incomingQuery = new URLSearchParams(location.search);
  const theme = incomingQuery.get("theme");
  const parentOrigin = normalizeParentOrigin(incomingQuery.get("parent_origin"));
  const safeParams = new URLSearchParams();
  if (theme === "light" || theme === "dark") safeParams.set("theme", theme);
  if (parentOrigin) safeParams.set("parent_origin", parentOrigin);
  const safeQuery = safeParams.size ? `?${safeParams.toString()}` : "";
  if (
    location.hash ||
    safePath !== location.pathname ||
    safeQuery !== location.search
  ) {
    history.replaceState(null, "", `${safePath}${safeQuery}`);
  }
  return bootstrap.length <= 2048 ? bootstrap : "";
}

/**
 * Returns the exact HTTPS origin that the embedding SDK placed in the
 * credential-free query string. postMessage callers use this as targetOrigin;
 * an absent or malformed value disables the bridge instead of using `*`.
 */
export function portalParentOrigin(
  location: Pick<Location, "search"> = window.location,
): string {
  return normalizeParentOrigin(
    new URLSearchParams(location.search).get("parent_origin"),
  );
}

/**
 * Test seam for the origin validator.
 *
 * The rule it enforces — bare HTTPS origin, no credentials, no path,
 * query or fragment — is what makes the outbound postMessage safe, so it
 * is worth asserting directly rather than only through the two callers.
 */
export function normalizeParentOriginForTest(raw: string | null): string {
  return normalizeParentOrigin(raw);
}

function normalizeParentOrigin(raw: string | null): string {
  if (!raw || raw.length > 512) return "";
  try {
    const parsed = new URL(raw);
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
