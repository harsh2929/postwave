/**
 * lib/dashboardLayout.ts — which headline tiles the phone shows, and in what
 * order.
 *
 * Two different questions, answered by two different authorities, and keeping
 * them apart is the whole point of this module:
 *
 *  ORDER comes from the SERVER, `GET /api/v1/dashboard/layout`. That row is a
 *  per-user, per-tenant preference shared with the desktop app (handler:
 *  apps/api/internal/analytics/dashboard_layout.go:95). A user who drags
 *  "Bounces" to the front on the desktop should not meet a different fixed
 *  order on the phone. Mobile READS it and never writes it — see the contract
 *  note below for why writing would be destructive.
 *
 *  VISIBILITY is a DEVICE preference. This is not a shortcut: the desktop's own
 *  KPI configuration menu persists to `window.localStorage`, per workspace, per
 *  browser (apps/desktop/src/components/analytics/KpiConfigMenu.tsx:5 — "Lives
 *  entirely in the client today"), so "which cards are visible" has never been
 *  a server fact in this product. It is also the property that most deserves to
 *  differ per device: a 390pt phone has room for four numbers, a 27" display
 *  has room for all of them.
 *
 * THE SERVER CONTRACT, precisely, because it constrains what mobile may do.
 * The stored value is ONE flat `order: string[]` (1..16 keys) shared by two
 * different groups of desktop cards: the four stat keys
 * (`subs`/`opens`/`clicks`/`bounces`) followed by eight SECTION keys
 * (`forecast`, `anomalies`, `goals`, … — see
 * apps/desktop/src/components/dashboard/dashboard-sections.ts:48). The desktop
 * resolver DISCARDS keys it does not know. So if the phone wrote its own tile
 * vocabulary (`sent`, `sequences`) into that list, the desktop would drop them
 * on its next save; and if the phone wrote only the four stat keys, it would
 * erase the desktop's section ordering. Mobile therefore treats the row as
 * read-only, which costs nothing: the only thing mobile wants from it is the
 * order, and the order is exactly what it can read safely.
 *
 * Mobile shows two tiles the desktop grid does not (`Sent` and `Active
 * sequences`). They have no server key, so they keep their default position
 * after the four shared ones rather than being invented into the shared
 * vocabulary.
 *
 * Pure and import-free on purpose: every rule here is testable in a node
 * environment (house rule 6).
 */

/** Every tile the grid can render, in the order used when nothing is saved. */
export const MOBILE_TILE_KEYS = [
  "subscribers",
  "open-rate",
  "click-rate",
  "bounce-rate",
  "sent",
  "sequences",
] as const;

export type MobileTileKey = (typeof MOBILE_TILE_KEYS)[number];

/**
 * The four tiles that exist on BOTH clients, mapped to the desktop's stored
 * key. `sent` and `sequences` are deliberately absent — see the header.
 */
const SERVER_KEY_BY_TILE: Readonly<Partial<Record<MobileTileKey, string>>> = {
  subscribers: "subs",
  "open-rate": "opens",
  "click-rate": "clicks",
  "bounce-rate": "bounces",
};

const TILE_BY_SERVER_KEY: Readonly<Record<string, MobileTileKey>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(SERVER_KEY_BY_TILE).map(([tile, key]) => [
        key,
        tile as MobileTileKey,
      ]),
    ),
  );

/** Human labels, used by the picker and by spoken announcements. */
export const MOBILE_TILE_LABELS: Readonly<Record<MobileTileKey, string>> = {
  subscribers: "Subscribers",
  "open-rate": "Open rate",
  "click-rate": "Click rate",
  "bounce-rate": "Bounce rate",
  sent: "Sent",
  sequences: "Active sequences",
};

export function isMobileTileKey(value: unknown): value is MobileTileKey {
  return (
    typeof value === "string" &&
    (MOBILE_TILE_KEYS as readonly string[]).includes(value)
  );
}

/**
 * Reads the layout envelope, `{ userId, tenantId, order: string[], updatedAt }`.
 *
 * Returns null — not `[]` — when the payload carries no usable order, because
 * "the server did not tell us" and "the server told us to show nothing" are
 * different facts and only the first one may fall back to the default order
 * (house rule 8).
 */
