/**
 * Contextual inline-help schema. These are the small `?` affordances that sit
 * next to complex fields (API keys, sending config, consent capture) and
 * expand a short explanation in place — the lighter-weight cousin of a tour
 * step. Authored once here; each platform renders its native popover/sheet.
 */

export interface ContextualHint {
  /** Stable id (used for instrumentation + dedupe). */
  id: string;
  /** Platform-agnostic anchor id — renderer attaches the `?` to this field. */
  anchorKey: string;
  /** Short title for the hint popover. */
  title: string;
  /** Body copy (1–3 sentences). */
  body: string;
  /** Optional docs deep-link. */
  learnMoreUrl?: string;
}

/** Canonical hints, keyed by id. */
export const CONTEXTUAL_HINTS: Record<string, ContextualHint> = {
  "sending-identity.dkim": {
    id: "sending-identity.dkim",
    anchorKey: "field.dkim-record",
    title: "What's a DKIM record?",
    body: "A DNS TXT record that cryptographically signs your mail so mailbox providers trust it's really from you. Paste it at your registrar, then run the verifier.",
    learnMoreUrl: "https://docs.moosewave.com/deliverability/dkim",
  },
  "import.consent": {
    id: "import.consent",
    anchorKey: "field.consent-source",
    title: "Why we ask for consent proof",
    body: "Recording where and when each subscriber opted in protects your sender reputation and keeps imports compliant. A source label and capture date are enough.",
    learnMoreUrl: "https://docs.moosewave.com/subscribers/consent",
  },
  "campaign.send-window": {
    id: "campaign.send-window",
    anchorKey: "field.send-window",
    title: "Send-time optimization",
    body: "Moosewave can hold each recipient's send until their most-likely-to-open hour, based on past engagement. Leave it on unless you need an exact send time.",
  },
};
