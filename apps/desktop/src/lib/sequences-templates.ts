/**
 * Sequences — starter template library.
 *
 * Useful drafting > blank-canvas friction. The Sequences page used to ship a single
 * "New sequence" CTA that dropped operators onto a blank canvas — the
 * canonical empty-workspace gap. The templates below cover the
 * universal automation surface area we see in lifecycle email tools
 * (welcome, onboarding, abandoned cart, post-purchase, win-back,
 * birthday, quarterly re-engagement) so a first-time operator can
 * create a useful review draft and iterate from a working baseline instead of
 * staring at an empty palette. Klaviyo / Customer.io /
 * Iterable / Loops / ActiveCampaign all ship 20+ pre-built flows as
 * the primary entry point; seven gives this draft workspace a representative
 * authoring surface without claiming live automation parity.
 *
 * Each template is self-contained: name, description, icon, a tiny
 * 3-step preview for the card, and the actual `steps[]` payload that
 * the backend persists. The shape of `steps[]` matches
 * `SequenceCanvasStep` from api-client.ts — the same array we'd
 * normally build by clicking through the StepCanvas + saving. We
 * deliberately pass the steps to `createSequence` in one round-trip
 * (the v0.3 API already accepts `steps[]` on POST — see api-client.ts
 * `createSequence`) instead of a create-then-PATCH dance like Forms
 * uses, because the voice service has no shallow-vs-deep split here.
 *
 * Step content is intentionally low-fidelity (subject + plaintext
 * body, no HTML). The operator opens the canvas, customizes copy in
 * StepEditor, and saves a reviewable draft. Email bodies are short, on-brand, and end
 * with a clear single CTA. Delay values are encoded in three places —
 * `seconds`, `value`, `unit` — because the canvas's
 * `backendStepToCanvasStep` reader prefers `value`/`unit` for the
 * pretty input UI but falls back to deriving them from `seconds`.
 * Shipping all three avoids a follow-up edit churn the first time the
 * user opens the canvas. These are reviewable copy outlines only: they do not
 * configure an entry trigger, activate delivery, or promise a runtime action.
 *
 * IMPORTANT: don't add a backend coupling here. The templates only
 * seed the draft — the create call goes through the existing
 * `api.createSequence` endpoint exactly as a manual "New sequence"
 * would, just with steps pre-populated. If voice-service step
 * validation changes, this file changes; nothing on the server does.
 */

import type { SequenceCanvasStep } from "./api-client";

/** Seconds-per-unit lookup so delay encodings stay readable inline. */
const SECONDS_PER_UNIT = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
} as const;

/** Build a delay step in the shape StepCanvas's reader expects. */
function delay(
  value: number,
  unit: "minutes" | "hours" | "days",
): SequenceCanvasStep {
  return {
    type: "delay",
    position: 0, // position is rewritten on persist by canvasStepsToBackendSteps
    delay: {
      seconds: value * SECONDS_PER_UNIT[unit],
      value,
      unit,
    },
  };
}

/** Build an email step. Position is rewritten on persist. */
function email(subject: string, body: string): SequenceCanvasStep {
  return {
    type: "email",
    position: 0,
    email: {
      subject,
      body,
      delay_seconds: 0,
    },
  };
}

/**
 * Template definition consumed by the Sequences page. `previewSteps`
 * is a UI-only string list shown on the card so we don't render the
 * full `steps[]` blob — it should always match the major beats of
 * `steps[]` so the card doesn't lie about what gets created.
 */
export interface SequencesTemplate {
  /** Stable key — used as React key and template-pick analytics id. */
  key: string;
  /** Human-readable name, used as default sequence name. */
  name: string;
  /** One-line pitch shown on the card. Sentence case, no trailing dot. */
  description: string;
  /** Inline SVG path (24×24 viewBox, stroke=currentColor). */
  iconPath: string;
  /** Three short bullets for the card's at-a-glance step preview. */
  previewSteps: [string, string, string] | [string, string] | [string];
  /**
   * The actual canvas steps to seed. Ordered top-to-bottom. Positions
   * are placeholders — the API call rewrites them by array index.
   */
  steps: SequenceCanvasStep[];
}

