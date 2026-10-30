/**
 * Empty-state content schema — shared across web/desktop/mobile so every
 * "nothing here yet" surface frames the OUTCOME (what you'll get) instead of
 * the deficit ("No X yet"), with a consistent illustration + action grammar.
 *
 * `illustrationKey` and CTA `routeKey`s are abstract; each platform maps them
 * to its own asset/route. Copy is authored once here.
 */

import type { OnboardingRouteKey } from "./checklist.js";

/** Abstract illustration ids — each platform maps to its own asset. */
export type EmptyStateIllustration =
  | "subscribers"
  | "campaigns"
  | "sequences"
  | "forms"
  | "segments"
  | "approvals"
  | "generic";

export interface EmptyStateCta {
  label: string;
  routeKey: OnboardingRouteKey;
  /** Visual weight; defaults to "primary" for the first CTA. */
  variant?: "primary" | "secondary";
}

export interface EmptyStateContent {
  /** Stable id (also used as the surface name in analytics). */
  id: string;
  /** Outcome-framed headline (e.g. "Reach your people"). */
  title: string;
  /** One or two supporting sentences. */
  subtitle: string;
  illustrationKey?: EmptyStateIllustration;
  primaryCta?: EmptyStateCta;
  secondaryCta?: EmptyStateCta;
  /**
   * The route key of the surface this content is DISPLAYED on, when it is
   * shown on a routed screen of its own.
   *
   * Declaring it turns on the self-route invariant in the package test: a CTA
   * whose `routeKey` resolves to the screen the empty state is already on is a
   * button that does nothing. That is not hypothetical — `subscribers`
   * shipped a "Add manually" secondary CTA pointing at `subscribers`, and
   * apps/mobile's SubscribersListEmpty rendered it next to a hand-rolled
   * local button precisely because the shared one went nowhere.
   *
   * Leave it undefined for content that is not (yet) rendered on a routed
   * screen; add it in the same change that wires the content to a surface.
   */
  surfaceRouteKey?: OnboardingRouteKey;
}

/** Canonical empty-state copy, keyed by surface id. */
export const EMPTY_STATES: Record<string, EmptyStateContent> = {
  subscribers: {
    id: "subscribers",
    title: "Your audience starts here",
    subtitle:
      "Import an existing list or add people one at a time — every subscriber carries its own consent record.",
    illustrationKey: "subscribers",
    surfaceRouteKey: "subscribers",
    primaryCta: { label: "Import a list", routeKey: "subscribers.import" },
    // Was `{ label: "Add manually", routeKey: "subscribers" }` — the screen
    // this content is rendered on, so the button navigated to itself. Adding
    // one person by hand is an in-place action a screen owns (mobile opens a
    // create sheet); a SHARED secondary CTA has to name a different, reachable
    // destination, and the other way to grow an audience is a signup form.
    secondaryCta: {
      label: "Collect from a form",
      routeKey: "forms",
      variant: "secondary",
    },
  },
  campaigns: {
    id: "campaigns",
    title: "Send something worth opening",
    subtitle:
      "Draft a campaign with AI subject suggestions, send-time optimization, and Inbox Reality baked in.",
    illustrationKey: "campaigns",
    surfaceRouteKey: "campaigns",
    // `campaigns.new` is a DIFFERENT key from the surface: every platform
    // resolves it to a compose entry point (mobile opens the create sheet via
    // `?new=1`), so this is not a self-route.
    primaryCta: { label: "Create a campaign", routeKey: "campaigns.new" },
  },
  sequences: {
    id: "sequences",
    title: "Put your follow-ups on autopilot",
    subtitle:
      "Welcome series, win-backs, behaviour-triggered flows — built once, running while you sleep.",
    illustrationKey: "sequences",
    // "Build a sequence" used to route to `campaigns` — a DIFFERENT ENTITY.
    // A CTA that lands the reader on someone else's list is worse than no CTA;
    // `sequences.new` is the compose entry point, resolved per platform the
    // same way `campaigns.new` is.
    primaryCta: { label: "Build a sequence", routeKey: "sequences.new" },
  },
  forms: {
    id: "forms",
    title: "Turn visitors into subscribers",
    subtitle:
      "Publish an embeddable signup form with double opt-in and growth-source attribution.",
    illustrationKey: "forms",
    primaryCta: { label: "Create a form", routeKey: "forms" },
  },
};
