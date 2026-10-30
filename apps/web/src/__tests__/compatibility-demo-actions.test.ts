// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAMPAIGN_BUILDER_ASSET,
  CAMPAIGN_BUILDER_SECTION,
  compatibilityDemoActionsEnabled,
  CREATIVE_ASSISTANT_DEMO_REQUEST,
  REPORT_SEED_EVENTS,
  TEMPLATE_PREVIEW_DEMO_REQUEST,
  VIDEO_CONVERSION_DEMO_REQUEST,
} from "../app/(dashboard)/app/compatibility/use-compatibility-demo-actions";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("compatibility demo action helpers", () => {
  it("fails closed in production even when the local demo flag is forged", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_COMPAT_DEMO_ACTIONS", "1");

    expect(compatibilityDemoActionsEnabled("owner")).toBe(false);
    expect(compatibilityDemoActionsEnabled("admin")).toBe(false);
  });

  it("requires both a local demo environment and an effective admin role", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_COMPAT_DEMO_ACTIONS", "1");

    expect(compatibilityDemoActionsEnabled("owner")).toBe(true);
    expect(compatibilityDemoActionsEnabled("admin")).toBe(true);
    expect(compatibilityDemoActionsEnabled("editor")).toBe(false);
    expect(compatibilityDemoActionsEnabled("viewer")).toBe(false);
    expect(compatibilityDemoActionsEnabled(null)).toBe(false);
  });

  it("keeps campaign-builder demo payloads representative", () => {
    expect(CAMPAIGN_BUILDER_ASSET).toMatchObject({
      asset_type: "image",
      name: "Launch hero",
      metadata: { source: "demo" },
    });
    expect(CAMPAIGN_BUILDER_SECTION.blocks).toEqual([
      { type: "heading", content: "A note from the founder" },
      {
        type: "text",
        content: "Here is what changed, why it matters, and what to do next.",
      },
    ]);
    expect(CAMPAIGN_BUILDER_SECTION.html).toContain("<h2>");
  });

  it("seeds a report with a realistic event progression", () => {
    expect(REPORT_SEED_EVENTS).toHaveLength(8);
    expect(REPORT_SEED_EVENTS.map((event) => event.event_type)).toEqual([
      "sent",
      "delivered",
      "opened",
      "clicked",
      "conversion",
      "sent",
      "delivered",
      "opened",
    ]);
    expect(REPORT_SEED_EVENTS[3]).toMatchObject({
      event_type: "clicked",
      link_url: "https://example.com/course",
    });
    expect(REPORT_SEED_EVENTS[4]).toMatchObject({
      event_type: "conversion",
      revenue_cents: 9900,
    });
  });

  it("keeps advanced demo requests scoped to the compatibility dashboard", () => {
    expect(CREATIVE_ASSISTANT_DEMO_REQUEST.context).toEqual({
      surface: "compatibility_dashboard",
    });
    expect(VIDEO_CONVERSION_DEMO_REQUEST).toMatchObject({
      title: "Migration walkthrough",
      cta: "Watch the migration walkthrough",
    });
    expect(TEMPLATE_PREVIEW_DEMO_REQUEST.html).toContain("*|FNAME|*");
    expect(TEMPLATE_PREVIEW_DEMO_REQUEST.html).toContain("*|UNSUB|*");
    expect(TEMPLATE_PREVIEW_DEMO_REQUEST.variables).toMatchObject({
      FNAME: "Maya",
      VIP: true,
    });
  });
});
