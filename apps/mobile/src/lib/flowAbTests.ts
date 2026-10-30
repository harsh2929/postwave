/**
 * lib/flowAbTests.ts — the in-flow A/B test wire shapes, parsed, plus the one
 * judgement this surface is allowed to make.
 *
 * Import-free by construction (no react-native, no expo, no netinfo) so the
 * node vitest environment can drive it with real payloads — the same rule
 * lib/flowWire.ts and lib/approvalPolicy.ts follow.
 *
 * EVERY SHAPE BELOW WAS READ OFF THE GO SOURCE, not off openapi.json:
 *
 *   apps/api/internal/flowabtests/flowabtests.go
 *     MountRoutes    :319-327  the seven routes; three of them are reads
 *     Variant        :37-42    {id,label?,percentage?,next?}
 *     ABTest         :45-54    {id,automation_id?,node_id,status,variants,
 *                               winner?,created_at,updated_at}
 *     VariantResult  :57-62    {variant_id,assigned,converted,conversion_rate}
 *     WinnerVerdict  :227-236  what an `evaluate` wrote into `winner`
 *     List           :340      → {"items": [...]}
 *     Results        :441      → {"results": [...]}
 *     evaluateWinner :243      the server's own significance rule
 *
 * THREE SERVER FACTS THAT SHAPE THIS MODULE
 *
 *  1. `conversion_rate` IS A 0..1 FRACTION. `Repo.Results` computes
 *     `float64(converted) / float64(assigned)` (flowabtests.go:190). A variant
 *     converting at half a percent renders as 50% if anything treats it as a
 *     percentage — the exact bug components/abtest/ResultsCard.tsx carries a
 *     comment about for the campaign A/B endpoint.
 *
 *  2. A RESULTS ROW ONLY EXISTS ONCE THE ENGINE HAS BUCKETED SOMEBODY. The
 *     counters are written by the automation runtime
 *     (services/automation/internal/runtime/postgres_store.go:466) on
 *     assignment, so a configured variant that nobody has entered has NO row —
 *     not a row of zeroes. Joining config to results must therefore produce an
 *     explicit "no assignments recorded" state, never a fabricated 0%
 *     (house rule 8: absence is not zero).
 *
 *  3. `winner` IS A SNAPSHOT, NOT A LIVE VERDICT. It is only written by
 *     `POST /{id}/evaluate`, which also flips the test to `completed`
 *     (`setWinner`, :205). So the stored verdict describes the counters AS OF
 *     `evaluated_at`, and the live results underneath it may have moved. The
 *     screen must date it rather than present it as current truth.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: run its own z-test. The server
 * owns the significance rule (two-proportion z at alpha 0.05 against the
 * CONFIGURED control, both legs required to have data). A second, local
 * implementation would eventually disagree with the recorded verdict on the
 * same screen. Instead `flowAbLeader` reports the observed leader and refuses
 * to name one below a sample floor, in words that never say "winner".
 */

/** flowabtests.go writes 'running' on create and 'completed' on evaluate. */
export const FLOW_AB_STATUSES = ["running", "paused", "completed"] as const;

export type FlowAbStatus = (typeof FLOW_AB_STATUSES)[number];

export interface MobileFlowAbVariant {
  id: string;
  label: string;
  /** Traffic split as authored, 0..100. Null when the server omitted it. */
  percentage: number | null;
}

export interface MobileFlowAbWinner {
  variantID: string;
  conversionRate: number;
  pValue: number;
  significant: boolean;
  inconclusive: boolean;
  method: string;
  evaluatedAt: string | null;
}

export interface MobileFlowAbTest {
  id: string;
  automationID: string;
  nodeID: string;
  /** The raw status string; unknown values pass through rather than coerce. */
  status: string;
  variants: readonly MobileFlowAbVariant[];
  winner: MobileFlowAbWinner | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MobileFlowAbResult {
  variantID: string;
  assigned: number;
  converted: number;
  /** 0..1 FRACTION, exactly as the server computes it. */
  conversionRate: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseFlowAbVariant(value: unknown): MobileFlowAbVariant | null {
  const raw = record(value);
  if (!raw) return null;
  const id = str(raw.id);
  if (!id) return null;
  const percentage =
    typeof raw.percentage === "number" && Number.isFinite(raw.percentage)
      ? raw.percentage
      : null;
  return {
    id,
    // `label` is `omitempty` on the Go struct, so an unlabelled variant is
    // named by its id rather than by a fabricated ordinal — the ids are what
    // the results rows key on, so they are the honest join key to show.
    label: str(raw.label) || id,
    percentage,
  };
}

export function parseFlowAbWinner(value: unknown): MobileFlowAbWinner | null {
  const raw = record(value);
  if (!raw) return null;
  const variantID = str(raw.variant_id);
  // `scan` (flowabtests.go:221) drops an empty `{}`, but a verdict with no
  // variant id is still meaningless — an evaluation over zero results.
  if (!variantID) return null;
  return {
    variantID,
    conversionRate: finite(raw.conversion_rate),
    pValue: finite(raw.p_value),
    significant: raw.significant === true,
    inconclusive: raw.inconclusive === true,
    method: str(raw.method),
    evaluatedAt: nullableStr(raw.evaluated_at),
  };
}

export function parseFlowAbTest(value: unknown): MobileFlowAbTest | null {
  const raw = record(value);
  if (!raw) return null;
  const id = str(raw.id);
  if (!id) return null;
  const variants = Array.isArray(raw.variants)
    ? raw.variants
        .map(parseFlowAbVariant)
        .filter((v): v is MobileFlowAbVariant => v !== null)
    : [];
  return {
    id,
    automationID: str(raw.automation_id),
    nodeID: str(raw.node_id),
    status: str(raw.status),
    variants,
    winner: parseFlowAbWinner(raw.winner),
    createdAt: nullableStr(raw.created_at),
    updatedAt: nullableStr(raw.updated_at),
  };
}

/** `List` answers `{"items": [...]}`; anything else is an empty list. */
export function parseFlowAbTestList(
  value: unknown,
): readonly MobileFlowAbTest[] {
  const raw = record(value);
  const items = raw?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map(parseFlowAbTest)
    .filter((t): t is MobileFlowAbTest => t !== null);
}

export function parseFlowAbResult(value: unknown): MobileFlowAbResult | null {
  const raw = record(value);
  if (!raw) return null;
  const variantID = str(raw.variant_id);
  if (!variantID) return null;
  return {
    variantID,
    assigned: int(raw.assigned),
    converted: int(raw.converted),
    conversionRate: finite(raw.conversion_rate),
  };
}

/** `Results` answers `{"results": [...]}`. */
export function parseFlowAbResults(
  value: unknown,
): readonly MobileFlowAbResult[] {
  const raw = record(value);
  const items = raw?.results;
  if (!Array.isArray(items)) return [];
  return items
    .map(parseFlowAbResult)
    .filter((r): r is MobileFlowAbResult => r !== null);
}
