/**
 * lib/campaignSenderEdit.ts — editing the campaign's SENDING address from a
 * phone.
 *
 * The from address is not a top-level column: the gateway carries it at
 * `delivery_settings.from_email`, and `Repo.Update` treats a non-nil
 * `delivery_settings` as a FULL REPLACE (apps/api/internal/campaigns/
 * authoring_input.go `changesSender` spells the hazard out: a client that
 * sends `{delivery_settings:{from_email:"x"}}` over a map that also held a
 * rate limit erases the rate limit). Desktop preserves the rest of the map on
 * every save (useCampaignEditorController.ts:446-451); this module is the
 * mobile mirror of that contract, kept pure so it is testable in node.
 *
 * WHY THE FROM-ADDRESS SAVE IS ONLINE-ONLY while the other identity fields
 * ride the offline outbox: the replace body has to be built from the freshest
 * `delivery_settings` the client holds. A queued copy replayed hours after a
 * tunnel would overwrite whatever operational knobs (throttles, ab_test
 * bookkeeping) someone changed in the meantime — the exact stale-map data-loss
 * class the subscribers PATCH bug taught us. A typo'd sender found on the go
 * is an immediate, connected fix; it does not need replay semantics.
 */

import type { CampaignFieldsPatch } from "@/lib/campaignFields";

/** Where the saved sending address actually lives. */
export interface CampaignSenderSource {
  delivery_settings?: Record<string, unknown> | undefined;
  from_email?: string | null | undefined;
}

/** The saved from address, or "" when the workspace default sender applies. */
export function campaignFromEmailValue(
  campaign: CampaignSenderSource | null | undefined,
): string {
  const settings = campaign?.delivery_settings;
  if (settings && typeof settings === "object") {
    const direct = (settings as { from_email?: unknown }).from_email;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }
  const top = campaign?.from_email;
  if (typeof top === "string" && top.trim()) return top.trim();
  return "";
}

/**
 * Same shape check the reply-to field uses: a plausible address or blank.
 * Blank is meaningful — it reverts the campaign to the workspace's verified
 * default sender, which is what the summary card's hint copy already says.
 */
export function fromEmailProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return "Enter a valid sending address, or leave it blank to use the workspace default.";
  }
  return null;
}

export function fromEmailChanged(original: string, next: string): boolean {
  return next.trim() !== original.trim();
}

/**
 * The full delivery_settings map with ONLY from_email changed. Spread first,
 * then overwrite — exactly desktop's `{...currentDelivery, from_email}`.
 */
export function deliverySettingsWithFromEmail(
  current: Record<string, unknown> | null | undefined,
  fromEmail: string,
): Record<string, unknown> {
  return { ...(current ?? {}), from_email: fromEmail.trim() };
}

/**
 * The PATCH body for an identity save that includes a sender change: the
 * field diff the sheet computed, plus the preserved-and-replaced settings map.
 */
export function identityPatchWithSender(
  fieldsPatch: Readonly<CampaignFieldsPatch>,
  campaign: CampaignSenderSource | null | undefined,
  fromEmail: string,
): Record<string, unknown> {
  return {
    ...fieldsPatch,
    delivery_settings: deliverySettingsWithFromEmail(
      campaign?.delivery_settings,
      fromEmail,
    ),
  };
}

/**
 * Which save path the identity sheet must take.
 *
 *   - "none"    — nothing changed; the Save button should stay disabled.
 *   - "offline" — only the pointer-decoded identity fields changed; the diff
 *                 rides the offline outbox exactly as before this module.
 *   - "online"  — the sender changed, so the save must carry the FULL
 *                 delivery_settings replace built from the freshest map the
 *                 client holds, and must therefore never be queued for replay.
 *
 * Kept pure so the branch — the part a refactor could silently break, turning
 * a sender edit into a queued stale-map replay — is testable in node.
 */
export type IdentitySavePlan =
  | { kind: "none" }
  | { kind: "offline"; fields: CampaignFieldsPatch }
  | { kind: "online"; body: Record<string, unknown> };

export function identitySavePlan(
  fieldsPatch: Readonly<CampaignFieldsPatch>,
  campaign: CampaignSenderSource | null | undefined,
  originalFromEmail: string,
  nextFromEmail: string,
): IdentitySavePlan {
  const senderChanged = fromEmailChanged(originalFromEmail, nextFromEmail);
  const hasFieldChanges = Object.keys(fieldsPatch).length > 0;
  if (senderChanged) {
    return {
      kind: "online",
      body: identityPatchWithSender(fieldsPatch, campaign, nextFromEmail),
    };
  }
  if (hasFieldChanges) return { kind: "offline", fields: fieldsPatch };
  return { kind: "none" };
}
