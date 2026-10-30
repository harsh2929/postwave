import { describe, expect, it } from "vitest";

import {
  lifecycleSpokenLabel,
  lifecycleStageLabel,
  parseSubscriberLifecycle,
} from "./subscriberLifecycle";

describe("parseSubscriberLifecycle", () => {
  it("reads the projection", () => {
    expect(
      parseSubscriberLifecycle({
        subscriber_id: "s1",
        tenant_id: "t1",
        stage: "customer",
        score: 5,
        updated_at: "2026-07-01T00:00:00Z",
        subscriber_version: "v1",
      }),
    ).toEqual({
      stage: "customer",
      score: 5,
      updatedAt: "2026-07-01T00:00:00Z",
    });
  });

  it("defaults a missing score to the server's own default of 3", () => {
    expect(parseSubscriberLifecycle({ stage: "lead" })?.score).toBe(3);
  });

  it("clamps an out-of-range score rather than rendering it", () => {
    expect(parseSubscriberLifecycle({ stage: "lead", score: 9 })?.score).toBe(5);
    expect(parseSubscriberLifecycle({ stage: "lead", score: 0 })?.score).toBe(1);
  });

  it("is null when the stage is missing or unrecognised", () => {
    expect(parseSubscriberLifecycle({ score: 3 })).toBeNull();
    expect(parseSubscriberLifecycle({ stage: "vip" })).toBeNull();
    expect(parseSubscriberLifecycle(null)).toBeNull();
    expect(parseSubscriberLifecycle([])).toBeNull();
  });
});

describe("lifecycleStageLabel", () => {
  it("keeps acronyms upper-case", () => {
    expect(lifecycleStageLabel("mql")).toBe("MQL");
    expect(lifecycleStageLabel("sql")).toBe("SQL");
  });

  it("title-cases the rest", () => {
    expect(lifecycleStageLabel("evangelist")).toBe("Evangelist");
  });
});

describe("lifecycleSpokenLabel", () => {
  it("gives the score its scale", () => {
    expect(
      lifecycleSpokenLabel({ stage: "mql", score: 4, updatedAt: "" }),
    ).toBe("Lifecycle stage: MQL. Score 4 out of 5.");
  });
});
