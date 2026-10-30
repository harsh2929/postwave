/**
 * lib/discountEdit.ts — the two discount edits a phone is allowed to make,
 * and the live redeemability probe that says whether a code actually works.
 *
 * Of the five mounted discount routes exactly one is a mutation:
 * `PATCH /api/v1/discounts/{code}` (apps/api/internal/discounts/handlers.go:46,
 * `RequireScope(ScopeAdmin)`). Its body is a three-state encoding —
 * `{max_redemptions, clear_max_redemptions, expires_at, clear_expires_at}` —
 * because encoding/json cannot tell "absent" from "null" on a `*int`.
 *
 * THE SERVER'S RULES, MIRRORED HERE ON PURPOSE (Repo.Update, repo.go:231):
 *
 *   - a field and its `clear_*` flag together → 400 invalid_input;
 *   - no field at all                         → 400 "nothing to update";
 *   - `max_redemptions` below `times_redeemed` → 400 (it would retroactively
 *     invalidate rows that were already redeemed);
 *   - `expires_at` earlier than the current one → 400 (same reason, for the
 *     window that would be skipped).
 *
 * They are mirrored rather than left to the server because a phone is used
 * standing up: a round trip that comes back "cannot move earlier" after the
 * operator has put the phone away is a failure they will not see. The server
 * remains the authority — this only stops the request that is already known
 * to be rejected.
 *
 * WHAT IS DELIBERATELY NOT OFFERED. Lowering a cap, pulling an expiry
 * forward, and adding an expiry to a code that has none are all things the
 * API would accept (the second only when there was no expiry to begin with).
 * All three END a promotion early, which is a decision to make at a desk with
 * the campaign in front of you — not the thing you reach for a phone to do.
 * Only the additive half is exposed here, which is what makes this safe
 * enough to have no confirmation dialog beyond the sheet itself.
 *
 * Import-free by construction, so every rule above is testable in the node
 * vitest run without React Native.
 */

/** The fields of a discount row these rules read. */
export interface DiscountEditRow {
  code: string;
  max_redemptions?: number | null | undefined;
  times_redeemed?: number | null | undefined;
  expires_at?: string | null | undefined;
}

/** Offered extensions, in days. */
export const EXPIRY_EXTENSION_DAYS = [7, 30, 90] as const;
export type ExpiryExtensionDays = (typeof EXPIRY_EXTENSION_DAYS)[number];

export type ExpiryIntent =
  | { kind: "keep" }
  | { kind: "extend"; days: number }
  | { kind: "clear" };

export type CapIntent =
  | { kind: "keep" }
  | { kind: "raise"; value: number }
  | { kind: "clear" };

export interface DiscountEditIntent {
  expiry: ExpiryIntent;
  cap: CapIntent;
}

export const NO_EDIT_INTENT: DiscountEditIntent = {
  expiry: { kind: "keep" },
  cap: { kind: "keep" },
};

/** The PATCH body. Keys are omitted, never sent as null. */
export interface DiscountPatch {
  max_redemptions?: number;
  clear_max_redemptions?: boolean;
  expires_at?: string;
  clear_expires_at?: boolean;
}

export type DiscountPatchResult =
  | { ok: true; patch: DiscountPatch; summary: string }
  | { ok: false; reason: string };

const DAY_MS = 86_400_000;

function finiteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

/** `times_redeemed` can arrive as null from an older gateway payload. */
export function timesRedeemed(row: DiscountEditRow): number {
  return finiteInt(row.times_redeemed) ?? 0;
}

/** The current cap, or null when the code is uncapped. */
export function currentCap(row: DiscountEditRow): number | null {
  return row.max_redemptions === null || row.max_redemptions === undefined
    ? null
    : finiteInt(row.max_redemptions);
}

