/**
 * The words the kill switch says, kept out of the screen so they can be
 * asserted without rendering anything.
 *
 * WHY THIS ACTION GETS THE HEAVY TREATMENT. `ConfirmSheet`'s own header sets
 * the rule: if an action is REVERSIBLE, skip the confirm and give an undo;
 * reserve the typed `confirmPhrase` for irreversible, high-blast-radius
 * actions. Deleting a discount is both halves of that. The server removes the
 * Moosewave row AND calls `bridge.DeleteCoupon`, so the Stripe coupon goes with
 * it (apps/api/internal/discounts/repo.go:381-391); nothing on this screen can
 * recreate either. The phrase is the code itself, which is also the only
 * identifier a leaked-code panic hands the operator — so typing it is a real
 * check that they are killing the code they meant, not a speed bump.
 *
 * THE CONSEQUENCE LINE NAMES THE REDEMPTIONS, not the code. "This cannot be
 * undone" is true of every destructive confirm in the app and therefore
 * carries no information. What is specific here is that the code has already
 * been used N times and that those redemptions are what the operator is
 * choosing to stop — and that the history stays readable is worth saying,
 * because "delete" reasonably reads as "and the receipts go too".
 */

/** Options for `ConfirmSheet`, minus the fields the call site owns. */
export interface DiscountDeleteConfirmCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmPhrase: string;
  destructive: true;
}

export function discountDeleteConfirmCopy(input: {
  code: string;
  /** Lifetime redemptions from the catalogue row. */
  used: number;
}): DiscountDeleteConfirmCopy {
  const code = input.code.trim();
  const used = Number.isFinite(input.used) ? Math.max(0, Math.trunc(input.used)) : 0;
  return {
    title: `Delete ${code}?`,
    message:
      "Nobody will be able to redeem this code again, including anyone who already has it. The coupon is removed from Stripe too, and neither can be restored from this app.",
    consequence:
      used === 0
        ? "This code has never been redeemed."
        : used === 1
          ? "It has been redeemed once. That redemption stays in your history."
          : `It has been redeemed ${used} times. Those redemptions stay in your history.`,
    confirmLabel: "Delete code",
    cancelLabel: "Keep it",
    // Exact, case-sensitive (lib/feedbackPolicy `confirmPhraseSatisfied`).
    // Codes are upper-cased by the server, so this is what the operator is
    // already looking at on the row above.
    confirmPhrase: code,
    destructive: true,
  };
}

/** What the toast says once the server has confirmed the delete. */
export function discountDeletedMessage(code: string): string {
  return `${code.trim()} deleted. It can no longer be redeemed.`;
}

/**
 * The accessibility label on the affordance itself.
 *
 * Spoken labels on this screen state the OUTCOME rather than the control
 * ("Export every redemption of X as a spreadsheet", not "Export"), because a
 * screen-reader user meets the button with none of the surrounding layout to
 * disambiguate it. "Delete" alone next to "Extend" is one swipe away from a
 * destructive misfire.
 */
export function discountDeleteActionLabel(code: string): string {
  return `Delete ${code.trim()} so it can no longer be redeemed`;
}
