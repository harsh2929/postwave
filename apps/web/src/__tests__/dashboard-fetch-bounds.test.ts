// SPDX-License-Identifier: AGPL-3.0-only
//
// Bounds on what dashboard surfaces pull over the wire.
//
// Three distinct defects, one theme — a client asking for far more than it
// renders:
//   * `listCampaigns()` with no arguments falls through to the server's
//     500-row ceiling of FULL campaign documents (body_html, MJML, blocks) to
//     populate a <select> of id+name, or to test whether one campaign exists.
//   * The commerce events client sent `page`/`per_page`, which that handler
//     never reads (it is cursor-paginated on `limit`/`cursor`), so every caller
//     silently got the default 50 rows no matter what cap it asked for.
//   * discount history once walked an entire identity-bearing ledger for a
//     small dialog; the archive now requests one bounded, PII-free page.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { commerceApi } from "@/lib/commerce-api";
import { listDiscountRedemptionEvents } from "@/lib/discounts-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("commerce events pagination", () => {
  it("sends the cap the handler actually reads", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return Response.json({ items: [] });
      }),
    );

    await commerceApi.events("integration-1", { limit: 10 });

    expect(calls).toHaveLength(1);
    const query = new URL(calls[0]).searchParams;
    expect(query.get("limit")).toBe("10");
    // per_page is the parameter the server drops on the floor.
    expect(query.has("per_page")).toBe(false);
  });
});

describe("discount redemption event history", () => {
  const recordID = "11111111-2222-4333-8444-555555555555";
  const row = {
    redeemed_at: "2026-07-10T00:00:00Z",
    subscriber_linked: true,
  };

  it("requests one bounded page instead of walking the whole ledger", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return Response.json({ items: [row], has_more: false });
      }),
    );

    const page = await listDiscountRedemptionEvents(recordID, {
      limit: 25,
      offset: 0,
    });

    expect(page.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).searchParams.get("limit")).toBe("25");
  });

  it("rejects an oversized page before transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      listDiscountRedemptionEvents(recordID, { limit: 101, offset: 0 }),
    ).rejects.toThrow(/1 to 100/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const read = (rel: string): string =>
  readFileSync(path.join(process.cwd(), "src", rel), "utf8");

describe("campaign list calls are bounded", () => {
  // The dropdown and the "does any campaign exist?" probe both used the
  // argument-less form, which is the 500-row full-document ceiling.
  const CALLERS = [
    "app/(dashboard)/app/flows/_components/entity-picker.tsx",
    "app/(dashboard)/app/compatibility/compatibility-page-data.ts",
  ];

  for (const file of CALLERS) {
    it(`${file} passes an explicit bound`, () => {
      const source = read(file);
      expect(source).toContain("listCampaigns(");
      expect(source).not.toMatch(/listCampaigns\(\s*\)/);
    });
  }
});

describe("SMS tab panels are code-split", () => {
  const source = read("app/(dashboard)/app/sms/sms-workspace.tsx");
  // Radix mounts one panel at a time, but every card used to be a static
  // import, making this the largest page chunk in the build on the heaviest
  // route in the app.
  const LAZY_PANELS = [
    "./sms-lists-card",
    "./sms-consent-card",
    "./sms-suppressions-card",
    "./sms-keyword-responses-card",
    "./sms-consent-roster-card",
    "./sms-campaign-drafts-card",
    "./sms-sender-registration-card",
    "./sms-message-log-card",
    "./sms-test-send-card",
  ];

  for (const panel of LAZY_PANELS) {
    it(`${panel} arrives with its tab, not with the route`, () => {
      expect(source).toContain(`import("${panel}")`);
      // A value import of the same module would pull it back into the page
      // chunk; only `import type` may name it statically.
      const statik = new RegExp(
        `^import (?!type )[^;]*from "${panel.replace(".", "\\.")}";`,
        "m",
      );
      expect(source).not.toMatch(statik);
    });
  }

  it("keeps the default tab's section eager", () => {
    // Overview is what the route opens on; lazy-loading it would only add a
    // spinner to the first paint.
    expect(source).toMatch(
      /^import \{ SmsOverviewSection \} from ".\/sms-overview-section";$/m,
    );
  });
});
