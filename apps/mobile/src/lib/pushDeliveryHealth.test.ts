import { describe, expect, it } from "vitest";

import {
  pushDeliveryCopy,
  pushDeliveryVerdict,
} from "./pushDeliveryHealth";

const REGISTERED = { registered: true, deliveryEnabled: true };

describe("pushDeliveryVerdict", () => {
  it("says nothing when the user has push switched off", () => {
    expect(
      pushDeliveryVerdict({ locallyEnabled: false, facts: REGISTERED }),
    ).toEqual({ kind: "off" });
  });

  it("confirms health only when the server says both things", () => {
    expect(
      pushDeliveryVerdict({ locallyEnabled: true, facts: REGISTERED }),
    ).toEqual({ kind: "healthy" });
  });

  it("catches the silent failure: switch on, server row gone", () => {
    expect(
      pushDeliveryVerdict({
        locallyEnabled: true,
        facts: { registered: false, deliveryEnabled: true },
      }),
    ).toEqual({ kind: "deregistered" });
  });

  it("blames the deployment before the device when the server cannot send", () => {
    expect(
      pushDeliveryVerdict({
        locallyEnabled: true,
        facts: { registered: false, deliveryEnabled: false },
      }),
    ).toEqual({ kind: "server_disabled" });
  });

  it("ABSENCE IS NOT ZERO — an unfetched status is unknown, never stopped", () => {
    expect(
      pushDeliveryVerdict({ locallyEnabled: true, facts: null }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("pushDeliveryCopy", () => {
  it("offers a retry only for the failure the user can actually fix", () => {
    const deregistered = pushDeliveryCopy({ kind: "deregistered" });
    expect(deregistered.offerRetry).toBe(true);
    expect(pushDeliveryCopy({ kind: "server_disabled" }).offerRetry).toBe(false);
    expect(pushDeliveryCopy({ kind: "unknown" }).offerRetry).toBe(false);
    expect(pushDeliveryCopy({ kind: "healthy" }).offerRetry).toBe(false);
  });

  it("carries a spoken state word for every visible verdict, not colour alone", () => {
    for (const kind of [
      "healthy",
      "deregistered",
      "server_disabled",
      "unknown",
    ] as const) {
      expect(pushDeliveryCopy({ kind }).state).not.toBe("");
    }
    expect(pushDeliveryCopy({ kind: "off" }).state).toBe("");
  });

  it("never claims delivery has stopped when the status is merely unknown", () => {
    const unknown = pushDeliveryCopy({ kind: "unknown" });
    expect(unknown.state).toBe("Not checked");
    expect(unknown.tone).toBe("neutral");
    expect(unknown.message.toLowerCase()).not.toContain("stopped");
  });
});
