/**
 * lib/notificationLink.ts — deciding what a notification tap should DO.
 *
 * `routeForEntityLink` used to resolve ONLY the four entities in
 * packages/route-map/src/entities.ts (approval, subscriber, campaign,
 * sequence). A notification pointing at settings, billing, a form, a list or a
 * migration therefore produced a completely dead tap — and because the row was
 * marked read first, the user lost the item AND got nothing.
 *
 * It now also falls back to the mobile DESTINATION grammar (lib/navDeepLinks),
 * so `moosewave://dmarc` and `https://app.moosewave.com/app/audit` resolve
 * in-app. This module is still load-bearing: an entity mobile does not ship a
 * screen for, and any link with an id under a non-entity slug, still resolve to
 * nothing, and the honest answer to those is what follows.
 *
 * This module turns that silent nothing into an explicit plan the screen can
 * act on. It deliberately does NOT invent a web URL from a `moosewave://` link:
 * mapping `moosewave://<action>/<id>` to `/app/<action>s/<id>` is right for
 * "list"/"tag" and wrong for anything with an irregular plural, and sending a
 * user to a 404 is worse than telling them the truth.
 */

/** The universal-link host apps/web serves the AASA claim from. */
const WEB_HOST = "app.moosewave.com";

export type NotificationLinkPlan =
  /** Resolvable in-app; the caller navigates with routeForEntityLink. */
  | { kind: "in-app" }
  /** Not resolvable in-app, but the link itself is a usable web URL. */
  | { kind: "web"; url: string }
  /** Nothing actionable — tell the user rather than doing nothing. */
  | { kind: "unsupported" }
  /** The notification carries no link at all; a tap is legitimately inert. */
  | { kind: "none" };

/**
 * A safe https URL to hand to `Linking.openURL`, or null.
 *
 * Restricted to the Moosewave web host on purpose: a `deep_link` is
 * server-authored today, but treating it as an arbitrary "open this URL"
 * instruction would make any future write path into an open-redirect.
 */
export function webFallbackUrl(link: string | undefined): string | null {
  if (!link) return null;
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== WEB_HOST) return null;
  return parsed.toString();
}

/**
 * What to do with a tapped notification.
 *
 * `resolvesInApp` is supplied by the caller (it needs the router-aware
 * `routeForEntityLink`), keeping this module free of react-native imports.
 */
export function planNotificationTap(
  link: string | undefined,
  resolvesInApp: boolean,
): NotificationLinkPlan {
  if (!link) return { kind: "none" };
  if (resolvesInApp) return { kind: "in-app" };
  const url = webFallbackUrl(link);
  return url ? { kind: "web", url } : { kind: "unsupported" };
}
