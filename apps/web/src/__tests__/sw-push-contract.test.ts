// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  resolveNotificationClickPath,
  resolveSameOriginNotificationTarget,
} from "@/app/sw-notification-routing";

describe("service-worker push URL contract", () => {
  it("keeps relative sender paths", () => {
    expect(
      resolveNotificationClickPath({
        url: "/app/campaigns/cmp_123?tab=report",
      }),
    ).toBe("/app/campaigns/cmp_123?tab=report");
  });

  it("converts deployment URLs to same-origin paths", () => {
    expect(
      resolveNotificationClickPath({
        url: "https://staging.moosewave.com/app/subscribers/sub_9#activity",
      }),
    ).toBe("/app/subscribers/sub_9#activity");
  });

  it("falls back home for absent, malformed, or non-http URLs", () => {
    expect(resolveNotificationClickPath({})).toBe("/app");
    expect(resolveNotificationClickPath({ url: "not a url" })).toBe("/app");
    expect(resolveNotificationClickPath({ url: "javascript:alert(1)" })).toBe(
      "/app",
    );
  });

  it.each([
    "//attacker.example/steal",
    "/\\attacker.example/steal",
    "/app\n/steal",
    " https://attacker.example/steal",
    `/${"a".repeat(2_049)}`,
    "https://user:password@example.com/app",
  ])("rejects hostile click URL %j", (url) => {
    expect(resolveNotificationClickPath({ url })).toBe("/app");
  });

  it("enforces same-origin navigation again at the open-window boundary", () => {
    const origin = "https://app.moosewave.com";

    expect(
      resolveSameOriginNotificationTarget(
        "/app/campaigns/cmp_123?tab=report",
        origin,
      ),
    ).toBe("https://app.moosewave.com/app/campaigns/cmp_123?tab=report");
    expect(
      resolveSameOriginNotificationTarget("//attacker.example/steal", origin),
    ).toBe("https://app.moosewave.com/app");
    expect(
      resolveSameOriginNotificationTarget("/\\attacker.example/steal", origin),
    ).toBe("https://app.moosewave.com/app");
  });
});
