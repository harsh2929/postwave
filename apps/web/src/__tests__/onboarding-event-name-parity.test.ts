// SPDX-License-Identifier: AGPL-3.0-only
//
// Two packages hold the same onboarding event vocabulary, on purpose:
//
//   @postwave/telemetry          EVENTS.ONBOARDING_*  — the canonical NAMES
//   @postwave/onboarding-schema  ONBOARDING_EVENT_NAMES + OnboardingEventProps
//                                                      — the PROPERTY shapes
//
// Neither depends on the other, which is the right call: the property shapes
// have no business pulling a PostHog client onto a surface, and telemetry has
// no business knowing what an onboarding wizard is. They bind at each app's
// call site, typed by both.
//
// The cost of that independence is that nothing makes the two lists agree.
// analytics.ts said otherwise — "the string literals below intentionally match
// @postwave/telemetry's EVENTS values; the parity test in that package's
// consumers (and onboarding-schema's own test) guards them" — and no such test
// existed. onboarding-schema's own test checks its list against ITSELF (no
// duplicates, dot-namespaced, matching its type's keys), which cannot detect a
// rename on the other side. The web decision-vocabulary test is about decision
// STATES, not event names.
//
// They match today: 15 names, identical. This is written while that is true,
// because it is the only moment it can be written without also being a bug
// report.
//
// WHAT A DRIFT WOULD DO. An app calls track(EVENTS.ONBOARDING_TOUR_STARTED,
// props) with props typed by onboarding-schema. Rename the value on one side
// and the event ships under the new name carrying the old shape — analytics
// silently splits into two streams, and the property contract documents an
// event nobody emits. Nothing errors: mobile's sanitizeTelemetryProperties
// drops unrecognised keys in silence by design, so a payload can empty itself
// out without a single failure anywhere.
//
// This test lives in apps/web because it is the one place that depends on both
// packages — which is also why the guard could not live in either of them.
import { EVENTS } from "@postwave/telemetry";
import { ONBOARDING_EVENT_NAMES } from "@postwave/onboarding-schema";
import { describe, expect, it } from "vitest";

/** Every EVENTS value namespaced under `onboarding.`. */
function telemetryOnboardingEvents(): string[] {
  return Object.entries(EVENTS)
    .filter(([key, value]) => key.startsWith("ONBOARDING_") || String(value).startsWith("onboarding."))
    .map(([, value]) => String(value))
    .sort();
}

describe("onboarding event names agree across the two packages", () => {
  it("finds a vocabulary on both sides", () => {
    // Guard the guard: a renamed export or a changed prefix would leave one
    // side empty, and two empty sets compare equal.
    expect(telemetryOnboardingEvents().length).toBeGreaterThan(10);
    expect(ONBOARDING_EVENT_NAMES.length).toBeGreaterThan(10);
  });

  it("holds the same set of names", () => {
    expect([...ONBOARDING_EVENT_NAMES].sort()).toEqual(telemetryOnboardingEvents());
  });

  it("keeps the ONBOARDING_ key prefix and the onboarding. value prefix aligned", () => {
    // The filter above accepts either signal, so a key/value mismatch would
    // slip through the set comparison. Assert they describe the same events.
    const byKey = Object.entries(EVENTS)
      .filter(([key]) => key.startsWith("ONBOARDING_"))
      .map(([, v]) => String(v))
      .sort();
    const byValue = Object.values(EVENTS)
      .map(String)
      .filter((v) => v.startsWith("onboarding."))
      .sort();
    expect(byKey).toEqual(byValue);
  });

  it("names nothing twice on either side", () => {
    const telemetry = telemetryOnboardingEvents();
    expect(new Set(telemetry).size).toBe(telemetry.length);
    expect(new Set(ONBOARDING_EVENT_NAMES).size).toBe(ONBOARDING_EVENT_NAMES.length);
  });
});
