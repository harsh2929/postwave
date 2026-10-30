/**
 * lib/campaignAssuranceGate.ts — what the server's send refusal MEANS, and what
 * the operator can do about it from a phone.
 *
 * ── THE BUG THIS EXISTS TO FIX ─────────────────────────────────────────────
 * `POST /api/v1/campaigns/{id}/queue` refuses a send with five distinct
 * Campaign Assurance codes (apps/api/internal/campaigns/handlers_queue.go:133-157),
 * but three of them share status 409 and a fourth is 422. `campaignErrors.ts`
 * mapped by STATUS, so a send blocked by deterministic assurance findings told
 * the operator:
 *
 *     "This campaign changed since you opened it. Pull to refresh and try again."
 *
 * They pull to refresh, nothing has changed, and they try again. The message sent
 * them to do the one thing that cannot possibly help, and three of the five
 * refusals collapsed into it.
 *
 * ── WHY A REMEDY AND NOT JUST A SENTENCE ───────────────────────────────────
 * A code does not merely deserve different words; it implies a different ACTION,
 * and only some of those actions exist on a phone:
 *
 *   run        POST /assurance-runs. Genuinely reachable, and the interesting
 *              discovery here: the body may be EMPTY. When `send_plan_id` is
 *              omitted the server derives both the content revision and the send
 *              plan itself through `Preparer.PrepareAssuranceSnapshot`
 *              (campaignassuranceapi/handlers.go:242-263), and that Preparer IS
 *              wired in the production composition
 *              (apps/api/campaign_assurance_composition.go:159). So the phone
 *              needs no frozen revision and no desktop editor to re-run.
 *   wait       A run is already in flight. The card polls every 2s while the run
 *              is non-terminal, so the right UI is no button at all — offering
 *              one would offer a no-op.
 *   remediate  Deterministic findings block the send. This one DOES need a
 *              content change, which is desk work. The honest answer names the
 *              findings rather than implying a phone can clear them.
 *   retry      Evidence could not be integrity-verified (503). Transient.
 *
 * Import-free of react-native by construction, so every rule above is unit
 * tested under node.
 */

export type AssuranceRefusalCode =
  | "campaign_assurance_required"
  | "campaign_assurance_pending"
  | "campaign_assurance_stale"
  | "campaign_assurance_blocked"
  | "campaign_assurance_unavailable";

/** What the operator can actually do about a refusal. */
export type AssuranceRemedy = "run" | "wait" | "remediate" | "retry";

export interface AssuranceRefusal {
  code: AssuranceRefusalCode;
  sentence: string;
  remedy: AssuranceRemedy;
}

const REFUSALS: Readonly<Record<AssuranceRefusalCode, AssuranceRefusal>> = {
  campaign_assurance_required: {
    code: "campaign_assurance_required",
    sentence:
      "Campaign Assurance hasn't run for this content yet. Run it, then send.",
    remedy: "run",
  },
  campaign_assurance_pending: {
    code: "campaign_assurance_pending",
    sentence:
      "Campaign Assurance is still running for this content. This card updates itself when it finishes.",
    remedy: "wait",
  },
  campaign_assurance_stale: {
    code: "campaign_assurance_stale",
    sentence:
      "The content changed since Campaign Assurance last ran. Run it again for the current version, then send.",
    remedy: "run",
  },
  campaign_assurance_blocked: {
    code: "campaign_assurance_blocked",
    sentence:
      "Campaign Assurance found problems that block this send. They need a content change, which has to happen where you edit the campaign.",
    remedy: "remediate",
  },
  campaign_assurance_unavailable: {
    code: "campaign_assurance_unavailable",
    sentence:
      "Campaign Assurance evidence couldn't be verified just now, so the send was held rather than guessed. Try again shortly.",
    remedy: "retry",
  },
};

/**
 * The refusal a server error code names, or null when it names none.
 *
 * `Object.hasOwn` rather than a bare index read: the argument is a server-supplied
 * string, and a plain object literal inherits `constructor`, `toString` and
 * friends. `REFUSALS["constructor"] ?? null` returns a FUNCTION — truthy — so a
 * bare lookup would have had the send modal render `undefined` as its reason for
 * any input that happens to name an Object.prototype member.
 */
export function assuranceRefusal(code: string): AssuranceRefusal | null {
  return Object.hasOwn(REFUSALS, code)
    ? REFUSALS[code as AssuranceRefusalCode]
    : null;
}

