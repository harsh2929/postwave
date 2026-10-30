# @postwave/nav

The **single source of truth** for Moosewave's primary navigation and information architecture — one typed manifest describing every primary nav entry, consumed by web, desktop, and mobile.

## Why this exists

The 2026-06-21 ecosystem audit ([docs/ecosystem/](../../docs/ecosystem/)) found **three surfaces hand-roll three divergent nav maps**:

- **web** — `NAV` in `apps/web/src/app/(dashboard)/layout.tsx` (15 entries),
- **desktop** — `WORKSPACE_ITEMS` + `ACCOUNT_ITEMS` in `apps/desktop/src/components/Sidebar.tsx` (50+ grouped entries),
- **mobile** — 5 visible bottom tabs in `apps/mobile/app/(tabs)/_layout.tsx` plus many `href: null` screens.

The maps disagreed on **labels** (web "Overview" vs desktop "Dashboard" vs mobile "Home"; the Subscribers tab labelled "People"), and several **shipped pages were orphaned** — reachable only by typing the URL (web's own Analytics page was missing from web's sidebar). This manifest reconciles them: one `label` per concept, one `iconKey`, one required `scope`, and the `route` per surface (or `null` where a surface deliberately doesn't expose it).

## Usage

```ts
import { navForSurface, labelFor, routeFor, NAV_ENTRIES } from "@postwave/nav";

navForSurface("web");                       // ordered entries web should render
navForSurface("mobile", { scope: "member" }); // member-visible mobile primary nav
labelFor("dashboard");                      // "Dashboard"  (kills Overview/Home drift)
routeFor("analytics", "web");               // "/app/analytics"
routeFor("forms", "mobile");                // null — not in mobile primary nav
```

Each client maps over `navForSurface(surface)` instead of its own array. Icons stay per-surface (each toolkit ships its own set) but key off the shared `iconKey`, so the *concept* stays consistent even when the glyph differs.

## Model

Each `NavEntry` carries `{ key, label, shortLabel?, iconKey, scope, group, routes, kbd? }`. `routes` is a `Record<Surface, string | null>`; the set of surfaces that expose an entry is **derived** from its non-null routes (`surfacesFor`), so exposure and routing can never disagree.

## Adoption

- **web** — replace the hand-rolled `NAV` array with `navForSurface("web", { scope })`; add the orphaned Analytics entry (already in the manifest) and a CI check that every shipped `(dashboard)/app/*` route appears here.
- **desktop** — render `WORKSPACE_ITEMS`/`ACCOUNT_ITEMS` from `navForSurface("desktop")` grouped by `group`, keeping the `kbd` shortcuts.
- **mobile** — drive the bottom-tab bar from `navForSurface("mobile")` using `shortLabelFor(key)` for the width-limited labels.
