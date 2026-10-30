import { describe, expect, it } from "vitest";

import {
  ONSITE_TARGETING_WRITE_MINIMUM_ROLE,
  buildTargetingStatusPut,
  onsiteToggleVerb,
  parseOnsiteExperiments,
  parseOnsiteSpinRewards,
  parseOnsiteTargeting,
} from "./onsiteGrowth";

// A realistic wire record, INCLUDING rule maps mobile never renders.
const SERVER_TARGETING = {
  id: "tg-1",
  tenant_id: "t-1",
  form_id: "f-1",
  status: "published",
  priority: 100,
  trigger: { type: "exit_intent", delay_seconds: 0 },
  frequency: { max_per_session: 1 },
  audience: { segments: ["seg-9"] },
  url_rules: { include: ["/pricing"] },
  utm_rules: {},
  cart_rules: {},
  geo_rules: { countries: ["DE"] },
  device_rules: {},
  visitor_state_rules: {},
  custom_trigger_rules: {},
  compiled: { hash: "abc" },
};

describe("parseOnsiteTargeting", () => {
  it("reads status, priority and trigger type, and keeps the raw record", () => {
    const parsed = parseOnsiteTargeting(SERVER_TARGETING);
    expect(parsed).toMatchObject({
      status: "published",
      priority: 100,
      triggerType: "exit_intent",
    });
    expect(parsed?.rawRecord.url_rules).toEqual({ include: ["/pricing"] });
  });

  it("returns null for a shapeless payload", () => {
    expect(parseOnsiteTargeting(null)).toBeNull();
    expect(parseOnsiteTargeting([1])).toBeNull();
    expect(parseOnsiteTargeting("x")).toBeNull();
  });
});

describe("parseOnsiteExperiments / parseOnsiteSpinRewards", () => {
  it("reads the {items} envelopes and counts variants", () => {
    expect(
      parseOnsiteExperiments({
        items: [
          {
            key: "exp-1",
            name: "Headline test",
            status: "running",
            variants: [{ key: "a" }, { key: "b" }],
          },
          { key: "", name: "dropped" },
        ],
      }),
    ).toEqual([
      { key: "exp-1", name: "Headline test", status: "running", variantCount: 2 },
    ]);
    expect(
      parseOnsiteSpinRewards({
        items: [{ key: "r1", label: "10% off", status: "active" }],
      }),
    ).toEqual([{ key: "r1", label: "10% off", status: "active" }]);
  });

  it("returns [] for a non-envelope", () => {
    expect(parseOnsiteExperiments([])).toEqual([]);
    expect(parseOnsiteSpinRewards(undefined)).toEqual([]);
  });
});

describe("onsiteToggleVerb", () => {
  it("pauses a published popup, destructively", () => {
    expect(onsiteToggleVerb("published")).toMatchObject({
      target: "paused",
      label: "Pause popup",
      destructive: true,
    });
  });

  it("resumes paused and publishes draft", () => {
    expect(onsiteToggleVerb("paused")).toMatchObject({
      target: "published",
      label: "Resume popup",
    });
    expect(onsiteToggleVerb("draft")).toMatchObject({
      target: "published",
      label: "Publish popup",
    });
  });

  it("offers nothing on archived or unknown statuses", () => {
    expect(onsiteToggleVerb("archived")).toBeNull();
    expect(onsiteToggleVerb("retired")).toBeNull();
    expect(onsiteToggleVerb(undefined)).toBeNull();
  });
});

describe("buildTargetingStatusPut — the full-replace guard", () => {
  it("sends the WHOLE record back with only status changed", () => {
    const parsed = parseOnsiteTargeting(SERVER_TARGETING);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const body = buildTargetingStatusPut(parsed, "paused");
    // The upsert overwrites every column; dropping any of these maps would
    // erase targeting rules the phone never rendered.
    expect(body).toMatchObject({
      status: "paused",
      trigger: { type: "exit_intent", delay_seconds: 0 },
      audience: { segments: ["seg-9"] },
      url_rules: { include: ["/pricing"] },
      geo_rules: { countries: ["DE"] },
      priority: 100,
    });
  });
});

describe("role floor", () => {
  it("the PUT is admin per the routeauth manifest", () => {
    expect(ONSITE_TARGETING_WRITE_MINIMUM_ROLE).toBe("admin");
  });
});
