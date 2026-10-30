// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

import {
  getFirewallSettings,
  listFirewallEvents,
  parseFirewallEvents,
  parseFirewallSettings,
  parseFirewallStats,
  runFirewallSurgeDetection,
  updateFirewallSettings,
} from "@/lib/signup-protection-api";

const TENANT = "018f0000-0000-7000-8000-000000000001";
const UPDATED = "2026-08-30T10:00:00Z";

function settings() {
  return {
    tenant_id: TENANT,
    attack_mode_enabled: false,
    auto_attack_mode: true,
    fingerprint_required: false,
    attack_mode_threshold: 50,
    surge_multiplier: 5,
    surge_min_per_hour: 50,
    attack_mode_auto_enabled_at: null,
    attack_mode_auto_cooldown_until: null,
    updated_at: UPDATED,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("signup firewall evidence contracts", () => {
  it("rejects impossible decision totals instead of turning drift into zero", () => {
    expect(
      parseFirewallStats({
        last_24h: { observed: 10, accepted: 6, rejected: 3 },
        last_7d: { observed: 20, accepted: 12, rejected: 8 },
      }).last_24h,
    ).toEqual({ observed: 10, accepted: 6, rejected: 3 });
    expect(() =>
      parseFirewallStats({
        last_24h: { observed: 5, accepted: 4, rejected: 2 },
        last_7d: { observed: 20, accepted: 12, rejected: 8 },
      }),
    ).toThrow(/reconcile/iu);
  });

  it("binds settings to the expected workspace and strips tenant identity", () => {
    const parsed = parseFirewallSettings(settings(), TENANT);
    expect(parsed.attack_mode_threshold).toBe(50);
    expect(Object.keys(parsed)).not.toContain("tenant_id");
    expect(() =>
      parseFirewallSettings(settings(), "another-workspace"),
    ).toThrow(/another workspace/iu);
  });

  it("retains decision evidence but drops IP and user-agent PII", () => {
    const parsed = parseFirewallEvents({
      events: [
        {
          id: "018f0000-0000-7000-8000-000000000002",
          form_id: "018f0000-0000-7000-8000-000000000003",
          risk_score: 70,
          action: "rejected",
          at: UPDATED,
          ip: "203.0.113.10",
          user_agent: "Private browser fingerprint",
        },
      ],
      count: 1,
    });
    expect(parsed.events[0]).toEqual({
      id: "018f0000-0000-7000-8000-000000000002",
      formId: "018f0000-0000-7000-8000-000000000003",
      riskScore: 70,
      action: "rejected",
      at: UPDATED,
    });
    expect(JSON.stringify(parsed)).not.toMatch(/203\.0\.113|fingerprint/iu);
  });
});

describe("signup firewall request contracts", () => {
  it("forwards cancellation and validates the tenant on reads", async () => {
    const controller = new AbortController();
    mocks.get.mockResolvedValueOnce(settings()).mockResolvedValueOnce({
      events: [],
      count: 0,
    });
    await getFirewallSettings({ tenantId: TENANT, signal: controller.signal });
    await listFirewallEvents({ limit: 20, signal: controller.signal });
    expect(mocks.get).toHaveBeenNthCalledWith(1, "/api/v1/firewall/settings", {
      signal: controller.signal,
    });
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/firewall/events?limit=20",
      { signal: controller.signal },
    );
  });

  it("sends only a validated partial policy with fire-once semantics", async () => {
    mocks.put.mockResolvedValueOnce({
      ...settings(),
      attack_mode_threshold: 60,
    });
    await expect(
      updateFirewallSettings({ attack_mode_threshold: 60 }, TENANT),
    ).resolves.toMatchObject({ attack_mode_threshold: 60 });
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/v1/firewall/settings",
      { attack_mode_threshold: 60 },
      { requireOnline: true, maxAttempts: 1 },
    );
    await expect(
      updateFirewallSettings({ surge_multiplier: 1 }, TENANT),
    ).rejects.toThrow(/multiplier/iu);
  });

  it("preserves a completed no-flip detector result", async () => {
    mocks.post.mockResolvedValueOnce({ flipped: false });
    await expect(runFirewallSurgeDetection()).resolves.toEqual({
      flipped: false,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/firewall/detect",
      {},
      { requireOnline: true, maxAttempts: 1 },
    );
  });
});
