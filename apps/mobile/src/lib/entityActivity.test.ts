import { describe, expect, it } from "vitest";

import {
  ENTITY_ACTIVITY_DISCLOSURE,
  entityActivityDescriptor,
  entityActivityId,
  MAX_ACTIVITY_TITLE_CHARS,
} from "./entityActivity";

function open(overrides: Partial<Parameters<typeof entityActivityDescriptor>[0]> = {}) {
  return entityActivityDescriptor({
    entity: "campaign",
    id: "camp_123",
    title: "Summer Sale",
    subtitle: "Sent to 12,400 people",
    appLockEnabled: false,
    ...overrides,
  });
}

describe("entityActivityDescriptor — the disclosure gate", () => {
  it("donates nothing while the app lock is armed", () => {
    // Same rule the widget bridge applies: arming the lock withdraws every
    // out-of-app disclosure.
    expect(open({ appLockEnabled: true })).toBeNull();
  });

  it("treats an unknown entity as not donatable rather than guessing", () => {
    expect(open({ entity: "invoice" })).toBeNull();
    expect(open({ entity: "" })).toBeNull();
  });

  it("refuses an id the shared route registry rejects", () => {
    // The same allow-list the desktop deep-link grammar uses; a smuggled path
    // segment must never reach a donated URL.
    for (const id of ["", "a/b", "../secrets", "a b", "%2e%2e", "x".repeat(129)]) {
      expect(open({ id })).toBeNull();
    }
  });

  it("survives the id being ABSENT, which the type says cannot happen", () => {
    // `id` is typed `string`, and at runtime every caller reads it from
    // `useLocalSearchParams`, which answers `undefined` for a malformed deep
    // link — the exact case each detail screen has a "not found" state for.
    // `isSafeResourceId` does `id.length`, so an unguarded undefined threw
    // inside a passive effect and took the screen to the route error boundary:
    // a bad link rendered as a CRASH instead of as the way out that already
    // existed. Caught by campaign-detail.native.test.tsx once @postwave/route-map
    // stopped being stubbed to `jest.fn()` in the route harness.
    const absent = undefined as unknown as string;
    expect(open({ id: absent })).toBeNull();
    expect(open({ id: null as unknown as string })).toBeNull();
  });
});

describe("entityActivityDescriptor — what gets donated", () => {
  it("carries both link forms: the web URL out and the deep link back", () => {
    const activity = open();
    expect(activity).toMatchObject({
      id: "postwave.entity.campaign.camp_123",
      title: "Summer Sale",
      description: "Sent to 12,400 people",
      // What another device continues to.
      webpageURL: "https://app.moosewave.com/app/campaigns/camp_123",
      // What THIS app resumes to, through the already-tested parser.
      href: "moosewave://campaign/camp_123",
    });
  });

  it("keys one activity per entity, not per route that opened it", () => {
    expect(entityActivityId("campaign", "camp_123")).toBe(
      "postwave.entity.campaign.camp_123",
    );
    expect(open({ id: "camp_123" })?.id).toBe(open({ id: "camp_123" })?.id);
    expect(open({ id: "camp_123" })?.id).not.toBe(open({ id: "camp_9" })?.id);
  });

  it("names the entity rather than exposing its raw id when untitled", () => {
    const activity = open({ title: null });
    expect(activity?.title).toBe("Campaign");
    expect(activity?.title).not.toContain("camp_123");
  });

  it("reports a missing subtitle as null, never as an empty line", () => {
    expect(open({ subtitle: undefined })?.description).toBeNull();
    expect(open({ subtitle: "   " })?.description).toBeNull();
  });

  it("strips control characters and bounds an oversized title", () => {
    const activity = open({ title: `Sum\u0000mer\n\nSale ${"x".repeat(400)}` });
    expect(activity?.title.length).toBeLessThanOrEqual(MAX_ACTIVITY_TITLE_CHARS);
    expect(activity?.title.startsWith("Sum mer Sale")).toBe(true);
    expect(activity?.title).not.toMatch(/[\u0000-\u001F\u007F]/);
  });
});

describe("entityActivityDescriptor — per-entity indexing policy", () => {
  it("indexes workspace content the user authored", () => {
    for (const entity of ["campaign", "sequence"]) {
      const activity = open({ entity, title: "Welcome flow" });
      expect(activity?.isEligibleForHandoff).toBe(true);
      expect(activity?.isEligibleForSearch).toBe(true);
      expect(activity?.keywords).toContain("Welcome flow");
    }
  });

  it("hands off a person but never writes them into the search index", () => {
    // Spotlight entries are persistent and survive sign-out; a subscriber's
    // title is somebody's identity.
    const activity = open({
      entity: "subscriber",
      id: "sub_9",
      title: "jane@acme.com",
    });
    expect(activity?.isEligibleForHandoff).toBe(true);
    expect(activity?.isEligibleForSearch).toBe(false);
    expect(activity?.keywords).toEqual([]);
  });

  it("hands off an approval without indexing a pending decision", () => {
    const activity = open({ entity: "approval", id: "appr_1", title: "Send Q3 blast" });
    expect(activity?.isEligibleForSearch).toBe(false);
    expect(activity?.keywords).toEqual([]);
  });

  it("keeps a personal-looking title out of the keywords even when indexable", () => {
    // Defence in depth: a campaign literally named after a contact must not
    // put that contact into the device search index as a keyword.
    const activity = open({ title: "reply-to jane@acme.com" });
    expect(activity?.isEligibleForSearch).toBe(true);
    expect(activity?.keywords).toEqual(["Moosewave"]);
  });

  it("is opt-in by omission — a new entity discloses nothing until listed", () => {
    expect(Object.keys(ENTITY_ACTIVITY_DISCLOSURE).sort()).toEqual([
      "approval",
      "campaign",
      "sequence",
      "subscriber",
    ]);
    // Every listed entity must state BOTH answers explicitly.
    for (const value of Object.values(ENTITY_ACTIVITY_DISCLOSURE)) {
      expect(typeof value.handoff).toBe("boolean");
      expect(typeof value.spotlight).toBe("boolean");
    }
  });
});