/**
 * The starter library. Ordering reflects observed picker preference:
 * welcome (newsletters) → onboarding (SaaS first-week) → abandoned
 * cart (commerce) → post-purchase (commerce retention) → win-back
 * (every tool eventually needs it) → birthday (universal +1) →
 * quarterly re-engagement (the long tail). Seven covers the universal
 * lifecycle starters without the row feeling like a settings panel.
 */
export const SEQUENCES_TEMPLATES: SequencesTemplate[] = [
  {
    key: "welcome-series",
    name: "Welcome series",
    description:
      "Draft a welcome, a value follow-up, and a first CTA across five days.",
    // Hand-wave / greeting glyph.
    iconPath:
      "M3 12c0-5 4-9 9-9s9 4 9 9-4 9-9 9c-1.4 0-2.7-.3-3.9-.8L3 21l.8-5.1A8.9 8.9 0 0 1 3 12z M8 11h.01M12 11h.01M16 11h.01",
    previewSteps: [
      "Day 0 — welcome + what to expect",
      "Day 2 — best-of value send",
      "Day 5 — first CTA / next step",
    ],
    steps: [
      email(
        "Welcome aboard — here's what to expect",
        "Hi there,\n\nThanks for subscribing. A quick intro: I send {{cadence}} on {{topic}}, and you'll get the next one within {{interval}}.\n\nIf you ever want to reply, hit the button — these emails come from a real inbox and I read every response.\n\n— {{sender_name}}",
      ),
      delay(2, "days"),
      email(
        "The one post most new readers love",
        "Hey,\n\nWhen people first subscribe, this is the piece they almost always wish they'd read first:\n\n{{best_post_link}}\n\nGive it 5 minutes — and let me know what resonates.\n\n— {{sender_name}}",
      ),
      delay(3, "days"),
      email(
        "Ready for the next step?",
        "Quick one —\n\nNow that you've seen the rhythm, here's the single thing I'd recommend doing next:\n\n{{primary_cta}}\n\nIt's the move that's helped the most readers get value fast. Reply if you want a nudge picking the right starting point.\n\n— {{sender_name}}",
      ),
    ],
  },
  {
    key: "onboarding-product-tour",
    name: "Onboarding",
    description:
      "Draft setup, first-win, and habit-building messages for a first-week journey.",
    // Compass / direction glyph for "guided tour".
    iconPath:
      "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88l6.36-2.12z",
    previewSteps: [
      "Day 0 — finish setup checklist",
      "Day 2 — your first win",
      "Day 6 — make it a habit",
    ],
    steps: [
      email(
        "Let's get you set up — 3 quick steps",
        "Hi {{first_name}},\n\nWelcome to {{product_name}}. Most teams get their first useful result within 10 minutes — here's the fastest path to it:\n\n1. {{setup_step_one}}\n2. {{setup_step_two}}\n3. {{setup_step_three}}\n\nPick up where you left off → {{setup_link}}\n\nIf you hit a snag, just reply — it's the founders on the other end.\n\n— {{sender_name}}",
      ),
      delay(2, "days"),
      email(
        "Try this — it's the moment teams say it clicks",
        "Hey {{first_name}},\n\nNow that the basics are wired up, try the move that almost every team tells us is where {{product_name}} starts paying for itself:\n\n{{aha_moment_link}}\n\nTakes about 5 minutes. We'll send a follow-up at the end of the week with what to layer on next.\n\n— {{sender_name}}",
      ),
      delay(4, "days"),
      email(
        "How to make it a weekly habit",
        "Hi {{first_name}},\n\nThe teams that stick with {{product_name}} long-term all share the same pattern: a small weekly rhythm. Here's the lightest version we've seen work:\n\n• Monday: {{habit_step_one}}\n• Wednesday: {{habit_step_two}}\n• Friday: {{habit_step_three}}\n\nIf this isn't fitting your workflow, hit reply with how you'd want it to go — we love hearing how real teams use it.\n\n— {{sender_name}}",
      ),
    ],
  },
  {
    key: "abandoned-cart",
    name: "Abandoned cart",
    description:
      "Draft a cart reminder, an optional incentive placeholder, and a social-proof follow-up.",
    // Shopping-cart glyph.
    iconPath:
      "M3 3h2l2.4 12.3a2 2 0 0 0 2 1.7h8.2a2 2 0 0 0 2-1.6L21 8H6 M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    previewSteps: [
      "+1 hour — gentle cart reminder",
      "+1 day — optional offer placeholder",
      "+3 days — social proof + last call",
    ],
    steps: [
      delay(1, "hours"),
      email(
        "You left something behind",
        "Hi {{first_name}},\n\nLooks like you got pulled away before finishing up — your cart is still here:\n\n{{cart_link}}\n\nNo pressure. We just save it so you don't have to start over.\n\n— {{store_name}}",
      ),
      delay(1, "days"),
      email(
        "A little something for your cart",
        "{{first_name}}, still thinking it over?\n\nIf this order is eligible, use {{discount_code}} for {{discount_value}} off at checkout. Confirm the offer, eligibility, and expiry before using this draft.\n\n{{cart_link}}\n\n— {{store_name}}",
      ),
      delay(2, "days"),
      email(
        "What other shoppers said",
        'Last note from us, {{first_name}} —\n\nIf the on-the-fence is about whether this is the right pick, here\'s what recent buyers said:\n\n"{{review_quote_one}}"\n— {{review_author_one}}\n\n"{{review_quote_two}}"\n— {{review_author_two}}\n\nYour cart\'s still here if you want it:\n{{cart_link}}\n\n— {{store_name}}',
      ),
    ],
  },
  {
    key: "post-purchase",
    name: "Post-purchase",
    description:
      "Draft a care guide, review request, and optional reorder cue for review.",
    // Box / package glyph for fulfillment.
    iconPath: "M21 8 12 3 3 8m18 0v8l-9 5-9-5V8m18 0L12 13M3 8l9 5m0 0v8",
    previewSteps: [
      "+1 day — care + setup tips",
      "+10 days — leave a review",
      "+30 days — ready to reorder?",
    ],
    steps: [
      delay(1, "days"),
      email(
        "Getting the most out of your order",
        "Hi {{first_name}},\n\nThanks again for picking up {{product_title}} — it should be on its way (or already with you).\n\nA few quick tips so you get the best out of it from day one:\n\n• {{care_tip_one}}\n• {{care_tip_two}}\n• {{care_tip_three}}\n\nQuestions about setup or care? Just reply — a human reads every one of these.\n\n— {{store_name}}",
      ),
      delay(9, "days"),
      email(
        "How's it been? A quick review would mean a lot",
        "Hey {{first_name}},\n\nYou've had {{product_title}} for about a week — long enough to know if it's clicking. If you've got 60 seconds, a quick review helps us (and other shoppers) more than you'd guess:\n\n{{review_link}}\n\nAnd if anything's not perfect, reply here first — we'd much rather fix it than have you leave a 3-star.\n\n— {{store_name}}",
      ),
      delay(20, "days"),
      email(
        "Might it be time to reorder?",
        "Hi {{first_name}},\n\nIf {{product_title}} is something customers typically replenish around this time, invite them back here:\n\n{{shop_link}}\n\nOptional verified offer: {{discount_value}} off with {{discount_code}} until {{offer_expiry}}. Remove this line unless the offer is approved and active.\n\n— {{store_name}}",
      ),
    ],
  },
  {
    key: "win-back-lapsed",
    name: "Win-back lapsed",
    description:
      "Draft two check-ins and a transparent subscription-preference reminder.",
    // Refresh / reverse-arrow glyph.
    iconPath:
      "M3 12a9 9 0 0 1 15.5-6.3L21 3M21 3v6h-6 M21 12a9 9 0 0 1-15.5 6.3L3 21M3 21v-6h6",
    previewSteps: [
      "Day 0 — are we still a fit?",
      "Day 7 — one more reason to stay",
      "Day 14 — preference reminder",
    ],
    steps: [
      email(
        "Are we still a fit?",
        "Hi {{first_name}},\n\nNoticed it's been a while since you opened one of these. No drama — inboxes are loud and priorities shift.\n\nIf you'd still like to hear from me, review your choices here:\n\n{{preference_center_link}}\n\nThis copy is only a draft. Connect the link to a verified consent workflow before sending, and don't infer consent from an open or reply.\n\n— {{sender_name}}",
      ),
      delay(7, "days"),
      email(
        "One more thing before I go",
        "Hey {{first_name}},\n\nBefore the final preference reminder, here's the one thing I'd want you to see — the post most readers tell me changed how they think about {{topic}}:\n\n{{best_post_link}}\n\nTo choose whether regular messages continue, use {{preference_center_link}}. This draft does not change subscription state on its own.\n\n— {{sender_name}}",
      ),
      delay(7, "days"),
      email(
        "Choose what you want to hear from us",
        "Hi {{first_name}},\n\nIf these messages are no longer useful, you can update your preferences or unsubscribe here:\n\n{{preference_center_link}}\n\nThis draft does not change anyone's subscription by itself; connect it only to a verified consent workflow.\n\nThanks for the time and attention.\n\n— {{sender_name}}",
      ),
    ],
  },
  {
    key: "birthday-anniversary",
    name: "Birthday / anniversary",
    description:
      "Draft one personalized greeting for a future, separately configured date entry.",
    // Gift / present glyph.
    iconPath:
      "M20 12v9H4v-9 M22 7H2v5h20V7z M12 22V7 M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z",
    previewSteps: [
      "Entry trigger — not included",
      "Draft — personalized greeting + optional offer",
    ],
    steps: [
      email(
        "Happy {{occasion}}, {{first_name}}",
        "Hi {{first_name}},\n\nIt's your {{occasion}} — and we wanted to mark it with a small thank-you for being part of the {{store_name}} community.\n\nOptional verified offer: use {{discount_code}} for {{discount_value}} off until {{offer_expiry}}. Remove this line unless the offer is approved and active.\n\n{{shop_link}}\n\nHave a great one.\n\n— {{store_name}}",
      ),
    ],
  },
  {
    key: "re-engagement-quarterly",
    name: "Re-engagement",
    description:
      "Draft an interest check, preference question, and preference-center CTA.",
    // Sparkle / refresh-question glyph.
    iconPath:
      "M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z",
    previewSteps: [
      "Day 0 — still want to hear from us?",
      "Day 3 — what would you want more of?",
      "Day 7 — preference-center reminder",
    ],
    steps: [
      email(
        "Quick check-in — still good?",
        "Hi {{first_name}},\n\nWe send {{cadence}}, and we'd rather hear from people who actually want to. So a quick check-in:\n\nAre these emails still useful to you? Review and save your choice here:\n\n{{preference_center_link}}\n\nThis draft does not treat an open or reply as consent; connect it to a verified preference workflow before sending.\n\n— {{sender_name}}",
      ),
      delay(3, "days"),
      email(
        "What would you want more of?",
        "Hey {{first_name}},\n\nWhile you're thinking about it — what kind of {{topic}} content would make these worth opening more often? Review the choices here:\n\n{{topic_preferences_link}}\n\n• {{topic_option_one}}\n• {{topic_option_two}}\n• {{topic_option_three}}\n\nOnly promise personalized follow-up after the preference link and tag workflow are verified; this draft does not update tags itself.\n\n— {{sender_name}}",
      ),
      delay(4, "days"),
      email(
        "Review your email preferences",
        "Thanks {{first_name}} —\n\nYou can review and save your email preferences here:\n\n{{preference_center_link}}\n\nThis message draft does not update preferences or tags by itself. Connect it only after the preference workflow is verified.\n\nTalk soon.\n\n— {{sender_name}}",
      ),
    ],
  },
];
