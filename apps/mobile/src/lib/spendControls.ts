/**
 * lib/spendControls.ts — the "stop the money" policy.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Mobile could already SEE that a workspace was about to blow through its plan:
 * `billingNormalize.ts` renders a `sends_projection`, and the billing screen
 * shows usage against the cap. It had no way to DO anything about it. The
 * ceiling lives behind `PUT /api/v1/billing/overage`, which only the web admin
 * ever called — so the phone could watch the meter run and not turn it off.
 *
 * Same family: the phone SENDS billable SMS (`useSmsReply`) while
 * `GET /api/v1/sms/credits/balance` was web-only. A surface that can spend
 * credits should be able to read the balance.
 *
 * ── THE FOUR-STATE PROBLEM ─────────────────────────────────────────────────
 * The server returns TWO booleans that are easy to conflate:
 *   overageEnabled           — the tenant's preference
 *   overageBillingConfigured — whether Stripe metered billing is actually wired
 *   overageChargeable        — both of the above (the server ANDs them)
 *
 * The handler comment says the third exists precisely so a UI can distinguish
 * "off" from "on but not yet charged". Collapsing them would produce the two
 * worst possible lies in opposite directions: telling a self-host operator they
 * are being billed when no billing is wired, or telling a Stripe tenant that
 * overage is free because a flag reads false.
 *
 * ── CAP ZERO IS NOT CAP ABSENT ─────────────────────────────────────────────
 * `overageCap` is `*int` in Go with `omitempty`, so absent means "no ceiling"
 * and 0 means "allow no overage at all". These are opposite instructions and a
 * nullish-coalescing default would silently turn the strictest setting into the
 * loosest. Every function here treats them separately.
 *
 * No react-native imports — imported by node-run vitest.
 */
import { num } from "./format";

/** The `sendingAddon` block of `GET /api/v1/billing/state`. */
export interface SendingAddonLike {
  monthlyCap: number;
  used: number;
  daysRemaining: number;
  overageEnabled: boolean;
  overageUnits: number;
  /** Absent means no ceiling. Zero means no overage at all. Not the same. */
  overageCap?: number | undefined;
  overageChargeable: boolean;
  overageBillingConfigured: boolean;
}

export type OverageState =
  | "off"
  | "on_not_billed"
  | "on_billing"
  | "capped_out";

/**
 * Which of the four situations the workspace is actually in.
 *
 * `capped_out` outranks the others because it is the only one that changes what
 * happens next: the ceiling has been reached, so further sends beyond the plan
 * are refused rather than billed. An operator reading "overage is on" while
 * sends are being dropped has been told the opposite of what matters.
 */
export function overageState(addon: SendingAddonLike): OverageState {
  if (!addon.overageEnabled) return "off";
  if (addon.overageCap !== undefined && addon.overageUnits >= addon.overageCap) {
    return "capped_out";
  }
  return addon.overageChargeable ? "on_billing" : "on_not_billed";
}

/** True when this period has already gone past the plan's included sends. */
export function isOverPlan(addon: SendingAddonLike): boolean {
  return addon.overageUnits > 0;
}

/**
 * How much headroom is left before the ceiling stops sends, or null when there
 * is no ceiling.
 *
 * Returns 0 rather than a negative number: "you are 300 past a cap that already
 * stopped you" is not a quantity anyone can act on, and a negative remaining
 * count reads as a bug.
 */
export function overageHeadroom(addon: SendingAddonLike): number | null {
  if (addon.overageCap === undefined) return null;
  return Math.max(0, addon.overageCap - addon.overageUnits);
}

/**
 * The plain sentence shown above the controls.
 *
 * It always names the state AND the consequence, because the two questions an
 * operator has at this moment are "is money being spent?" and "what happens to
 * the next send?" — and a status word alone answers neither.
 */
export function spendSummary(addon: SendingAddonLike): string {
  const state = overageState(addon);
  const past = addon.overageUnits;
  if (!isOverPlan(addon)) {
    const left = Math.max(0, addon.monthlyCap - addon.used);
    const within =
      state === "off"
        ? "Overage is off, so sends stop at the plan cap."
        : "Overage is on, so sends continue past the cap.";
    return `${num(left)} of ${num(addon.monthlyCap)} plan sends left. ${within}`;
  }
  switch (state) {
    case "capped_out":
      return `${num(past)} sends past the plan cap — your ceiling of ${num(addon.overageCap ?? 0)} is reached, so further sends are refused.`;
    case "on_billing":
      return `${num(past)} sends past the plan cap, and they are being billed as overage.`;
    case "on_not_billed":
      // The honest version of "on". Saying "being billed" here would invent a
      // charge that cannot happen, because no metered billing is wired.
      return `${num(past)} sends past the plan cap. Overage is on but metered billing isn't configured, so nothing is being charged.`;
    default:
      return `${num(past)} sends past the plan cap, and overage is off — further sends are refused.`;
  }
}

