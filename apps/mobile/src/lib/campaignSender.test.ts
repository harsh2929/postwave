import { describe, expect, it } from "vitest";

import {
  campaignFromEmail,
  campaignFromLine,
  campaignReplyTo,
} from "./campaignSender";

describe("campaignFromEmail", () => {
  it("reads delivery_settings.from_email — where the gateway actually puts it", () => {
    // The regression this module exists for: the screen read a top-level
    // `from_email` that the Go struct has never had, so the From line was
    // permanently absent.
    expect(
      campaignFromEmail({ delivery_settings: { from_email: "hi@acme.com" } }),
    ).toBe("hi@acme.com");
  });

  it("accepts a top-level alias for forward compatibility", () => {
    expect(campaignFromEmail({ from_email: "hi@acme.com" })).toBe("hi@acme.com");
  });

  it("prefers delivery_settings when both are present", () => {
    expect(
      campaignFromEmail({
        from_email: "stale@acme.com",
        delivery_settings: { from_email: "live@acme.com" },
      }),
    ).toBe("live@acme.com");
  });

  it("is null when the campaign inherits the workspace default", () => {
    expect(campaignFromEmail({})).toBeNull();
    expect(campaignFromEmail({ delivery_settings: {} })).toBeNull();
    expect(campaignFromEmail({ delivery_settings: { from_email: "   " } })).toBeNull();
    expect(campaignFromEmail({ delivery_settings: "not-an-object" })).toBeNull();
    expect(campaignFromEmail(null)).toBeNull();
  });
});

describe("campaignFromLine", () => {
  it("composes name and address", () => {
    expect(
      campaignFromLine({
        from_name: "Acme",
        delivery_settings: { from_email: "hi@acme.com" },
      }),
    ).toBe("Acme <hi@acme.com>");
  });

  it("renders whichever half exists", () => {
    expect(campaignFromLine({ delivery_settings: { from_email: "hi@acme.com" } })).toBe(
      "hi@acme.com",
    );
    expect(campaignFromLine({ from_name: "Acme" })).toBe("Acme");
  });

  it("is null when neither half is set, so no empty label renders", () => {
    expect(campaignFromLine({})).toBeNull();
    expect(campaignFromLine({ from_name: "  " })).toBeNull();
  });
});

describe("campaignReplyTo", () => {
  it("is null when reply-to just repeats the From address", () => {
    expect(
      campaignReplyTo({
        reply_to: "HI@acme.com",
        delivery_settings: { from_email: "hi@acme.com" },
      }),
    ).toBeNull();
  });

  it("surfaces a genuinely different reply-to", () => {
    expect(
      campaignReplyTo({
        reply_to: "support@acme.com",
        delivery_settings: { from_email: "hi@acme.com" },
      }),
    ).toBe("support@acme.com");
  });

  it("is null when unset", () => {
    expect(campaignReplyTo({})).toBeNull();
  });
});
