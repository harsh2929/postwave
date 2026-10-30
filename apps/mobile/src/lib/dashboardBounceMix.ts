/**
 * lib/dashboardBounceMix.ts — what the dashboard may say about WHY mail
 * bounced, as opposed to how much of it did.
 *
 * The dashboard already carries a "Bounce rate" tile. One percentage is the
 * least actionable form the fact can take: 4.1% hard-bounced is list hygiene,
 * 4.1% blocked is a reputation problem with one provider, and 4.1% soft is
 * usually nothing at all. Desktop splits the mix on its Analytics health
 * panels; the phone showed the collapsed number and nothing else.
 *
 * THE SOURCE. `GET /api/v1/deliverability/hub/bounce-class-breakdown` is
 * WORKSPACE-scoped (apps/api/internal/deliverability_hub/handlers.go:41) and
 * `session_minimum_role: "viewer"` on the routeauth manifest — the same floor
 * as the dashboard itself. This matters because the finding was previously
 * deferred on the belief that the only hard/soft/block source was the
 * CAMPAIGN-scoped `/campaigns/{id}/bounces`, which would have meant an
 * N-campaign fan-out from a phone. It would not: mobile already reads this
 * exact endpoint on the Deliverability hub (hooks/useDeliverabilityDiagnostics
 * → useBounceClasses), and this module reuses that hook and that parse rather
 * than adding a second vocabulary for the same wire shape.
 *
 * WHAT IT IS ALLOWED TO RENDER, and why each branch exists:
 *  - OFFLINE → nothing. The screen already carries one honest offline notice;
 *    a second "this side signal is also offline" line is noise.
 *  - READ FAILED → an unavailable line, never a silent absence. Absence would
 *    read as "no bounces", which is the good news the failure cannot support.
 *  - NOT LOADED YET → nothing. No skeleton: a self-gating side panel that
 *    flashes a placeholder and then vanishes is worse than one that arrives.
 *  - ZERO BOUNCES → nothing. The dashboard's own convention (see the anomaly
 *    card): an "all clear" panel every day trains the reader to skip the
 *    region on the day it matters.
 *
 * Pure and import-free of react-native, so every branch above is unit-tested
 * in the node environment.
 */
import type { BounceClassBreakdown } from "@/lib/deliverabilityDiagnostics";
import { num, percent } from "@/lib/format";
import { msg, pluralMsg } from "@/lib/i18n";

/** How many classes the dashboard shows before deferring to the hub. */
export const BOUNCE_MIX_ROWS = 3;

export interface BounceMixRow {
  code: string;
  /** Server-supplied human label ("Hard bounce"), never invented here. */
  label: string;
  count: string;
  share: string;
}

export type BounceMixState =
  | { kind: "hidden" }
  | { kind: "unavailable"; body: string; spoken: string }
  | {
      kind: "mix";
      heading: string;
      total: string;
      rows: BounceMixRow[];
      spoken: string;
    };

export interface BounceMixInput {
  breakdown: BounceClassBreakdown | undefined;
  /** The query errored. Distinct from "has not answered yet". */
  errored: boolean;
  /** The online gate is closed. */
  offline: boolean;
}

const HIDDEN: BounceMixState = { kind: "hidden" };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isReadable(
  breakdown: BounceClassBreakdown | undefined,
): breakdown is BounceClassBreakdown {
  return (
    Boolean(breakdown) &&
    finite(breakdown?.totalBounces) &&
    finite(breakdown?.windowDays) &&
    Array.isArray(breakdown?.classes)
  );
}

function isReadableRow(row: unknown): row is BounceMixSource {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Partial<BounceMixSource>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.label === "string" &&
    finite(candidate.count) &&
    candidate.count > 0
  );
}

type BounceMixSource = BounceClassBreakdown["classes"][number];

export function bounceMixState({
  breakdown,
  errored,
  offline,
}: BounceMixInput): BounceMixState {
  if (offline) return HIDDEN;
  if (errored) {
    const body = msg("dashboard.bounceMix.unavailable");
    return { kind: "unavailable", body, spoken: body };
  }
  // TOTAL, NOT TRUSTING. `parseBounceClasses` guarantees this shape on the
  // real wire path, but the same state is reachable from a cached payload
  // written by an older build — and a self-gating side panel that THROWS
  // takes the whole dashboard down with it. Anything that is not a readable
  // breakdown renders as nothing, which is the same answer as "no bounces".
  if (!isReadable(breakdown)) return HIDDEN;
  if (breakdown.totalBounces <= 0) return HIDDEN;

  const rows = breakdown.classes
    .filter(isReadableRow)
    .slice(0, BOUNCE_MIX_ROWS)
    .map((row) => ({
      code: row.code,
      label: row.label,
      count: num(row.count),
      share: percent(row.share),
    }));
  // Every class row came back at zero against a non-zero total: the total is
  // real but unattributed, so there is no mix to show.
  if (rows.length === 0) return HIDDEN;

  const heading = pluralMsg(
    "dashboard.bounceMix.heading",
    breakdown.windowDays,
  );
  const total = pluralMsg(
    "dashboard.bounceMix.total",
    breakdown.totalBounces,
  );
  // A LIST is assembled in code; a SENTENCE is not. Each row is its own whole
  // frame and the frames are joined, so a translator owns the phrase and the
  // enumeration order stays with the data.
  const spokenRows = rows
    .map((row) =>
      msg("dashboard.bounceMix.a11y.row", {
        label: row.label,
        count: row.count,
        share: row.share,
      }),
    )
    .join(" ");
  const spoken = msg("dashboard.bounceMix.a11y", {
    heading,
    total,
    rows: spokenRows,
  });

  return { kind: "mix", heading, total, rows, spoken };
}
