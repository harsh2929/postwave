import { describe, expect, it } from "vitest";

import {
  EMPTY_STATES,
  type EmptyStateContent,
} from "@postwave/onboarding-schema";

import {
  CAMPAIGN_CREATE_PARAM,
  routeForOnboardingKey,
} from "@/components/onboarding/onboardingRoutes";

function catalogueEntry(key: "campaigns" | "sequences" | "forms") {
  const content = EMPTY_STATES[key];
  if (!content) throw new Error(`Missing shared empty-state content: ${key}`);
  return content;
}

function primaryRoute(content: EmptyStateContent): string {
  const cta = content.primaryCta;
  if (!cta) throw new Error(`Missing primary CTA: ${content.id}`);
  return routeForOnboardingKey(cta.routeKey);
}

describe("mobile rich-empty-state eligibility", () => {
  it("campaign creation resolves to a real create-sheet action", () => {
    const content = catalogueEntry("campaigns");

    expect(primaryRoute(content)).toBe(
      `/(tabs)/campaigns?${CAMPAIGN_CREATE_PARAM}=1`,
    );
    expect(primaryRoute(content)).not.toBe(
      routeForOnboardingKey(content.surfaceRouteKey ?? "campaigns"),
    );
  });

  it("routes the sequence shared CTA to the create sheet, not to the list", () => {
    const content = catalogueEntry("sequences");

    // The list reads the same `?new=1` campaigns and forms do
    // (hooks/useCreateParam), so "Build a sequence" opens SequenceCreateSheet
    // on arrival instead of landing on the list the user was already looking
    // at with the action "one tap away". Same shape as campaigns.new above.
    expect(primaryRoute(content)).toBe(
      `/(tabs)/sequences?${CAMPAIGN_CREATE_PARAM}=1`,
    );
    expect(primaryRoute(content)).not.toBe(routeForOnboardingKey("sequences"));
  });

  it("documents why the forms shared CTA stays unwired", () => {
    const content = catalogueEntry("forms");

    // Mobile CAN create a form (the list's header "New" opens FormCreateSheet,
    // and the list honours `?new=1`), but the schema gives forms only the bare
    // destination key — `forms`, not `forms.new` — and that key is also what
    // "connect a form" on OTHER screens must land on. Carrying a create intent
    // would need a `forms.new` key in @postwave/onboarding-schema mapped on
    // every client; until then this CTA lands on the list, where New is one
    // tap away. Recorded here so the limitation is the schema's, not mobile's.
    expect(primaryRoute(content)).toBe(routeForOnboardingKey("forms"));
  });
});
