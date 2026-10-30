/**
 * @postwave/route-map — the single source of truth for how a Moosewave
 * entity maps to a screen on every surface and to the shared `moosewave://`
 * deep-link + `https://app.moosewave.com` universal-link schemes.
 *
 * Lets web emit shareable / "open in app" links, mobile route the entity
 * scheme it used to drop, and the desktop grammar stay in sync — turning
 * latent deep-link plumbing into real cross-device continuity.
 */

export {
  type EntityDef,
  type EntityKey,
  type RouteSurface,
  type SurfaceSupport,
  ENTITIES,
  ENTITY_KEYS,
  getEntity,
  entityForSlug,
  isEntityResourceId,
  isSafeResourceId,
} from "./entities.js";

export {
  type EntityRef,
  type DeviceApproveRef,
  DEEP_LINK_SCHEME,
  UNIVERSAL_HOST,
  CLI_DEVICE_APPROVE_PATH,
  webPath,
  desktopPath,
  mobilePath,
  buildDeepLink,
  buildUniversalLink,
  buildDeviceApproveLink,
  parseDeepLink,
  parseUniversalLink,
  parseDeviceApproveLink,
} from "./links.js";

export {
  type SearchHitType,
  type SearchHitDestination,
  SEARCH_HIT_TYPES,
  isSearchHitType,
  searchHitEntity,
  searchHitDestination,
} from "./search.js";
