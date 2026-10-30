/**
 * api/spendControls.ts — read the meter, and stop it.
 *
 * Three endpoints that were never reachable from this platform:
 *   GET /api/v1/billing/state          (read:reports) — includes sendingAddon
 *   PUT /api/v1/billing/overage        (admin)        — the preference + ceiling
 *   GET /api/v1/sms/credits/balance    (read:reports) — the SMS wallet
 *
 * The first two were WEB-ONLY; the third was web-only while this app has been
 * sending billable SMS through `useSmsReply` the whole time.
 *
 * NORMALISED, NOT TRUSTED. `billingNormalize.ts` exists because a payload
 * missing `resources` used to crash the billing screen and a missing `percent`
 * rendered a bar of literal width "NaN%". The same discipline applies to money:
 * a missing `overageCap` here means "no ceiling" and must not arrive as 0,
 * because that is the opposite instruction.
 */
import { rawRequest, type AIApiError } from "./request";

import type {
  SendingAddonLike,
  SmsCreditBalanceLike,
} from "@/lib/spendControls";

class SpendControlError extends Error {
  readonly status: number;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "SpendControlError";
    this.status = error.status;
  }
}

export const SMS_FINANCIAL_LEDGER_RELEASE_HELD_CODE =
  "sms_financial_ledger_release_held" as const;

export class SmsFinancialLedgerReleaseHeldError extends Error {
  readonly code = SMS_FINANCIAL_LEDGER_RELEASE_HELD_CODE;
  readonly status = 503;

  constructor() {
    super(
      "The authoritative SMS balance, usage, quote, checkout, and entitlement ledger is release-held.",
    );
    this.name = "SmsFinancialLedgerReleaseHeldError";
  }
}

function int(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * `overageCap` is `*int` with `omitempty` on the wire, so it arrives as absent,
 * null, or a number. Only a real number becomes a ceiling — absent and null
 * both mean "no ceiling", and collapsing either into 0 would turn the loosest
 * setting into the strictest one.
 */
export function normalizeSendingAddon(raw: unknown): SendingAddonLike | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const cap = r.overageCap;
  return {
    monthlyCap: int(r.monthlyCap),
    used: int(r.used),
    daysRemaining: int(r.daysRemaining),
    overageEnabled: r.overageEnabled === true,
    overageUnits: int(r.overageUnits),
    ...(typeof cap === "number" && Number.isFinite(cap)
      ? { overageCap: cap }
      : {}),
    overageChargeable: r.overageChargeable === true,
    overageBillingConfigured: r.overageBillingConfigured === true,
  };
}

/**
 * The sending add-on block, or null when this workspace has none.
 *
 * Null is a real answer — `sendingAddon` is a pointer server-side — and must
 * stay distinguishable from a failed request, which throws.
 */
export async function fetchSendingAddon(): Promise<SendingAddonLike | null> {
  const res = await rawRequest<unknown>("GET", "/api/v1/billing/state");
  if (res.error)
    throw new SpendControlError(res.error, "Couldn't load your billing state.");
  const data = res.data as { sendingAddon?: unknown } | null;
  return normalizeSendingAddon(data?.sendingAddon ?? null);
}

/**
 * Set the overage preference and its ceiling.
 *
 * `overageCap` is sent as an explicit null when there is no ceiling. Omitting
 * the key would leave the server's `*int` nil — which happens to mean the same
 * thing here — but sending it explicitly makes "clear the ceiling" a stated
 * instruction rather than an inference from absence, and the handler's UPSERT
 * writes exactly what it is given.
 */
export async function setOverage(
  enabled: boolean,
  cap: number | undefined,
): Promise<SendingAddonLike | null> {
  const res = await rawRequest<unknown>("PUT", "/api/v1/billing/overage", {
    overageEnabled: enabled,
    overageCap: cap ?? null,
  });
  if (res.error) {
    throw new SpendControlError(
      res.error,
      "Couldn't change your overage setting.",
    );
  }
  const data = res.data as { sendingAddon?: unknown } | null;
  return normalizeSendingAddon(data?.sendingAddon ?? null);
}

export function normalizeSmsCreditBalance(
  raw: unknown,
): SmsCreditBalanceLike | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    plan: typeof r.plan === "string" ? r.plan : "",
    included_credits: int(r.included_credits),
    purchased_credits: int(r.purchased_credits),
    used_credits: int(r.used_credits),
    available_credits: int(r.available_credits),
    period_start: typeof r.period_start === "string" ? r.period_start : "",
    period_end: typeof r.period_end === "string" ? r.period_end : "",
    ledger_mode: typeof r.ledger_mode === "string" ? r.ledger_mode : "",
    ...(Array.isArray(r.warnings)
      ? {
          warnings: r.warnings.filter(
            (w): w is string => typeof w === "string",
          ),
        }
      : {}),
  };
}

/** Stable local hold: no authoritative SMS wallet exists in this release. */
export async function fetchSmsCreditBalance(): Promise<SmsCreditBalanceLike | null> {
  throw new SmsFinancialLedgerReleaseHeldError();
}
