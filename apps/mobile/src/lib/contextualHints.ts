/**
 * lib/contextualHints — which of the shared onboarding hints mobile can anchor.
 *
 * @postwave/onboarding-schema's CONTEXTUAL_HINTS is the cross-platform
 * contract: one hint per field, keyed by id, rendered by desktop's HintPopover
 * beside that field. Mobile shipped the fields and never the hints, so a
 * first-time operator on a phone saw a DKIM record with no explanation while
 * the same person on desktop got one. This module is the mobile half.
 *
 * NOT EVERY HINT HAS A MOBILE ANCHOR, and that is recorded here rather than
 * papered over. `import.consent` anchors the consent-source INPUT on the
 * import form; mobile watches import jobs and never configures one — it shows
 * consent evidence as a read (SubscriberImportDetailSheet) and has no input
 * to hang the hint on. contextualHints.test.ts fails if a hint gains or loses
 * an anchor without this table changing, in either direction.
 */
import { CONTEXTUAL_HINTS } from "@postwave/onboarding-schema";

export type ContextualHint = (typeof CONTEXTUAL_HINTS)[string];

export type MobileHintAnchor =
  | { readonly hintKey: string; readonly anchor: string }
  | { readonly hintKey: string; readonly notApplicable: string };

export const MOBILE_HINT_ANCHORS: readonly MobileHintAnchor[] = [
  {
    hintKey: "sending-identity.dkim",
    anchor:
      "components/deliverability/DnsRecordCard — the DKIM record card, keyed by DomainRowCard",
  },
  {
    hintKey: "campaign.send-window",
    anchor: "components/campaigns/BestTimeScheduleCard — beside the best-time header",
  },
  {
    hintKey: "import.consent",
    notApplicable:
      "mobile reads consent evidence on an import job (SubscriberImportDetailSheet) and has no consent-source input to anchor",
  },
];

/** The shared hint for a key, or null — an unknown key renders nothing, as on desktop. */
export function contextualHint(hintKey: string): ContextualHint | null {
  return CONTEXTUAL_HINTS[hintKey] ?? null;
}

/**
 * Whether a DNS record is the DKIM one. Providers publish it as a TXT (or
 * CNAME, for delegated signing) at `<selector>._domainkey.<domain>`; some
 * APIs label the type "DKIM" outright. Either form is the anchor.
 */
export function isDkimRecord(record: { type: string; name: string }): boolean {
  if (record.type.trim().toUpperCase() === "DKIM") return true;
  return /(^|\.)_domainkey(\.|$)/iu.test(record.name.trim());
}
