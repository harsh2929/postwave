import { describe, expect, it } from "vitest";
import {
  CHECKLIST_GOAL_KEYS,
  CHECKLIST_GOALS,
  EMPTY_STATES,
  PATH_TO_SEND_GOALS,
  goalForKey,
  adaptiveSteps,
  isGoalComplete,
  isOnboardingProgress,
  ONBOARDING_EVENT_NAMES,
  type OnboardingEventProps,
  type OnboardingProgress,
  type TourStep,
} from "./index";

// The exact step keys the Go endpoint returns
// (apps/api/internal/onboarding_progress/onboarding_progress.go). If the
// server adds/renames a step, THIS list must change in lockstep — that's the
// point of the assertion.
const SERVER_STEP_KEYS = [
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
];

describe("checklist contract", () => {
  it("goal keys align 1:1 with the server's onboarding-progress steps", () => {
    expect([...CHECKLIST_GOAL_KEYS].sort()).toEqual([...SERVER_STEP_KEYS].sort());
  });

  it("every goal key has exactly one metadata entry", () => {
    expect(CHECKLIST_GOALS).toHaveLength(CHECKLIST_GOAL_KEYS.length);
    for (const key of CHECKLIST_GOAL_KEYS) {
      expect(goalForKey(key)).toBeDefined();
    }
  });

  it("tiers partition the goals (path-to-send + hardening = all)", () => {
    const tiers = new Set(CHECKLIST_GOALS.map((g) => g.tier));
    expect(tiers).toEqual(new Set(["path-to-send", "hardening"]));
    expect(PATH_TO_SEND_GOALS.length).toBeGreaterThan(0);
    expect(PATH_TO_SEND_GOALS.length).toBeLessThan(CHECKLIST_GOALS.length);
  });

  it("display orders are unique", () => {
    const orders = CHECKLIST_GOALS.map((g) => g.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe("progress helpers", () => {
  const progress: OnboardingProgress = {
    steps: [
      { key: "verified_sending_identity", label: "", description: "", completed: true },
      { key: "sent_first_campaign", label: "", description: "", completed: false },
    ],
    completed: 1,
    total: 2,
    percent: 50,
    all_done: false,
  };

  it("isOnboardingProgress accepts the server shape, rejects junk", () => {
    expect(isOnboardingProgress(progress)).toBe(true);
    expect(isOnboardingProgress(null)).toBe(false);
    expect(isOnboardingProgress({ steps: "nope" })).toBe(false);
  });

  it("isGoalComplete reads the right step", () => {
    expect(isGoalComplete(progress, "verified_sending_identity")).toBe(true);
    expect(isGoalComplete(progress, "sent_first_campaign")).toBe(false);
    expect(isGoalComplete(null, "verified_sending_identity")).toBe(false);
  });
});

describe("adaptive tour filtering", () => {
  const steps: TourStep[] = [
    { id: "welcome", title: "Hi", body: "" },
    { id: "verify", title: "Verify", body: "", skipIfGoalDone: "verified_sending_identity" },
    { id: "send", title: "Send", body: "", skipIfGoalDone: "sent_first_campaign" },
  ];

  it("drops steps whose goal is already complete", () => {
    const done = new Set(["verified_sending_identity"]);
    const result = adaptiveSteps(steps, (k) => done.has(k));
    expect(result.map((s) => s.id)).toEqual(["welcome", "send"]);
  });

  it("keeps every step when nothing is complete", () => {
    const result = adaptiveSteps(steps, () => false);
    expect(result).toHaveLength(3);
  });
});

describe("analytics taxonomy", () => {
  it("ONBOARDING_EVENT_NAMES matches the OnboardingEventProps keys exactly", () => {
    // Compile-time-ish parity check at runtime: the const list and the type's
    // keys must be the same set. We assert the const has no dupes and is
    // self-consistent; the type binding is enforced by tsc.
    const names = [...ONBOARDING_EVENT_NAMES];
    expect(new Set(names).size).toBe(names.length);
    // Every name is dot-namespaced under "onboarding.".
    for (const n of names) {
      expect(n.startsWith("onboarding.")).toBe(true);
    }
    // Type-level: this object must list every event name as a key, or tsc
    // fails the build (exhaustiveness witness).
    const witness: Record<keyof OnboardingEventProps, true> = {
      "onboarding.tour_started": true,
      "onboarding.tour_step_viewed": true,
      "onboarding.tour_step_skipped": true,
      "onboarding.tour_completed": true,
      "onboarding.tour_dismissed": true,
      "onboarding.checklist_viewed": true,
      "onboarding.checklist_goal_completed": true,
      "onboarding.checklist_completed": true,
      "onboarding.wizard_started": true,
      "onboarding.wizard_step_completed": true,
      "onboarding.wizard_completed": true,
      "onboarding.milestone_celebrated": true,
      "onboarding.empty_state_cta_clicked": true,
      "onboarding.nudge_shown": true,
      "onboarding.nudge_accepted": true,
    };
    expect(Object.keys(witness).sort()).toEqual(names.sort());
  });
});

describe("empty-state catalogue", () => {
  it("never routes a CTA back to the screen the empty state is shown on", () => {
    // A "nothing here yet" block whose button navigates to the screen it is
    // already on is a dead control. `subscribers` shipped exactly that (an
    // "Add manually" CTA with routeKey "subscribers"), which is why
    // apps/mobile's SubscribersListEmpty rendered a second, hand-rolled
    // button beside it. Declaring `surfaceRouteKey` arms this check.
    for (const content of Object.values(EMPTY_STATES)) {
      if (!content.surfaceRouteKey) continue;
      for (const cta of [content.primaryCta, content.secondaryCta]) {
        if (!cta) continue;
        expect(
          cta.routeKey,
          `${content.id}: CTA "${cta.label}" routes to its own surface`,
        ).not.toBe(content.surfaceRouteKey);
      }
    }
  });

  it("never sends a CTA to a different entity than its own surface", () => {
    // "Build a sequence" used to carry routeKey "campaigns". The entity family
    // is the part before the first dot, so a sequences CTA must stay inside
    // the `sequences.*` family (or point at a genuinely cross-entity next
    // step that is spelled out here).
    const CROSS_ENTITY_BY_DESIGN: Record<string, readonly string[]> = {
      // Growing an audience legitimately hands off to forms + imports.
      subscribers: ["forms", "subscribers.import"],
    };
    for (const content of Object.values(EMPTY_STATES)) {
      const allowed = CROSS_ENTITY_BY_DESIGN[content.id] ?? [];
      for (const cta of [content.primaryCta, content.secondaryCta]) {
        if (!cta) continue;
        if (allowed.includes(cta.routeKey)) continue;
        expect(
          cta.routeKey.split(".")[0],
          `${content.id}: CTA "${cta.label}" leaves its entity for ${cta.routeKey}`,
        ).toBe(content.id);
      }
    }
  });

  it("every catalogue key matches its content id", () => {
    for (const [key, content] of Object.entries(EMPTY_STATES)) {
      expect(content.id).toBe(key);
    }
  });
});
