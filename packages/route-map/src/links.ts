import {
  type EntityDef,
  type RouteSurface,
  getEntity,
  entityForSlug,
  isEntityResourceId,
} from "./entities.js";

/** Custom deep-link scheme registered by desktop (Tauri) + mobile (Expo). */
export const DEEP_LINK_SCHEME = "moosewave";
/** Host that owns the universal/app links (AASA served by apps/web). */
export const UNIVERSAL_HOST = "app.moosewave.com";

export interface EntityRef {
  entity: string;
  id: string;
}

/**
 * Resolve one surface's path for an entity, honouring what that surface can
 * actually render:
 *
 *   "detail" → `<detailPrefix>/<slug>/<id>`
 *   "list"   → `<detailPrefix>/<slug>`   (closest reachable landing)
 *   "none"   → null                      (surface does not ship this entity)
 *
 * Returning null for "none" is deliberate. A caller that receives null can hide
 * the affordance ("Open on phone" simply does not appear); a caller handed a
 * plausible-looking path for a screen that was never built shows a broken link
 * instead.
 */
function surfacePath(
  surface: RouteSurface,
  base: string,
  entity: string,
  id: string,
): string | null {
  const def = getEntity(entity);
  if (!def) return null;
  const support = def.surfaces[surface];
  if (support === "none") return null;

  // The id is validated only where it is actually EMITTED. A "list" surface
  // renders `<base>/<slug>` and never interpolates the id, so rejecting the
  // whole link because of it discarded a perfectly good collection route.
  //
  // That was not theoretical: `suppression` is web-"list", and a suppression is
  // identified by an EMAIL (mobile ships suppressions/[email].tsx). Every email
  // fails isSafeResourceId — `@` and `.` are outside its alphabet — so
  // webPath("suppression", <email>) returned null and the "open on web"
  // affordance vanished for every real suppression, even though the emitted
  // path `/app/suppressions` contains no id at all.
  //
  // This file's own rule is that a link landing on the list is RECOVERABLE
  // while a 404 is not. Validating an unused id inverted that: it turned a
  // recoverable link into no link.
  if (support === "list") return `${base}/${def.slug}`;

  if (!isEntityResourceId(def.key, id)) return null;
  return `${base}/${def.slug}/${id}`;
}

/** `/app/<slug>/<id>` — the web dashboard route, or the list when web has no
 *  detail page, or null when web does not ship the entity at all. */
export function webPath(entity: string, id: string): string | null {
  return surfacePath("web", "/app", entity, id);
}

/**
 * Desktop renders the same `/app/<slug>/…` shape as web but owns a separate
 * section vocabulary (`desktop-router.ts SECTION_SLUGS`), so it resolves
 * against its own support axis. It is NOT an alias of `webPath`: web ships
 * `flows`/`landing-pages`/`inbound-webhooks` sections desktop does not, and
 * desktop ships `lists`/`segments`/`helpdesk` sections web does not. Aliasing
 * them produced a path that hit desktop's `unknown-destination` parse failure.
 */
export function desktopPath(entity: string, id: string): string | null {
  return surfacePath("desktop", "/app", entity, id);
}

/**
 * Mobile route. Entities with a detail screen get `/(tabs)/<slug>/<id>`;
 * list-only entities land on `/(tabs)/<slug>`; entities mobile does not ship
 * resolve to null.
 */
export function mobilePath(entity: string, id: string): string | null {
  return surfacePath("mobile", "/(tabs)", entity, id);
}

/** `moosewave://<action>/<id>` — matches the desktop deep_link.rs grammar. */
export function buildDeepLink(entity: string, id: string): string | null {
  const def = getEntity(entity);
  if (!def || !isEntityResourceId(def.key, id)) return null;
  return `${DEEP_LINK_SCHEME}://${def.key}/${id}`;
}

/**
 * `https://app.moosewave.com/app/<slug>/<id>` — the shareable web URL that also
 * resolves in the native apps via universal/app links.
 *
 * Derived from `webPath` rather than rebuilt, because a universal link IS a web
 * URL: whoever opens it without the app installed gets the browser. So it
 * inherits web's fallback (list route when there is no detail page) and returns
 * null when web does not ship the entity at all — sharing a link that 404s for
 * every recipient without the native app is worse than offering no link.
 */
export function buildUniversalLink(entity: string, id: string): string | null {
  const path = webPath(entity, id);
  return path === null ? null : `https://${UNIVERSAL_HOST}${path}`;
}

/**
 * Parse a `moosewave://<action>/<id>` deep link into an EntityRef. Mirrors
 * desktop's parser: unknown actions and unsafe ids return null. Query
 * strings are ignored (they carry presentation hints, not identity).
 */
