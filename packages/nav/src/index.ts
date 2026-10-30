/**
 * @postwave/nav — the single source of truth for Moosewave's primary
 * navigation / information architecture.
 *
 * One typed manifest (NAV_ENTRIES) lists every primary nav entry with its
 * canonical label, icon key, required scope, logical group, and the route
 * per surface (web/desktop/mobile). Clients render from it filtered by
 * surface — `navForSurface(surface)` — instead of hand-rolling three
 * divergent maps, and resolve the one true name via `labelFor(key)`.
 */

export {
  type Surface,
  type Scope,
  type NavGroup,
  type NavEntry,
  type NavKey,
  SURFACES,
  NAV_ENTRIES,
} from "./manifest.js";

export {
  type NavForSurfaceOptions,
  getEntry,
  labelFor,
  shortLabelFor,
  entryExposesSurface,
  surfacesFor,
  navForSurface,
  routeFor,
  entriesInGroup,
} from "./helpers.js";