/**
 * The states the server's cancel UPDATE actually matches.
 *
 * Stated POSITIVELY, mirroring `state IN ('queued', 'running')` at
 * apps/api/internal/campaignassurance/lifecycle.go:383, rather than derived as the
 * complement of the terminal set that `useCampaignAssurance.ts` already keeps. The
 * complement is equal today, but it would silently start offering Cancel the day
 * the server gains a new non-terminal state — and the failure mode of that drift
 * is a button whose only possible outcome is a 409.
 */
export const ASSURANCE_CANCELLABLE_STATES = ["queued", "running"] as const;

/**
 * The suite a phone-initiated run asks for.
 *
 * `fast` and NOT `calibration`, and that is a correctness constraint rather than a
 * preference. The send gate rejects a calibration run outright —
 * apps/api/internal/campaignassurancegate/gate.go:142 answers ErrUnavailable when
 * `run.Profile == ProfileCalibration` — so a calibration run can never clear the
 * send it was started to clear. Offering it would be a button whose only possible
 * outcome is the refusal the operator is trying to escape.
 *
 * Between the two the gate does accept, `fast` is the phone answer: the operator
 * is standing in front of a blocked send and wants the shortest honest path
 * through it.
 */
export const MOBILE_ASSURANCE_RUN_PROFILE = "fast" as const;

/** Profiles the send gate can be satisfied by, for the guard test to pin. */
export const ASSURANCE_GATE_SATISFIABLE_PROFILES = ["fast", "full"] as const;

/** True when the server's cancel UPDATE would match a run in this state. */
export function assuranceRunIsCancellable(state: string | undefined): boolean {
  if (!state) return false;
  return (ASSURANCE_CANCELLABLE_STATES as readonly string[]).includes(state);
}

/**
 * Which single action the receipt card should offer.
 *
 * Extracted from the card so it can be exhaustively tested under node — the
 * alternative was mocking react-query, the auth store and the theme to assert a
 * button's presence, which tests the mock more than the rule.
 *
 * There is at most ONE action, deliberately. A card showing both "cancel this run"
 * and "run again" invites the operator to start a second run while the first is
 * still holding the lease, and the server would then serialise them in an order
 * nobody chose.
 */
export type AssuranceCardControl = "start" | "cancel" | "rerun" | "none";

export function assuranceCardControl(input: {
  /** False for a viewer/member: both writes are `editor` in the manifest. */
  mayWrite: boolean;
  /** The latest run's state, or undefined when there is no receipt at all. */
  runState: string | undefined;
  /** Whether a receipt was returned; a 404 read yields none. */
  hasReceipt: boolean;
}): AssuranceCardControl {
  if (!input.mayWrite) return "none";
  if (!input.hasReceipt) return "start";
  return assuranceRunIsCancellable(input.runState) ? "cancel" : "rerun";
}

/**
 * A one-line summary of the findings that did NOT block the send.
 *
 * The card fetches up to 200 findings and rendered at most three BLOCKING ones,
 * discarding everything else — which is the entire output of the F06-F11 check
 * families (structured markup, Unicode smuggling, semantic email, and the rest).
 * The operator paid for that read and never saw it, and "no blockers" silently read
 * as "nothing to know".
 *
 * Deliberately a COUNT and a few codes rather than a list. A phone reviewing a send
 * needs to know whether anything non-blocking is worth opening the full receipt for;
 * reproducing an advisory list would just be the desktop receipt in a worse place.
 */
export function assuranceAdvisorySummary(
  findings:
    | readonly { code?: string; blocking?: boolean; severity?: string }[]
    | undefined,
  maxCodes = 3,
): string | null {
  const advisories = (findings ?? []).filter(
    (finding) => finding.blocking !== true,
  );
  if (advisories.length === 0) return null;
  const codes = advisories
    .map((finding) => (typeof finding.code === "string" ? finding.code : ""))
    .filter((code) => code !== "")
    .slice(0, maxCodes);
  const noun = advisories.length === 1 ? "advisory" : "advisories";
  if (codes.length === 0) {
    return `${advisories.length} non-blocking ${noun}. They do not hold this send.`;
  }
  const more =
    advisories.length > codes.length
      ? `, +${advisories.length - codes.length} more`
      : "";
  return `${advisories.length} non-blocking ${noun} (${codes.join(", ")}${more}). They do not hold this send.`;
}
