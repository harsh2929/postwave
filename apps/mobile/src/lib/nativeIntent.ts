/**
 * Rewrite operating-system URLs before Expo Router evaluates their pathname.
 *
 * The app also listens to Linking so it can defer authenticated destinations
 * until sign-in. That listener cannot stop Expo Router from interpreting the
 * same system URL first. For aliases such as `moosewave://sms-suppressions`,
 * Router sees `/sms-suppressions` while Moosewave correctly resolves the real
 * route as `/sms/suppressions`; whichever navigation wins the race determines
 * whether the user sees the screen or +not-found.
 *
 * `app/+native-intent.tsx` calls this pure adapter at the Router boundary. It
 * deliberately uses the same parsers as the lifecycle listener, so both
 * navigation paths now agree.
 *
 * UNKNOWN LINKS PASS THROUGH AS A BARE PATH. The pathname survives, so a
 * mistyped link still lands on the product's reportable not-found screen —
 * but its query string does not. Every recognised link family above
 * validates the parameters it forwards (an auth nonce, a device-approve code,
 * a bounded `q`); an unrecognised link has no such validation, and the 2026-09
 * security review recorded that this pass-through made every file-system
 * route AND every screen's query parameters externally addressable over the
 * claimable `moosewave://` scheme. Each existing parameter was checked and none
 * performed a write without a tap, but nothing kept the next one harmless.
 * Dropping the query for unrecognised links is what does.
 */
import type { Href } from "expo-router";

import {
  routeForAuthLink,
  routeForDeviceApproveLink,
  routeForEntityLink,
} from "./deepLinks";
import { routeForNavLink } from "./navDeepLinks";

type HrefObject = {
  pathname: string;
  params?: Record<string, unknown>;
};

function hrefObject(value: unknown): HrefObject | null {
  if (!value || typeof value !== "object") return null;
  const pathname = (value as { pathname?: unknown }).pathname;
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  const params = (value as { params?: unknown }).params;
  return {
    pathname,
    ...(params && typeof params === "object"
      ? { params: params as Record<string, unknown> }
      : {}),
  };
}

/** Serialize the constrained Href shapes returned by the deep-link grammar. */
export function nativePathForHref(href: Href): string | null {
  if (typeof href === "string") return href.startsWith("/") ? href : null;
  const target = hrefObject(href);
  if (!target) return null;

  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(target.params ?? {})) {
    if (typeof raw === "string" || typeof raw === "number") {
      query.set(key, String(raw));
    }
  }
  const suffix = query.toString();
  return suffix ? `${target.pathname}?${suffix}` : target.pathname;
}

export function rewriteNativeSystemPath(path: string): string {
  try {
    const target =
      routeForAuthLink(path) ??
      routeForDeviceApproveLink(path) ??
      routeForEntityLink(path);
    if (target) return nativePathForHref(target) ?? bareSystemPath(path);
    // A nav link (`moosewave://subscribers?q=…`) reaches this adapter as the
    // bare path `/subscribers?q=…`, which the nav grammar cannot parse as a
    // URL. Re-pose it in its scheme form so that grammar — and its BOUNDED
    // `q` — decides, instead of the pass-through below deciding for it.
    const asNav = routeForNavLink(`moosewave://${path.replace(/^\/+/u, "")}`);
    if (asNav) return asNav;
    return bareSystemPath(path);
  } catch {
    // The OS may hand Expo an arbitrary string. Never make app launch depend
    // on a third-party or stale URL being well formed.
    return path;
  }
}

/**
 * The pathname alone. `path` arrives as the URL's path plus search, so this
 * cuts at the first `?` or `#`; a link with neither is returned unchanged.
 */
export function bareSystemPath(path: string): string {
  const cut = path.search(/[?#]/u);
  return cut === -1 ? path : path.slice(0, cut);
}
