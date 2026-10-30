/**
 * webHandoff — the "finish this on the web" link for an entity screen.
 *
 * Mobile is deliberately read-mostly: app/(tabs)/campaigns/index.tsx says in its own
 * header comment that full composition stays on the web. So the moment a user
 * needs to EDIT is frequent and predictable — and until now there was no way
 * out of a detail screen except to remember the URL.
 *
 * Two decisions worth stating, because the naive version of this is worse than
 * nothing:
 *
 *  - THE HOST IS CONFIGURED, NOT HARDCODED. `buildUniversalLink` in
 *    @postwave/route-map always emits `https://app.moosewave.com`, which is
 *    wrong on every self-hosted deployment. The origin here comes from
 *    PUBLIC_APP_BASE_URL (EXPO_PUBLIC_APP_URL), the same value the rest of the
 *    app uses for legal/archive links, so a self-hosted build hands off to its
 *    own dashboard.
 *  - COPY LEADS, OPEN FOLLOWS. The in-app browser does not carry the app's
 *    session (mobile authenticates with headers out of SecureStore, not with
 *    the dashboard's cookies), so "Open" can legitimately land on the web
 *    sign-in. Copying the link — to paste where the user is already signed in
 *    — is the action that always works, so it is the primary one and the
 *    secondary is labelled honestly.
 *
 * Import-free (the base URL is a parameter, not an import) so the URL
 * construction is unit-tested without pulling in expo config.
 */
import { webPath } from "@postwave/route-map";

/**
 * The dashboard URL for one entity, or null when the entity/id pair is not
 * routable (unknown entity, or an id that fails route-map's `isSafeResourceId`
 * — which is what stops a hostile id from being pasted into a URL).
 */
export function webHandoffUrl(
  appBaseUrl: string,
  entity: string,
  id: string | null | undefined,
): string | null {
  const trimmedId = (id ?? "").trim();
  if (!trimmedId) return null;
  const path = webPath(entity, trimmedId);
  if (!path) return null;
  const origin = appBaseUrl.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(origin)) return null;
  return `${origin}${path}`;
}

/**
 * The sentence under the two actions. It names the fact that the link may ask
 * for a sign-in rather than letting the user discover it after a tap.
 */
export const WEB_HANDOFF_NOTE =
  "The link opens this record in the Moosewave dashboard. You may need to sign in there.";
