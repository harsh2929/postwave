/**
 * Canonical entity → route registry. The single source of truth for how a
 * Moosewave entity maps to a screen on every surface and to the shared
 * `moosewave://` deep-link + `https://app.moosewave.com` universal-link
 * schemes.
 *
 * Before this package each surface hand-rolled its own mapping: the desktop
 * Tauri parser (src-tauri/src/deep_link.rs) routed approval|subscriber|
 * campaign, mobile ignored the entity scheme entirely, and web emitted no
 * deep links at all. Deriving all of them from this registry makes
 * open-on-one-continue-on-another (and a web "copy link" / "open in app")
 * actually work — and keeps the desktop Rust grammar, mobile router, and
 * web link emitter from drifting apart.
 */

/**
 * How much of an entity a given surface can actually show.
 *
 *   "detail" — the surface can ADDRESS one record: `<base>/<slug>/<id>`
 *              resolves rather than failing, and the id survives into the
 *              screen's state. (Whether that screen visually focuses the record
 *              is a UI concern, not a routing one. Desktop's router accepts and
 *              preserves a trailing resource segment for every known section —
 *              see `desktop-router.ts parseRoutePath` — so a known section is
 *              always addressable there.)
 *   "list"   — only the collection route exists; an id-addressed URL would 404,
 *              so a record link lands on the collection.
 *   "none"   — the surface does not ship this entity at all; emit no link.
 *
 * This replaces a single `mobileDetail` boolean, which silently encoded two
 * false assumptions: that web always has a detail screen, and that every
 * surface has the entity at all. Neither holds. `apps/web` ships
 * `app/(dashboard)/app/approvals/page.tsx` with NO `[id]` segment and no
 * catch-all or middleware rewrite, so the registry minted `/app/approvals/<id>`
 * — a hard Next.js 404 — for the dashboard resume card
 * (`lib/activity-cursor.ts`), the activity feed (`lib/dashboard-activity.ts`),
 * "copy link" (`lib/entity-share-link.ts`) and mobile's continue-on-web handoff.
 * Symmetrically, mobile ships no Affiliates tab, so a mobile affiliate link
 * would have pointed at a screen that does not exist.
 *
 * A link that lands on the list is recoverable. A 404 is not, and a link to a
 * surface that never had the feature is worse than no link — which is why
 * "none" makes the path builders return `null` rather than guess.
 *
 * Every value here is verified against the real filesystem (and against
 * desktop's `SECTION_SLUGS`) by `scripts/check-route-map-destinations.mjs`, so
 * a flag cannot drift from the screens that actually exist.
 */
export type SurfaceSupport = "detail" | "list" | "none";

/** The surfaces that render entity routes from this registry. */
export type RouteSurface = "web" | "desktop" | "mobile";

export interface EntityDef {
  /** Canonical singular key, also the `moosewave://<action>/…` action. */
  key: string;
  /** Plural URL slug used in app routes and universal links. */
  slug: string;
  /** Optional identity grammar stricter than the shared opaque path segment. */
  idPolicy?: "uuid";
  /**
   * Per-surface support. Desktop renders the same `/app/<slug>/…` shape as web
   * but owns a DIFFERENT section vocabulary (`desktop-router.ts SECTION_SLUGS`)
   * — it has no `flows`, `landing-pages`, `inbound-webhooks` or
   * `sequence-templates` section — so it needs its own axis rather than
   * inheriting web's.
   */
  surfaces: Record<RouteSurface, SurfaceSupport>;
}

/**
 * The registry. `key` doubles as the deep-link action and MUST match the
 * desktop parser's action grammar (apps/desktop/src-tauri/src/deep_link.rs).
 */
