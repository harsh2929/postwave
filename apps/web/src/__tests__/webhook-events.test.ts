import { describe, expect, it } from "vitest";

import { ALL_WEBHOOK_EVENTS } from "@/lib/webhooks-api";

describe("webhook event picker", () => {
  it("lists produced digest and lifecycle events without dead event names", () => {
    expect(ALL_WEBHOOK_EVENTS).toEqual(
      expect.arrayContaining([
        "subscriber.confirmed",
        "subscriber.deleted",
        "subscriber.consent_changed",
        "campaign.opens.digest",
        "campaign.clicks.digest",
        "sequence.generated",
        "approval.requested",
      ]),
    );
    expect(ALL_WEBHOOK_EVENTS).not.toEqual(
      expect.arrayContaining([
        "campaign.opened",
        "campaign.clicked",
        "automation.failed",
      ]),
    );
  });
});
