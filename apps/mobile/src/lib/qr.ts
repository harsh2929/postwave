/**
 * lib/qr.ts — pure interpretation of an externally-supplied string into an
 * actionable intent.
 *
 * TWO real callers, and only two: the QR scanner (app/(tabs)/scan.tsx) feeds it
 * a scanned barcode payload, and lib/sharedInbox.ts feeds it a string handed to
 * the app by the iOS share extension. The name says "Clipboard" for historical
 * reasons and the doc used to promise a paste path as well — there is none:
 * `expo-clipboard` is not a dependency and no file in the app reads the
 * pasteboard, so "paste a code" was a stated contract with no implementation
 * (NATIVE#40). Stated plainly here rather than left to be discovered.
 *
 * It also carries the desktop→mobile handoff: the web/desktop admin renders a
 * `moosewave://` or `https://app.moosewave.com/app/<slug>/<id>` QR; scanning it
 * on the phone opens that exact entity. We lean on @postwave/route-map — the
 * single source of truth shared with web/desktop — to recognise both link
 * shapes, so the three surfaces can never drift.
 *
 * Recognition order (most specific → least):
 *   1. `moosewave://<action>/<id>`                 → entity (parseDeepLink)
 *   2. `https://app.moosewave.com/app/<slug>/<id>` → entity (parseUniversalLink)
 *   3. `https://<app-host>/cli/auth?user_code=…`  → deviceApprove
 *   4. a bare email (`mailto:` or `user@host`)    → email
 *   5. any other http(s) URL                      → url
 *   6. anything else                              → unknown
 *
 * The `href` for an entity is the mobile route string (mobilePath) —
 * `/(tabs)/<slug>/<id>` for entities with a detail screen, else the
 * list route `/(tabs)/<slug>`. The caller turns that into a typed Href.
 *
 * Pure + side-effect free so it's trivially unit-testable; the screen
 * owns all navigation / Linking / permission concerns.
 */
import {
  mobilePath,
  parseDeepLink,
  parseDeviceApproveLink as parseDeviceApproveRef,
  parseUniversalLink,
} from "@postwave/route-map";

import { PUBLIC_APP_BASE_URL } from "@/lib/config";

/** Hard cap so a pathological QR (e.g. a giant data: blob) can't be
 *  treated as a "url" we'd hand to Linking or render in the UI. */
const MAX_QR_VALUE_CHARS = 4096;

/**
 * A conservative single-address email matcher. We deliberately do NOT
 * try to be RFC-5322 complete — a QR that's "just an email" is the
 * common case (a vCard-ish contact code); anything fancier falls
 * through to url/unknown rather than being mis-handled as an email.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type QrInterpretation =
  | { kind: "entity"; href: string }
  | { kind: "email"; email: string }
  | { kind: "deviceApprove"; userCode: string }
  | { kind: "url"; url: string }
  | { kind: "unknown" };

/**
 * Recognize a CLI device-authorization approval link
 * (`https://<app-host>/cli/auth?user_code=ABCD-EFGH`) — the QR the
 * `postwave login --device` flow prints. Delegates to @postwave/route-map's
 * `parseDeviceApproveLink` so the scan path and the universal-link deep-link
 * path (lib/deepLinks.ts) share ONE grammar + host allow-list — no drift, and
 * multi-region hosts are honoured uniformly. Returns the normalized user code
 * or null.
 */
export function parseDeviceApproveLink(raw: string): string | null {
  return parseDeviceApproveRef(raw, [new URL(PUBLIC_APP_BASE_URL).host])?.userCode ?? null;
}

/**
 * interpretClipboardOrQr maps a raw scanned/shared string to an intent.
 * Never throws — malformed input resolves to `{ kind: "unknown" }`.
 */
export function interpretClipboardOrQr(
  value: string | null | undefined,
): QrInterpretation {
  if (typeof value !== "string") return { kind: "unknown" };
  const raw = value.trim();
  if (!raw || raw.length > MAX_QR_VALUE_CHARS) return { kind: "unknown" };

  // 1) Moosewave deep link (moosewave://campaign/<id>, …).
  const deepRef = parseDeepLink(raw);
  if (deepRef) {
    const href = mobilePath(deepRef.entity, deepRef.id);
    if (href) return { kind: "entity", href };
  }

  // 2) Moosewave universal/app link (https://app.moosewave.com/app/<slug>/<id>).
  const uniRef = parseUniversalLink(raw);
  if (uniRef) {
    const href = mobilePath(uniRef.entity, uniRef.id);
    if (href) return { kind: "entity", href };
  }

  // 3) CLI device-authorization approval link (from `login --device`).
  const userCode = parseDeviceApproveLink(raw);
  if (userCode) return { kind: "deviceApprove", userCode };

  // 4) Email — either a `mailto:` URI or a bare address.
  const email = extractEmail(raw);
  if (email) return { kind: "email", email };

  // 5) Any other http(s) URL.
  if (isHttpUrl(raw)) return { kind: "url", url: raw };

  // 6) Give up — the scanner surfaces a "Not a Moosewave code" hint.
  return { kind: "unknown" };
}

/** Returns a normalised email from a `mailto:` URI or a bare address. */
function extractEmail(raw: string): string | null {
  let candidate = raw;
  if (/^mailto:/i.test(raw)) {
    // Strip scheme + any ?subject=… query and decode percent-encoding.
    candidate = raw.slice("mailto:".length).split(/[?#]/, 1)[0] ?? "";
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Leave as-is; the regex below will reject anything malformed.
    }
  }
  candidate = candidate.trim();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

/** True only for well-formed http(s) URLs. */
function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
