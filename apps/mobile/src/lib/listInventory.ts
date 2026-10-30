/**
 * lib/listInventory.ts — the lists catalogue's counting rules, and the one
 * honesty invariant that goes with them.
 *
 * THE BUG THIS EXISTS TO PREVENT. The lists screen sums `count` over the rows
 * it holds and prints the result under the label "Subscribers". Those rows are
 * NOT the workspace: `apps/api/internal/lists/lists.go`'s `List` handler
 * proxies Listmonk's `/api/lists` forwarding ONLY `?query=` — `page` and
 * `per_page` are never passed through — so the client receives whatever the
 * upstream DEFAULT page returned and has no way to ask for more. A workspace
 * with 143 lists therefore showed a "Subscribers" figure summed over the first
 * page and presented it as the audience size. Desktop's own stat strip carries
 * a comment warning against exactly this ("the loaded rows array is a
 * server-truncated page and must not be presented as the audience size").
 *
 * THE RULE. A count may be labelled as a workspace fact only when the client
 * can PROVE it holds every row. The proof is the envelope's own `total`
 * (Listmonk wraps as `{data:{results, total, per_page, page}}`); when it is
 * absent the coverage is `unknown` and the strip says "loaded", never
 * "in this workspace". Three states, never two:
 *
 *   complete  — total is known and every row is in hand. Say "workspace".
 *   partial   — total is known and exceeds what we hold. Say "N of M".
 *   unknown   — no total came back. Say "loaded", claim nothing.
 *
 * `unknown` deliberately degrades to the CAUTIOUS wording rather than the
 * confident one, so a gateway that stops echoing `total` makes the UI vaguer
 * instead of making it wrong.
 *
 * DELIBERATELY IMPORT-FREE — no react-native, no ./connectivity — so the
 * invariant above is unit-testable in the node vitest environment, like
 * `approvalPolicy`, `chartScale` and `typeScale`.
 */

/** Only the fields the inventory actually counts. */
export interface ListCountable {
  type?: string | undefined;
  optin?: string | undefined;
  count?: number | undefined;
}

export type ListsCoverage = "complete" | "partial" | "unknown";

export interface ListsInventory {
  /** Lists the client is holding — never presented as a workspace total. */
  loaded: number;
  /** Sum of `count` over the loaded rows. */
  subscribers: number;
  publicLists: number;
  doubleOptin: number;
  /** The envelope's `total`, when the gateway echoed one. */
  serverTotal: number | null;
  coverage: ListsCoverage;
}

/**
 * Read the catalogue envelope's row total. Tolerates the same shape ladder
 * `normalizeLists` walks, because the gateway is a pass-through and older /
 * mocked backends flatten the envelope differently.
 *
 * Returns null for anything that is not a finite, non-negative integer —
 * "unknown", which the caller must treat as "cannot claim completeness".
 */
export function readListCatalogueTotal(res: unknown): number | null {
  if (!res || typeof res !== "object" || Array.isArray(res)) return null;
  const envelope = res as { data?: unknown; total?: unknown };
  const nested =
    envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? (envelope.data as { total?: unknown })
      : undefined;
  return finiteCount(nested?.total) ?? finiteCount(envelope.total);
}

function finiteCount(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * Derived inventory KPIs. `serverTotal` is the envelope's row count when the
 * gateway echoed one; pass null when it did not.
 */
export function computeListsInventory(
  rows: readonly ListCountable[],
  serverTotal: number | null = null,
): ListsInventory {
  let subscribers = 0;
  let publicLists = 0;
  let doubleOptin = 0;
  for (const r of rows) {
    const c = r.count;
    if (typeof c === "number" && Number.isFinite(c)) subscribers += c;
    if ((r.type ?? "private").toLowerCase() === "public") publicLists++;
    if ((r.optin ?? "single").toLowerCase() === "double") doubleOptin++;
  }
  const loaded = rows.length;
  const total = finiteCount(serverTotal);
  return {
    loaded,
    subscribers,
    publicLists,
    doubleOptin,
    serverTotal: total,
    coverage: total == null ? "unknown" : total > loaded ? "partial" : "complete",
  };
}

/**
 * The label for the "how many lists" cell. Only `complete` earns the bare
 * noun; the other two say what the number actually is.
 */
export function listsCountLabel(inv: ListsInventory): string {
  return inv.coverage === "complete" ? "Lists" : "Lists loaded";
}

/**
 * The label for the subscriber-sum cell. This is the one that was actively
 * misleading: a page-1 sum under the word "Subscribers".
 */
export function subscriberSumLabel(inv: ListsInventory): string {
  return inv.coverage === "complete" ? "Subscribers" : "On loaded lists";
}

/**
 * Spoken form for the subscriber sum. Assistive tech gets the caveat in the
 * SAME sentence as the number — a footnote two rows down is not a caveat.
 */
export function subscriberSumSpoken(inv: ListsInventory, exact: string): string {
  if (inv.coverage === "complete") return exact;
  return `${exact} across the ${inv.loaded} lists loaded`;
}

/**
 * The line printed under the strip, or null when there is nothing to
 * disclose. Never paraphrased into a claim: when the total is unknown we say
 * we do not know it.
 */
export function listsCoverageNote(inv: ListsInventory): string | null {
  if (inv.loaded === 0) return null;
  if (inv.coverage === "complete") return null;
  if (inv.coverage === "partial") {
    return `Counts cover the ${inv.loaded} of ${inv.serverTotal ?? inv.loaded} lists this screen has loaded.`;
  }
  return `Counts cover the ${inv.loaded} lists this screen has loaded — the gateway does not report a workspace total.`;
}