export const ENTITIES = {
  // mobile is "detail" since apps/mobile/app/(tabs)/approvals/[id].tsx shipped.
  // It was "list" when this registry was written and mobile had only a queue,
  // and the stale flag was doing real damage: `moosewave://approval/<id>` — the
  // link a desktop "approve on your phone" notification, a QR handoff and a
  // shared URL all mint — resolved to `/(tabs)/approvals`, dropping the
  // approver on a list they then had to search for the request they had just
  // been told about. The detail screen re-fetches GET /api/v1/approvals/{id}
  // with staleTime 0 precisely because it is the screen you decide from.
  //
  // web is "detail" as of app/(dashboard)/app/approvals/[id]/page.tsx. That
  // route was MISSING while this registry addressed approvals by id, so
  // /app/approvals/<id> — the path the resume card, activity feed, share link
  // and mobile's continue-on-web handoff all produced — was a Next.js 404.
  approval: {
    key: "approval",
    slug: "approvals",
    surfaces: { web: "detail", desktop: "detail", mobile: "detail" },
  },
  subscriber: {
    key: "subscriber",
    slug: "subscribers",
    surfaces: { web: "detail", desktop: "detail", mobile: "detail" },
  },
  campaign: {
    key: "campaign",
    slug: "campaigns",
    surfaces: { web: "detail", desktop: "detail", mobile: "detail" },
  },
  sequence: {
    key: "sequence",
    slug: "sequences",
    surfaces: { web: "detail", desktop: "detail", mobile: "detail" },
  },

  // --- expansion: the next tier of first-class resources -------------------
  // Every value below was read off the filesystem, not assumed. Web detail is
  // `app/(dashboard)/app/<slug>/[<param>]/page.tsx` (the param NAME varies —
  // [id], [jobId], [code] — which does not affect the emitted path); mobile
  // detail is `app/(tabs)/<slug>/[id].tsx`; desktop support is membership in
  // `desktop-router.ts SECTION_SLUGS`.

  form: {
    key: "form",
    slug: "forms",
    surfaces: { web: "detail", desktop: "detail", mobile: "detail" },
  },
  // Mobile ships lists/[id].tsx and segments/[id].tsx. Web now ships its own
  // lists/[id] workspace; segments remain nested under subscribers (see
  // WEB_NESTED_ROUTE_ACK below).
  list: {
    key: "list",
    slug: "lists",
    surfaces: { web: "detail", desktop: "detail", mobile: "detail" },
  },
  segment: {
    key: "segment",
    slug: "segments",
    surfaces: { web: "none", desktop: "detail", mobile: "detail" },
  },
  // Reachable from `/api/v1/search` (internal/search/index.go collects a
  // "suppression" type), which is why it belongs here: without an entry the
  // shared search resolver has nowhere to send the hit, and every client was
  // left to invent its own destination.
  //
  // Verified on the filesystem: web app/(dashboard)/app/suppressions/page.tsx
  // is a collection with no [id] segment; desktop carries `suppressions` in
  // SECTION_SLUGS; mobile ships app/(tabs)/suppressions/[email].tsx, so it is
  // the one surface that addresses a single suppression — by email, which is
  // the record's identity here.
  suppression: {
    key: "suppression",
    slug: "suppressions",
    surfaces: { web: "list", desktop: "detail", mobile: "detail" },
  },
  // Helpdesk detail routes address a service-suite CONVERSATION UUID. They do
  // not address the separate helpdesk-ticket resource. Keeping one canonical
  // semantic here prevents a real ticket UUID from being sent to the
  // conversation endpoint merely because both resources once shared a slug.
  "helpdesk-conversation": {
    key: "helpdesk-conversation",
    slug: "helpdesk",
    surfaces: { web: "none", desktop: "detail", mobile: "detail" },
    idPolicy: "uuid",
  },
  template: {
    key: "template",
    slug: "templates",
    surfaces: { web: "detail", desktop: "detail", mobile: "list" },
  },
  // Web's dynamic segment is [jobId]; the emitted path is identical.
  migration: {
    key: "migration",
    slug: "migrations",
    surfaces: { web: "detail", desktop: "detail", mobile: "list" },
  },
  // Web's [id] segment is the opaque historical discount-record UUID returned
  // by the sanitized archive. It is never a redeemable discount code.
  discount: {
    key: "discount",
    slug: "discounts",
    surfaces: { web: "detail", desktop: "detail", mobile: "list" },
    idPolicy: "uuid",
  },
  integration: {
    key: "integration",
    slug: "integrations",
    surfaces: { web: "list", desktop: "detail", mobile: "list" },
  },
  // Desktop's automation section is `automations`, NOT `flows`, so a
  // `/app/flows/…` path would hit desktop's unknown-destination branch. Marked
  // "none" rather than silently pointing at a section with a different slug.
  flow: {
    key: "flow",
    slug: "flows",
    surfaces: { web: "detail", desktop: "none", mobile: "list" },
  },
  // Desktop has `webhooks`, which is the OUTBOUND webhook section — a
  // different resource, not a slug variant of this one.
  "inbound-webhook": {
    key: "inbound-webhook",
    slug: "inbound-webhooks",
    surfaces: { web: "detail", desktop: "none", mobile: "list" },
  },
  "landing-page": {
    key: "landing-page",
    slug: "landing-pages",
    surfaces: { web: "detail", desktop: "none", mobile: "list" },
  },
  // No mobile Affiliates tab exists; mobile links resolve to null rather than
  // to a screen the app does not have.
  affiliate: {
    key: "affiliate",
    slug: "affiliates",
    surfaces: { web: "detail", desktop: "detail", mobile: "none" },
  },
  // Web-only today. Registered anyway so "copy link", search results and the
  // activity feed address it canonically instead of hand-building a path.
  "sequence-template": {
    key: "sequence-template",
    slug: "sequence-templates",
    surfaces: { web: "detail", desktop: "none", mobile: "none" },
  },
} as const satisfies Record<string, EntityDef>;