/** Tone for the status pill. Anything spending or refusing money is not "ok". */
export function spendTone(
  addon: SendingAddonLike,
): "success" | "warning" | "neutral" {
  const state = overageState(addon);
  if (state === "capped_out") return "warning";
  if (state === "on_billing" && isOverPlan(addon)) return "warning";
  return isOverPlan(addon) ? "warning" : "success";
}

export const OVERAGE_CAP_MAX = 2_147_483_647;

export type CapValidation =
  | { ok: true; cap: number | undefined }
  | { ok: false; message: string };

/**
 * Validate a typed ceiling before it is sent.
 *
 * The server answers 400 `bad_overage_cap` outside 0..MaxInt32; checking here
 * turns a round-trip and a generic failure toast into an inline sentence that
 * says which value is wrong. An EMPTY field is a legitimate instruction — "no
 * ceiling" — and must not be read as zero.
 */
export function validateOverageCap(raw: string): CapValidation {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, cap: undefined };
  if (!/^\d+$/u.test(trimmed)) {
    return { ok: false, message: "Enter a whole number of sends, or leave it blank for no ceiling." };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > OVERAGE_CAP_MAX) {
    return { ok: false, message: `The ceiling can't be above ${num(OVERAGE_CAP_MAX)}.` };
  }
  return { ok: true, cap: value };
}

/**
 * The confirmation shown before turning overage ON.
 *
 * Enabling overage is the one control here that can COST money, so it is the
 * one that asks. Turning it off cannot cost anything and is never gated — an
 * operator stopping spend should never meet a dialog.
 */
export function overageEnableConsequence(
  addon: SendingAddonLike,
  cap: number | undefined,
): string {
  const billed = addon.overageBillingConfigured
    ? "Sends past your plan cap will be billed as overage."
    : "Metered billing isn't configured for this workspace, so nothing will be charged yet — but this preference will apply the moment it is.";
  const ceiling =
    cap === undefined
      ? "You have set no ceiling, so there is no upper bound on billable sends."
      : cap === 0
        ? "Your ceiling is 0, so no sends past the plan cap will be allowed at all."
        : `Your ceiling is ${num(cap)} extra sends.`;
  return `${billed} ${ceiling}`;
}

// ---------------------------------------------------------------------------
// SMS credits
// ---------------------------------------------------------------------------

export interface SmsCreditBalanceLike {
  plan: string;
  included_credits: number;
  purchased_credits: number;
  used_credits: number;
  available_credits: number;
  period_start: string;
  period_end: string;
  ledger_mode: string;
  warnings?: string[] | undefined;
}

/**
 * The one number that decides whether the next SMS send can happen, as a
 * sentence.
 *
 * `ledger_mode` is surfaced when it is not the normal accounting mode: a
 * balance computed in a fallback mode is not the same claim as a metered one,
 * and a caller about to spend on the strength of it should know.
 */
export function smsCreditSummary(balance: SmsCreditBalanceLike): string {
  const available = Number.isFinite(balance.available_credits)
    ? balance.available_credits
    : 0;
  const base = `${num(available)} SMS credits available (${num(balance.used_credits)} used of ${num(
    balance.included_credits + balance.purchased_credits
  )}).`;
  const mode =
    balance.ledger_mode && balance.ledger_mode !== "metered"
      ? ` Ledger mode: ${balance.ledger_mode}.`
      : "";
  return `${base}${mode}`;
}

/** True when the balance is low enough that the next send is at risk. */
export function smsCreditsAreLow(
  balance: SmsCreditBalanceLike,
  threshold = 100,
): boolean {
  return balance.available_credits <= threshold;
}

/**
 * Server-supplied warnings, joined for display.
 *
 * Rendered verbatim rather than re-worded: these are the server's own account
 * of why a balance may not be spendable, and paraphrasing them on one client
 * would put three surfaces out of step on a money question.
 */
export function smsCreditWarnings(
  balance: SmsCreditBalanceLike,
): string | null {
  const warnings = (balance.warnings ?? []).filter((w) => w && w.trim());
  return warnings.length > 0 ? warnings.join(" ") : null;
}