export function parseDashboardLayoutOrder(raw: unknown): string[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const order = (raw as { order?: unknown }).order;
  if (!Array.isArray(order)) return null;
  const out: string[] = [];
  for (const entry of order) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    // Same bounds the server validates on write (SaveLayout: 1..16 entries,
    // each 1..64 chars). A row that predates the check cannot widen them here.
    if (!key || key.length > 64) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out.length > 0 ? out : null;
}

/**
 * The tile order to render: the shared tiles in the saved order first, then
 * every remaining tile in its default position.
 *
 * Unknown saved keys (the desktop's section keys, or a key from a newer build)
 * are skipped rather than rendered, and a tile missing from the saved list is
 * appended rather than dropped — the same two rules the desktop resolver uses
 * (dashboard-sections.ts:64 `resolveGroup`), so neither client can lose a card
 * the other has not heard of.
 */
export function resolveTileOrder(
  saved: readonly string[] | null | undefined,
): MobileTileKey[] {
  const out: MobileTileKey[] = [];
  // The declared type says array-or-null, and the parser upholds it — but this
  // value can also arrive from a REHYDRATED query cache written by an older
  // build, where the shape is whatever that build stored. A grid that throws
  // is a blank dashboard; an unrecognised shape must degrade to the default
  // order instead.
  for (const key of Array.isArray(saved) ? saved : []) {
    const tile = TILE_BY_SERVER_KEY[key];
    if (tile && !out.includes(tile)) out.push(tile);
  }
  for (const tile of MOBILE_TILE_KEYS) {
    if (!out.includes(tile)) out.push(tile);
  }
  return out;
}

/** Serialised form of the hidden set, for the string-valued preference store. */
export function serialiseHiddenTiles(hidden: readonly MobileTileKey[]): string {
  // Sorted so the stored string is stable regardless of toggle order — a
  // preference write that differs only in ordering is a pointless disk write.
  return [...new Set(hidden)].sort().join(",");
}

export function parseHiddenTiles(raw: string | undefined): MobileTileKey[] {
  if (!raw) return [];
  const out: MobileTileKey[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (isMobileTileKey(key) && !out.includes(key)) out.push(key);
  }
  // A stored set that hides everything cannot be honoured (see visibleTiles);
  // normalising it away here means the picker and the grid agree.
  return out.length >= MOBILE_TILE_KEYS.length ? [] : out;
}

/**
 * The tiles actually rendered.
 *
 * AN EMPTY GRID IS NEVER A VALID OUTCOME. A dashboard whose headline row has
 * been configured out of existence is indistinguishable from a broken screen,
 * so if every tile is hidden the hidden set is ignored entirely. The picker
 * enforces the same floor at the point of the tap (`canHideTile`) so the
 * user is told rather than silently overruled.
 */
export function visibleTiles(
  order: readonly MobileTileKey[],
  hidden: readonly MobileTileKey[],
): MobileTileKey[] {
  const visible = order.filter((tile) => !hidden.includes(tile));
  return visible.length > 0 ? visible : [...order];
}

/** False when hiding `tile` would empty the grid. */
export function canHideTile(
  order: readonly MobileTileKey[],
  hidden: readonly MobileTileKey[],
  tile: MobileTileKey,
): boolean {
  if (hidden.includes(tile)) return true; // already hidden: unhiding is free
  return visibleTiles(order, hidden).length > 1;
}

/** Toggle one tile, refusing a toggle that would empty the grid. */
export function toggleHiddenTile(
  order: readonly MobileTileKey[],
  hidden: readonly MobileTileKey[],
  tile: MobileTileKey,
): MobileTileKey[] {
  if (hidden.includes(tile)) return hidden.filter((key) => key !== tile);
  if (!canHideTile(order, hidden, tile)) return [...hidden];
  return [...hidden, tile];
}

/**
 * The label on the grid's configuration control. It NAMES the hidden count
 * rather than reading "Choose metrics" always: a reader who hid two tiles three
 * months ago and has forgotten needs the grid to say it is incomplete, not to
 * look like the workspace stopped reporting them.
 */
export function tilePickerLabel(hiddenCount: number): string {
  if (hiddenCount <= 0) return "Choose metrics";
  return `Choose metrics · ${hiddenCount} hidden`;
}