export function parseDeepLink(url: string): EntityRef | null {
  const prefix = `${DEEP_LINK_SCHEME}://`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length).split(/[?#]/, 1)[0] ?? "";
  // Strict <action>/<id> grammar matching the desktop Rust parser: exactly
  // one non-empty action segment then exactly one non-empty id segment.
  // Do NOT collapse empty segments (filter(Boolean)) — that would accept
  // "campaign//id" or trailing slashes the desktop grammar rejects, making
  // the two parsers disagree.
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const action = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (!action || !id || id.includes("/")) return null;
  const def = getEntity(action);
  if (!def || !isEntityResourceId(def.key, id)) return null;
  return { entity: def.key, id };
}

/** The universal-link path that opens the new-device approval screen. Shared
 *  by the AASA claim (apps/web), the parser below, and the mobile router so a
 *  single literal governs the device-approve association — it can't drift. */
export const CLI_DEVICE_APPROVE_PATH = "/cli/auth";

/** RFC 8628 short user_code grammar the device grant mints (unambiguous
 *  uppercase alphabet, `XXXX-XXXX`) — the same shape the API validates and the
 *  approval screen displays. Matched exactly: this code drives an *approval*,
 *  so the link parser never normalises or widens it. */
const DEVICE_APPROVE_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export interface DeviceApproveRef {
  userCode: string;
}

/**
 * `https://app.moosewave.com/cli/auth?user_code=XXXX-XXXX` — the QR/handoff link
 * the CLI's device grant renders (`verification_uri_complete`). Scanning or
 * opening it on a signed-in device lands the approver on the approval screen.
 *
 * Deliberately **universal-link only** (no `moosewave://` custom scheme): device
 * approval is a security action, so it must arrive over an AASA/assetlinks-
 * verified host — an arbitrary app can register a custom scheme, but only the
 * real app is associated with the verified domain. Host is checked against the
 * same allow-list convention as `parseUniversalLink` (multi-region aware), the
 * path must match `CLI_DEVICE_APPROVE_PATH` exactly (no slash-folding), and the
 * code must match the `XXXX-XXXX` grammar. Returns null on any mismatch; never
 * throws.
 */
export function parseDeviceApproveLink(
  url: string,
  allowedHosts: readonly string[] = [UNIVERSAL_HOST],
): DeviceApproveRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // Anti-spoof: https + allow-listed host only, and no credential-in-URL
  // smuggling (`https://user:pass@host`) or fragment tricks.
  if (u.protocol !== "https:" || !allowedHosts.includes(u.host)) return null;
  if (u.username || u.password || u.hash) return null;
  if (u.pathname !== CLI_DEVICE_APPROVE_PATH) return null;
  const queryKeys: string[] = [];
  u.searchParams.forEach((_value, key) => queryKeys.push(key));
  if (
    queryKeys.length !== 1 ||
    queryKeys[0] !== "user_code" ||
    u.searchParams.getAll("user_code").length !== 1
  ) {
    return null;
  }
  // The backend-generated QR is canonical. Do not widen an externally
  // supplied approval link by trimming or case-folding its decoded query.
  // Manual entry is normalized by the form before it reaches this parser.
  const userCode = u.searchParams.get("user_code") ?? "";
  if (!DEVICE_APPROVE_CODE_RE.test(userCode)) return null;
  return { userCode };
}

/** Build the canonical device-approve universal link for a `XXXX-XXXX` code, or
 *  null if the code is malformed. Public API that pairs with
 *  `parseDeviceApproveLink` (same as `buildUniversalLink`/`buildDeepLink` pair
 *  with their parsers) and documents the one canonical link format; the round-
 *  trip test exercises it. The *live* producer is the Go backend, which mints a
 *  deployment-correct `verification_uri_complete` — so first-party clients render
 *  that server URL rather than rebuilding it (which would hardcode host/path and
 *  break self-host/multi-region). This is the constructor an external integrator
 *  or a future same-host producer uses. */
export function buildDeviceApproveLink(
  userCode: string,
  host: string = UNIVERSAL_HOST,
): string | null {
  const code = userCode.trim().toUpperCase();
  if (!DEVICE_APPROVE_CODE_RE.test(code)) return null;
  return `https://${host}${CLI_DEVICE_APPROVE_PATH}?user_code=${code}`;
}

/**
 * Parse a universal/web link (`https://app.moosewave.com/app/<slug>/<id>`,
 * or a bare `/app/<slug>/<id>` path) into an EntityRef.
 */
export function parseUniversalLink(
  url: string,
  allowedHosts: readonly string[] = [UNIVERSAL_HOST],
): EntityRef | null {
  let path = url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    try {
      const u = new URL(url);
      // Only an allow-listed host over https resolves as a universal link —
      // reject http:// and any other scheme/host (anti-spoofing). The default
      // is the single canonical host; a multi-region / self-host client passes
      // its own deployment host(s) so its region's links route natively without
      // widening trust to arbitrary hosts.
      if (u.protocol !== "https:" || !allowedHosts.includes(u.host))
        return null;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const parts = path.split(/[?#]/, 1)[0]!.split("/").filter(Boolean);
  // expect ["app", "<slug>", "<id>"]
  if (parts.length !== 3 || parts[0] !== "app") return null;
  const def: EntityDef | undefined = entityForSlug(parts[1]!);
  const id = parts[2]!;
  if (!def || !isEntityResourceId(def.key, id)) return null;
  return { entity: def.key, id };
}
