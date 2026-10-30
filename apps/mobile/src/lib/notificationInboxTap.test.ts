import { describe, expect, it, vi } from "vitest";

import { resolveNotificationTap } from "./notificationInboxTap";

/** A stand-in for lib/deepLinks' router-aware entity parser. */
const noEntity = () => null;

describe("resolveNotificationTap", () => {
  it("routes a content-light topic without touching its deep link", () => {
    const resolveEntityLink = vi.fn(() => "/(tabs)/should-not-be-used" as never);
    const result = resolveNotificationTap(
      {
        kind: "sms.received",
        // A real inbound-SMS link: a phone number and a message body in a WEB
        // path. It must never reach the URL parser.
        deep_link: "https://app.moosewave.com/app/sms?phone=%2B15551234567",
      },
      resolveEntityLink,
    );
    expect(result.route).toBe("/(tabs)/sms");
    expect(result.plan).toEqual({ kind: "in-app" });
    expect(resolveEntityLink).not.toHaveBeenCalled();
  });

  it("prefers a resolvable entity link over the event table", () => {
    const result = resolveNotificationTap(
      { kind: "campaign.sent", deep_link: "moosewave://campaigns/c-9" },
      (link) =>
        link === "moosewave://campaigns/c-9"
          ? ({ pathname: "/(tabs)/campaigns/[id]", params: { id: "c-9" } } as never)
          : null,
    );
    expect(result.route).toEqual({
      pathname: "/(tabs)/campaigns/[id]",
      params: { id: "c-9" },
    });
    expect(result.plan).toEqual({ kind: "in-app" });
  });

  it("reaches the operational event table the inbox used to miss", () => {
    // `webhook.auto_disabled` is not in the topic table and carries no entity
    // link, so before the four-grammar resolution this row was a dead tap in
    // the bell while the same push routed correctly.
    const result = resolveNotificationTap(
      { kind: "webhook.auto_disabled" },
      noEntity,
    );
    expect(result.route).not.toBeNull();
    expect(result.plan).toEqual({ kind: "in-app" });
  });

  it("reads the entity id off the payload for a detail arm", () => {
    const result = resolveNotificationTap(
      { kind: "subscriber.bounced", payload: { entity_id: "s-42" } },
      noEntity,
    );
    expect(result.route).toEqual({
      pathname: "/(tabs)/subscribers/[id]",
      params: { id: "s-42" },
    });
  });

  it("prefers event_type over kind when the two disagree", () => {
    // The fanout only falls back to `ev.Type` for `kind`, so the two coincide
    // for some rows and not others — which is why the explicit event name wins.
    const result = resolveNotificationTap(
      { kind: "generic", event_type: "approval.requested" },
      noEntity,
    );
    expect(result.route).toBe("/(tabs)/approvals");
  });

  it("offers the web admin when nothing resolves in-app", () => {
    const result = resolveNotificationTap(
      {
        kind: "something.unmapped",
        deep_link: "https://app.moosewave.com/app/reports/17",
      },
      noEntity,
    );
    expect(result.route).toBeNull();
    expect(result.plan).toEqual({
      kind: "web",
      url: "https://app.moosewave.com/app/reports/17",
    });
  });

  it("refuses a foreign host rather than opening it", () => {
    const result = resolveNotificationTap(
      { kind: "something.unmapped", deep_link: "https://evil.example/app/x" },
      noEntity,
    );
    expect(result.plan).toEqual({ kind: "unsupported" });
  });

  it("calls a link-less unknown row inert rather than broken", () => {
    const result = resolveNotificationTap({ kind: "something.unmapped" }, noEntity);
    expect(result.route).toBeNull();
    expect(result.plan).toEqual({ kind: "none" });
  });
});

describe("resolveNotificationTap telemetry", () => {
  it("reports the topic, whether a link was carried, and the outcome", () => {
    expect(
      resolveNotificationTap({ kind: "sms.received" }, noEntity).telemetry,
    ).toEqual({
      kind: "sms.received",
      had_deep_link: false,
      resolved: "in-app",
    });
  });

  it("collapses an unknown kind to a constant label", () => {
    // An unrecognised `kind` may carry customer content (a phone number, a
    // message body); analytics must never receive it verbatim.
    const result = resolveNotificationTap(
      { kind: "+15551234567:hello there", deep_link: "https://evil.example/x" },
      noEntity,
    );
    expect(result.telemetry.kind).toBe("unknown");
    expect(result.telemetry).toEqual({
      kind: "unknown",
      had_deep_link: true,
      resolved: "unsupported",
    });
  });
});