/**
 * Entities web ships under a NESTED path this registry cannot address.
 *
 * Every path builder here assumes one slug and the shape `<base>/<slug>/<id>`.
 * Web does not always agree: segments live at
 * `/app/subscribers/segments/<id>`, not `/app/segments/<id>`. So `surfaces.web`
 * is honestly `"none"` — the registry has no way to emit the real URL and must
 * not emit a wrong one — but that is a limitation of the MODEL, not an absence
 * of the feature, and the two must not be confused.
 *
 * Listing them makes the distinction explicit and checkable:
 * `scripts/check-route-map-destinations.mjs` searches for a nested
 * `<slug>/[param]/page.tsx` and fails when a nested route exists without an
 * entry here (a silently unlinked feature) or when an entry here no longer
 * matches a nested route (a stale excuse for a link that could now be emitted).
 *
 * Removing an entry is the right move the day the registry grows per-surface
 * path overrides, or web flattens the route.
 */
export const WEB_NESTED_ROUTE_ACK: readonly string[] = [
  // apps/web/src/app/(dashboard)/app/subscribers/segments/[id]/page.tsx
  "segment",
];

export type EntityKey = keyof typeof ENTITIES;

export const ENTITY_KEYS = Object.keys(ENTITIES) as EntityKey[];

export function getEntity(key: string): EntityDef | undefined {
  if (!Object.hasOwn(ENTITIES, key)) return undefined;
  return ENTITIES[key as EntityKey];
}

/** Resolve a plural slug (e.g. "campaigns") back to its entity def. */
export function entityForSlug(slug: string): EntityDef | undefined {
  return Object.values(ENTITIES).find((e) => e.slug === slug);
}

/**
 * Resource-id allowlist — mirrors desktop's `is_safe_resource_id`. Ids are
 * URL path segments, so we forbid anything that could smuggle a second
 * path segment, scheme, or traversal (`/`, `..`, whitespace, `%`).
 */
export function isSafeResourceId(id: unknown): id is string {
  // Accepts `unknown` and narrows, rather than trusting the `string` type.
  // Every caller here is validating something that came from OUTSIDE the type
  // system — a URL segment, a share-sheet payload, a server response, a
  // rehydrated cache — so the annotation was a promise the callers could not
  // keep. When it was `(id: string)`, a non-string reached `id.length` and
  // threw during render, taking down whichever screen called it.
  if (typeof id !== "string") return false;
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id);
}

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validate an id against both the shared path rule and the entity's grammar. */
export function isEntityResourceId(entity: string, id: unknown): id is string {
  const def = getEntity(entity);
  if (!def || !isSafeResourceId(id)) return false;
  return def.idPolicy === "uuid" ? CANONICAL_UUID_RE.test(id) : true;
}
