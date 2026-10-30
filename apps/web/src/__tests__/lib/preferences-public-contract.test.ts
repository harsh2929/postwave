import { describe, expect, it } from "vitest";

import { decodePublicPreferenceLookup } from "@/lib/preferences-api";

const TENANT = "11111111-1111-4111-8111-111111111111";

function validLookup() {
  return {
    email: "reader@example.com",
    expiresAt: "2026-09-30T12:00:00Z",
    topics: [
      {
        topic: {
          id: "22222222-2222-4222-8222-222222222222",
          slug: "product-updates",
          name: "Product updates",
          description: "Important release notes.",
          defaultOptIn: true,
          displayOrder: 1,
        },
        optedIn: true,
      },
    ],
    frequencyPreference: "default",
    gpc: false,
    customization: {
      logo_url: "https://assets.example.com/logo.png",
      primary_color: "#123ABC",
      footer_text: "Subscriber controls",
      show_postwave_badge: false,
    },
  };
}

describe("public preference response contract", () => {
  it("accepts the exact bounded subscriber contract", () => {
    expect(decodePublicPreferenceLookup(validLookup())).toEqual(validLookup());
  });

  it.each([
    [
      "unsafe logo",
      (body: ReturnType<typeof validLookup>) => {
        body.customization.logo_url = "javascript:alert(1)";
      },
    ],
    [
      "unknown outer field",
      (body: ReturnType<typeof validLookup>) => {
        Object.assign(body, { tenantId: TENANT });
      },
    ],
    [
      "impossible timestamp",
      (body: ReturnType<typeof validLookup>) => {
        body.expiresAt = "2026-02-30T12:00:00Z";
      },
    ],
    [
      "internal tenant metadata",
      (body: ReturnType<typeof validLookup>) => {
        Object.assign(body.topics[0].topic, { tenantId: TENANT });
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const body = validLookup();
    mutate(body);
    expect(() => decodePublicPreferenceLookup(body)).toThrow();
  });

  it("preserves honest legacy pause state without inventing a deadline", () => {
    const body = validLookup();
    body.frequencyPreference = "paused";
    expect(decodePublicPreferenceLookup(body).pausedUntil).toBeUndefined();
  });
});
