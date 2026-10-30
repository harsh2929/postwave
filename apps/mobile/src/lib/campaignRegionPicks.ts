/**
 * lib/campaignRegionPicks.ts — resolve any branch combination locally.
 *
 * Preview-as answers "what does THIS subscriber get?"; it cannot answer
 * "what does the false branch of `is_vip` look like?" when no current
 * subscriber happens to hit it. Desktop's DynamicContentPanel solves that with
 * client-side substitution over the region byte offsets; this is the pure
 * mobile port of its `applyPicks` + `buildByteToUtf16Map`.
 *
 * THE BYTE-OFFSET TRAP IS REAL (desktop GAP-3#5): `Region.Start/End` are Go
 * UTF-8 BYTE offsets into the saved body, while JS slices count UTF-16 code
 * units — one 'é' before a region shifts every offset. The map converts.
 *
 * Substitution only ever runs against the SAVED body (the mobile detail
 * screen has no local body editing, so there is no diverged-draft case), and
 * only over TOP-LEVEL regions — children live inside a parent's range and are
 * carried along with whichever branch of the parent is picked, exactly as on
 * desktop.
 */

export type RegionBranchPick = "true" | "false" | "default";

export interface PickableRegion {
  key: string;
  start: number;
  end: number;
  trueBranch: string;
  falseBranch: string;
  hasElse: boolean;
}

/** Top-level regions with usable offsets, from the /regions response. */
export function pickableRegions(
  response: { regions?: unknown } | null | undefined,
): PickableRegion[] {
  const raw = Array.isArray(response?.regions) ? response.regions : [];
  const out: PickableRegion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    const start = row.start;
    const end = row.end;
    if (
      !key ||
      seen.has(key) ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      start < 0 ||
      end <= start
    ) {
      continue;
    }
    seen.add(key);
    out.push({
      key,
      start,
      end,
      trueBranch: typeof row.true_branch === "string" ? row.true_branch : "",
      falseBranch:
        typeof row.false_branch === "string" ? row.false_branch : "",
      hasElse: row.has_else === true,
    });
  }
  return out;
}

/** UTF-8 byte offset → UTF-16 index map (desktop buildByteToUtf16Map). */
function buildByteToUtf16Map(body: string): number[] {
  const enc = new TextEncoder();
  const map: number[] = [];
  let bytePos = 0;
  let jsPos = 0;
  while (jsPos < body.length) {
    const cp = body.codePointAt(jsPos);
    if (cp === undefined) break;
    const unit = String.fromCodePoint(cp);
    const nbytes = enc.encode(unit).length;
    for (let b = 0; b < nbytes; b++) map[bytePos + b] = jsPos;
    bytePos += nbytes;
    jsPos += unit.length;
  }
  map[bytePos] = jsPos;
  return map;
}

/**
 * The saved body with each region collapsed to its picked branch.
 * "default" leaves the region's raw markup in place (the flattened view);
 * "false" with no else branch collapses to nothing — the recipient for whom
 * the condition is false receives nothing there.
 */
export function applyRegionPicks(
  body: string,
  regions: readonly PickableRegion[],
  picks: Readonly<Record<string, RegionBranchPick>>,
): string {
  const byteToJs = buildByteToUtf16Map(body);
  const toJs = (byteOffset: number): number =>
    byteToJs[byteOffset] ?? body.length;
  const ordered = [...regions].sort((a, b) => b.start - a.start);
  let out = body;
  for (const region of ordered) {
    const pick = picks[region.key] ?? "default";
    if (pick === "default") continue;
    const startJs = toJs(region.start);
    const endJs = toJs(region.end);
    if (startJs >= endJs || endJs > out.length) continue;
    const replacement =
      pick === "true"
        ? region.trueBranch
        : region.hasElse
          ? region.falseBranch
          : "";
    out = out.slice(0, startJs) + replacement + out.slice(endJs);
  }
  return out;
}