/** The current expiry as epoch ms, or null when there is none / it is junk. */
export function currentExpiry(row: DiscountEditRow): number | null {
  if (!row.expires_at) return null;
  const ms = new Date(row.expires_at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The expiry an extension would produce, as an ISO string.
 *
 * The base is `max(existing expiry, now)`, not the existing expiry alone.
 * Extending an ALREADY-EXPIRED code by seven days from its old date lands on
 * a date that is still in the past: the request succeeds, the operator is
 * told the code was extended, and it is still dead. Anchoring to now when the
 * code has already lapsed is what makes "extend" mean what it says.
 */
export function extendedExpiryISO(
  row: DiscountEditRow,
  days: number,
  now: number,
): string | null {
  const existing = currentExpiry(row);
  if (existing === null) return null;
  const span = Math.trunc(days);
  if (!Number.isFinite(span) || span <= 0) return null;
  const base = Math.max(existing, now);
  return new Date(base + span * DAY_MS).toISOString();
}

/**
 * Turn an operator's intent into a PATCH body, or into the reason it will not
 * be sent. `now` is injected so the expiry branch is testable without
 * freezing the clock.
 */
export function buildDiscountPatch(
  row: DiscountEditRow,
  intent: DiscountEditIntent,
  now: number = Date.now(),
): DiscountPatchResult {
  const patch: DiscountPatch = {};
  const parts: string[] = [];

  const cap = currentCap(row);
  const used = timesRedeemed(row);
  switch (intent.cap.kind) {
    case "keep":
      break;
    case "clear":
      if (cap === null) {
        return { ok: false, reason: "This code already has no redemption limit." };
      }
      patch.clear_max_redemptions = true;
      parts.push("removed the redemption limit");
      break;
    case "raise": {
      const next = finiteInt(intent.cap.value);
      if (next === null || next <= 0) {
        return { ok: false, reason: "Enter a redemption limit as a whole number." };
      }
      if (next < used) {
        // The server's own rule, stated in the operator's terms.
        return {
          ok: false,
          reason: `This code has already been redeemed ${used} times, so the limit can't go below ${used}.`,
        };
      }
      if (cap !== null && next <= cap) {
        return {
          ok: false,
          reason: `The limit is already ${cap}. Enter a higher number to extend the promotion.`,
        };
      }
      patch.max_redemptions = next;
      parts.push(`raised the limit to ${next}`);
      break;
    }
  }

  const expiry = currentExpiry(row);
  switch (intent.expiry.kind) {
    case "keep":
      break;
    case "clear":
      if (expiry === null) {
        return { ok: false, reason: "This code already has no expiry." };
      }
      patch.clear_expires_at = true;
      parts.push("removed the expiry");
      break;
    case "extend": {
      if (expiry === null) {
        return { ok: false, reason: "This code has no expiry to extend." };
      }
      const iso = extendedExpiryISO(row, intent.expiry.days, now);
      if (!iso) {
        return { ok: false, reason: "Pick how far to extend the expiry." };
      }
      patch.expires_at = iso;
      parts.push(
        `extended the expiry by ${Math.trunc(intent.expiry.days)} days`,
      );
      break;
    }
  }

  if (parts.length === 0) {
    return { ok: false, reason: "Nothing to change yet." };
  }
  return {
    ok: true,
    patch,
    // Sentence-cased at the join so the toast reads as one statement rather
    // than two fragments.
    summary: `${row.code}: ${parts.join(" and ")}.`,
  };
}

// ---------------------------------------------------------------------------
// Redeemability probe — GET /api/v1/discounts/{code}/check
// ---------------------------------------------------------------------------

/**
 * `RedeemResult` as the handler returns it (handlers.go:83). `reason` is
 * empty when the code is good; the populated values come from
 * `CheckRedeemable` and are exactly "expired" / "max_redemptions_reached" /
 * "unknown_code".
 */
export interface DiscountCheck {
  code?: string;
  valid?: boolean;
  currently_redeemable?: boolean;
  reason?: string;
}

export type RedeemabilityTone = "success" | "warning" | "danger";

export interface RedeemabilitySummary {
  tone: RedeemabilityTone;
  /** Short line for the row. Never colour-alone: the words carry the state. */
  headline: string;
  /** The spoken/expanded form, safe to use as an accessibilityLabel. */
  detail: string;
}

export function parseDiscountCheck(value: unknown): DiscountCheck {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: DiscountCheck = {};
  if (typeof raw.code === "string") out.code = raw.code;
  if (typeof raw.valid === "boolean") out.valid = raw.valid;
  if (typeof raw.currently_redeemable === "boolean") {
    out.currently_redeemable = raw.currently_redeemable;
  }
  if (typeof raw.reason === "string") out.reason = raw.reason;
  return out;
}

export function redeemabilitySummary(
  check: DiscountCheck,
): RedeemabilitySummary {
  if (check.currently_redeemable === true) {
    return {
      tone: "success",
      headline: "Redeemable right now",
      detail:
        "The server checked this code just now and a customer could redeem it.",
    };
  }
  switch (check.reason) {
    case "expired":
      return {
        tone: "danger",
        headline: "Not redeemable — expired",
        detail:
          "The server checked this code just now and refused it: the expiry has passed.",
      };
    case "max_redemptions_reached":
      return {
        tone: "warning",
        headline: "Not redeemable — limit reached",
        detail:
          "The server checked this code just now and refused it: every redemption has been used.",
      };
    case "unknown_code":
      return {
        tone: "danger",
        headline: "Not redeemable — unknown code",
        detail: "The server does not recognise this code.",
      };
    default:
      return {
        tone: "warning",
        headline: "Not redeemable",
        detail:
          "The server checked this code just now and refused it, without giving a reason.",
      };
  }
}

/**
 * Does the LIVE probe disagree with the status this screen computed from the
 * list payload?
 *
 * This is the whole point of calling `/check`. The list row carries
 * `expires_at` and `max_redemptions`; the probe re-reads the row inside the
 * tenant transaction and applies the same rule the redeem path applies. They
 * diverge whenever the list is stale — an offline snapshot, a code redeemed
 * to its cap by someone else while the screen sat open, an expiry that
 * lapsed since the fetch — and the divergence is precisely the answer to the
 * support question "why is the customer saying it doesn't work?".
 *
 * Returns null when they agree, or when there is nothing to compare.
 */
export function redeemabilityDisagreement(
  localLabel: "active" | "exhausted" | "expired",
  check: DiscountCheck | undefined,
): string | null {
  if (!check || check.currently_redeemable === undefined) return null;
  const localSaysUsable = localLabel === "active";
  if (localSaysUsable === check.currently_redeemable) return null;
  return localSaysUsable
    ? "This list still shows the code as active, but the server refuses it — the list is out of date."
    : "This list shows the code as unusable, but the server accepts it — the list is out of date.";
}
