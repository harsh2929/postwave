/**
 * discountStatus — the pure half of the Discounts screen.
 *
 * These four rules used to live inside `app/(tabs)/discounts.tsx`, which
 * imports react-native and so cannot be loaded by the node vitest
 * environment. That meant the one part of the screen with real branching —
 * is this code expired, exhausted or live — was untestable by construction,
 * for the same reason `approvalPolicy`, `chartScale` and `feedbackPolicy`
 * were extracted before it.
 *
 * DELIBERATELY IMPORT-FREE except `lib/typeScale`, which is itself
 * import-free. The row shapes are declared structurally rather than imported
 * from `hooks/useDiscountOps`, because that module pulls in the SDK client and
 * would drag react-native back in through the type graph's runtime edge.
 *
 * ORDER MATTERS IN `statusOf`. Expiry is checked BEFORE exhaustion: a code
 * that both expired and hit its cap is "expired", because that is the fact
 * the operator can act on (extend the date) and "exhausted" would send them
 * to raise a redemption limit that would change nothing.
 */

import { typeCap } from "@/lib/typeScale";

export type DiscountStatusLabel = "active" | "exhausted" | "expired";

/** Mirrors `PillTone` without importing it — Pill.tsx imports react-native. */
export type DiscountStatusTone = "success" | "warning" | "danger";

export interface DiscountStatus {
  label: DiscountStatusLabel;
  tone: DiscountStatusTone;
}

/** The fields of a discount row this module actually reads. */
export interface DiscountLike {
  expires_at?: string | null;
  max_redemptions?: number | null;
  times_redeemed?: number | null;
}

/** The fields of a redemption row this module actually reads. */
export interface RedemptionLike {
  subscriber_id?: string | undefined;
  subscriber_email?: string | undefined;
  /**
   * The archive timeline's linkage bit. It says WHETHER the event was tied to
   * a subscriber and never to whom, so it is the only identity claim available
   * from the mounted route.
   */
  subscriber_linked?: boolean | undefined;
}

/**
 * `times_redeemed` is typed `number`, but an older gateway payload can still
 * put a null there, and `null >= 5` is `false` while `null >= 0` is `true` —
 * so an unguarded comparison silently mislabels a zero-cap code.
 */
export function redeemedCount(d: DiscountLike): number {
  const n = d.times_redeemed;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * `now` is injected so the expiry branch is testable without freezing the
 * clock; the screen never passes it.
 */
export function statusOf(d: DiscountLike, now: number = Date.now()): DiscountStatus {
  if (d.expires_at) {
    const exp = new Date(d.expires_at).getTime();
    if (Number.isFinite(exp) && exp < now) {
      return { label: "expired", tone: "danger" };
    }
  }
  if (
    d.max_redemptions !== null &&
    d.max_redemptions !== undefined &&
    redeemedCount(d) >= d.max_redemptions
  ) {
    return { label: "exhausted", tone: "warning" };
  }
  return { label: "active", tone: "success" };
}

/**
 * Mirror the desktop's human-readable applies-to labels. Falls back to the
 * raw value (underscores → spaces) for any unrecognised mode, so a mode this
 * client has not been taught yet still reads as words rather than vanishing.
 */
export function appliesLabel(value: string | undefined): string {
  switch (value) {
    case "first_payment":
      return "First payment";
    case "recurring":
      return "Recurring";
    case "both":
      return "First + recurring";
    default:
      return value ? value.replace(/_/g, " ") : "";
  }
}

/**
 * Who redeemed, said only as far as the payload actually knows.
 *
 * "Anonymous checkout" USED to be the catch-all for a row with no email and no
 * ID, which was true while the API returned both. The mounted archive timeline
 * returns neither — it returns `subscriber_linked` — so the old fallback would
 * now assert "anonymous" over every event on the screen, including the ones the
 * server explicitly says WERE tied to a subscriber. That is not a missing
 * detail, it is a false one, so linkage is answered before the fallback and the
 * withheld identity is named as withheld.
 */
export function redemptionActor(row: RedemptionLike): string {
  if (row.subscriber_email) return row.subscriber_email;
  if (row.subscriber_id) return row.subscriber_id;
  if (row.subscriber_linked === true) return "Linked subscriber (not named)";
  // `false` and absent collapse deliberately: both mean nothing ties this
  // event to a subscriber, which is what "anonymous" says.
  return "Anonymous checkout";
}

/** Width of the Share affordance at the OS default text size. */
export const SHARE_SLOT_BASE = 48;

/**
 * Width reserved for the Share affordance, DERIVED from the `control` role's
 * ceiling rather than left a literal.
 *
 * The affordance is absolutely positioned over the card, and the card's own
 * `paddingRight` is what keeps the code from sliding underneath it. Both were
 * literals (48 / 64), which are correct at exactly one text size: raise the OS
 * setting and "Share" outgrows its 48pt box while the padding reserving space
 * for it does not move — so the label clips AND the code runs under it. One
 * function now feeds both numbers, so they cannot disagree.
 *
 * Non-numeric / non-finite input means "assume the default size", the same
 * first-frame fail-safe `maxLinesAtScale` uses.
 */
export function shareSlotWidth(fontScale: unknown): number {
  const raw =
    typeof fontScale === "number" && Number.isFinite(fontScale) && fontScale > 1
      ? fontScale
      : 1;
  const effective = Math.min(raw, typeCap("control").maxFontSizeMultiplier);
  return Math.round(SHARE_SLOT_BASE * effective);
}
