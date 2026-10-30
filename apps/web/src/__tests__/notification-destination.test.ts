import { describe, expect, it } from "vitest";

import { notificationFeedDestination } from "@/lib/notification-destination";

describe("web notification destination", () => {
  it("uses the canonical SMS inbox route and discards server path PII", () => {
    const rawPhone = "+14155550123";
    expect(
      notificationFeedDestination({
        kind: "sms.received",
        deep_link: `/app/sms/${rawPhone}?body=private`,
      }),
    ).toBe("/app/sms?tab=inbox");
  });

  it("preserves the existing relative-link fallback for other topics", () => {
    expect(
      notificationFeedDestination({
        kind: "campaign.sent",
        deep_link: "/app/campaigns/campaign-1",
      }),
    ).toBe("/app/campaigns/campaign-1");
    expect(
      notificationFeedDestination({
        kind: "unknown",
        deep_link: "https://attacker.example/path",
      }),
    ).toBeNull();
  });
});
