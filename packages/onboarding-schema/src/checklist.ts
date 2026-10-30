/**
 * The canonical getting-started checklist — shared across web/desktop/mobile.
 *
 * `ChecklistGoalKey` is the 1:1 union of the server's onboarding-progress step
 * keys (apps/api/internal/onboarding_progress). Each goal carries the extra
 * client-side metadata the server doesn't: which TIER it belongs to (so the
 * UI can hero the path-to-first-send and recess the hardening work), an
 * abstract CTA route key (each platform maps it to its own route), and a
 * display order. Labels/descriptions here are FALLBACKS — at runtime the
 * client prefers the server-authored copy from the progress payload.
 */

/** Every checklist goal key, identical to the server's step keys. */
export const CHECKLIST_GOAL_KEYS = [
  "verified_sending_identity",
  "configured_dkim_dmarc",
  "created_subscriber",
  "uploaded_subscribers_bulk",
  "designed_first_campaign",
  "sent_first_campaign",
  "created_signup_form",
  "configured_unsubscribe_brand",
  "invited_team_member",
  "connected_product_events",
] as const;

export type ChecklistGoalKey = (typeof CHECKLIST_GOAL_KEYS)[number];

/**
 * Tiers split the "must-do to send" spine from the "make it durable" work, so
 * the renderer can emphasize the former and collapse the latter.
 */
export type ChecklistTier = "path-to-send" | "hardening";

/** Abstract route keys — each platform resolves these to a real route/screen. */
export type OnboardingRouteKey =
  | "settings.sending-identity"
  | "settings.domain"
  | "settings.team"
  | "settings.events"
  | "subscribers"
  | "subscribers.import"
  | "campaigns"
  | "campaigns.new"
  // The sequences pair mirrors the campaigns pair: a LIST key and a COMPOSE
  // key. Without `sequences.new` the shared "Build a sequence" CTA had no
  // honest destination and pointed at `campaigns` — a different entity.
  | "sequences"
  | "sequences.new"
  | "forms";

export interface ChecklistGoal {
  key: ChecklistGoalKey;
  /** Fallback label (server copy preferred at runtime). */
  label: string;
  /** Fallback description (server copy preferred at runtime). */
  description: string;
  tier: ChecklistTier;
  /** Where the goal's CTA takes the user (abstract; platform-resolved). */
  ctaRouteKey: OnboardingRouteKey;
  /** Display order within the checklist. */
  order: number;
}

/** The canonical, ordered checklist. */
export const CHECKLIST_GOALS: readonly ChecklistGoal[] = [
  {
    key: "verified_sending_identity",
    label: "Verify a sending domain",
    description:
      "Add the DKIM/SPF/DMARC records at your registrar and run the verifier.",
    tier: "path-to-send",
    ctaRouteKey: "settings.sending-identity",
    order: 1,
  },
  {
    key: "created_subscriber",
    label: "Add your first subscriber",
    description: "Via the API, a signup form, or an import — one is enough.",
    tier: "path-to-send",
    ctaRouteKey: "subscribers",
    order: 2,
  },
  {
    key: "designed_first_campaign",
    label: "Design your first campaign",
    description: "A draft is enough — you can preview without sending.",
    tier: "path-to-send",
    ctaRouteKey: "campaigns.new",
    order: 3,
  },
  {
    key: "sent_first_campaign",
    label: "Send your first campaign",
    description: "Crosses the line from setup to operating.",
    tier: "path-to-send",
    ctaRouteKey: "campaigns",
    order: 4,
  },
  {
    key: "configured_dkim_dmarc",
    label: "Resolve DKIM + DMARC",
    description: "Both records passing the periodic re-verifier keeps you out of spam.",
    tier: "hardening",
    ctaRouteKey: "settings.sending-identity",
    order: 5,
  },
  {
    key: "uploaded_subscribers_bulk",
    label: "Bulk-import from CSV",
    description: "Imports unlock the bulk-operation and dedupe affordances.",
    tier: "hardening",
    ctaRouteKey: "subscribers.import",
    order: 6,
  },
  {
    key: "created_signup_form",
    label: "Publish a signup form",
    description: "An embeddable form unlocks growth-source attribution + double opt-in.",
    tier: "hardening",
    ctaRouteKey: "forms",
    order: 7,
  },
  {
    key: "configured_unsubscribe_brand",
    label: "Add a branded sending domain",
    description: "Custom domain for tracking + unsubscribe links instead of 'moosewave.com'.",
    tier: "hardening",
    ctaRouteKey: "settings.domain",
    order: 8,
  },
  {
    key: "invited_team_member",
    label: "Invite a teammate",
    description: "Multi-operator access avoids a 'who has the password' incident later.",
    tier: "hardening",
    ctaRouteKey: "settings.team",
    order: 9,
  },
  {
    key: "connected_product_events",
    label: "Connect product events",
    description: "POST events to /api/v1/track so sequences react to behaviour, not just email.",
    tier: "hardening",
    ctaRouteKey: "settings.events",
    order: 10,
  },
] as const;

/** Lookup a goal's metadata by key. */
export function goalForKey(key: string): ChecklistGoal | undefined {
  return CHECKLIST_GOALS.find((g) => g.key === key);
}

/** The path-to-first-send spine, in order — the goals the UI should hero. */
export const PATH_TO_SEND_GOALS: readonly ChecklistGoal[] = CHECKLIST_GOALS.filter(
  (g) => g.tier === "path-to-send",
);
