// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure helper backing the cross-device "Copy link" / "Open in app" control
// (components/copy-entity-link.tsx). Kept in its own module — free of JSX —
// so it can be unit-tested under the node-only vitest environment.
//
// The path shape is derived from the shared @postwave/route-map registry
// (the single source of truth for entity → route mapping). The origin comes
// from the active deployment instead of being fixed to the production host.

import { webPath } from "@postwave/route-map";

const PRODUCTION_APP_ORIGIN = "https://app.moosewave.com";

function validAppOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The shareable *universal* link for an entity
 * (https://app.moosewave.com/app/<slug>/<id>), or `null` when route-map
 * rejects the entity/id (unknown action, unsafe id). The universal link
 * doubles as the web URL and resolves natively via the AASA the web app
 * serves.
 */
export function entityShareUrl(
  entity: string,
  id: string,
  deploymentOrigin?: string,
): string | null {
  const path = webPath(entity, id);
  if (!path) return null;
  const origin =
    validAppOrigin(deploymentOrigin) ??
    validAppOrigin(process.env.NEXT_PUBLIC_APP_URL) ??
    PRODUCTION_APP_ORIGIN;
  return `${origin}${path}`;
}
