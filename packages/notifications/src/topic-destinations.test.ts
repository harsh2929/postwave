import { describe, expect, it } from "vitest";

import {
  notificationTopicDestination,
  safeNotificationTopicLabel,
} from "./topic-destinations.js";

describe("content-light notification destinations", () => {
  it("maps an inbound SMS topic to each client's fixed list surface", () => {
    expect(notificationTopicDestination("sms.received", "mobile")).toBe(
      "/(tabs)/sms",
    );
    expect(notificationTopicDestination("sms.received", "desktop")).toBe(
      "smsInbox",
    );
    expect(notificationTopicDestination("sms.received", "web")).toBe(
      "/app/sms?tab=inbox",
    );
  });

  it("fails closed for unknown and malformed topics", () => {
    expect(
      notificationTopicDestination("sms.received.extra", "mobile"),
    ).toBeNull();
    expect(notificationTopicDestination(null, "web")).toBeNull();
  });

  it("never carries hostile phone or body values into navigation or telemetry", () => {
    const rawPhone = "+14155550123";
    const rawBody = "reset code 442991\u202e";
    const serverItem = {
      kind: "sms.received",
      body: rawBody,
      deep_link: `/app/sms?tab=inbox&phone=${encodeURIComponent(rawPhone)}`,
    };
    const output = {
      destination: notificationTopicDestination(serverItem.kind, "mobile"),
      telemetryTopic: safeNotificationTopicLabel(serverItem.kind),
    };

    expect(output).toEqual({
      destination: "/(tabs)/sms",
      telemetryTopic: "sms.received",
    });
    expect(JSON.stringify(output)).not.toContain(rawPhone);
    expect(JSON.stringify(output)).not.toContain(rawBody);
    expect(safeNotificationTopicLabel(`${rawPhone}:${rawBody}`)).toBe(
      "unknown",
    );
  });
});
