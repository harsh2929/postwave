// SPDX-License-Identifier: AGPL-3.0-only
//
// The design library's tabs and exactly what each one queries. Kept out of
// the client browser module so the server page can seed the Inspiration view
// with the same scope the client later compares against (a value imported
// from a "use client" module is only a reference on the server).

export const LIBRARY_VIEW_IDS = ["inspiration", "mine", "favorites"] as const;
export type LibraryView = (typeof LIBRARY_VIEW_IDS)[number];

export const TEMPLATE_KIND_FILTERS = ["all", "editable", "reference"] as const;
export type TemplateKindFilter = (typeof TEMPLATE_KIND_FILTERS)[number];

export interface LibraryViewScope {
  /** Ownership axis sent as `source` (platform / mine / all). */
  source: string;
  /** Governance axis sent as `kind`; "all" sends no filter. */
  kind: TemplateKindFilter;
  favorited: boolean;
  /** Goal the view opens on; "" is every goal. */
  goal: string;
}

/**
 * What each tab shows. Ownership (`source`) and governance (`kind`) are
 * separate axes: the built-in starters are platform-owned *editable*
 * templates, so scoping Inspiration by kind=reference hid every one of them
 * (TMPL-A). Inspiration is the platform catalog — starters you can use
 * directly plus any curated references — matching the desktop client.
 * My templates are yours whatever their kind, so a reference you imported
 * stays reachable. Personal views open on every goal: a template you saved as
 * a welcome email must not vanish behind a newsletter filter.
 */
export const LIBRARY_VIEW_SCOPES: Readonly<Record<LibraryView, LibraryViewScope>> = {
  inspiration: {
    source: "platform",
    kind: "all",
    favorited: false,
    goal: "newsletter",
  },
  mine: { source: "mine", kind: "all", favorited: false, goal: "" },
  favorites: { source: "all", kind: "all", favorited: true, goal: "" },
};

/** Ownership values of the `source` parameter; anything else is a provider. */
export const OWNERSHIP_SOURCES: ReadonlySet<string> = new Set([
  "platform",
  "mine",
  "team",
  "all",
]);
