// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    patch: mocks.patch,
    put: mocks.put,
  },
}));

import {
  getExportRetentionPolicy,
  getWebhookOwnerEmailPreference,
  parseExportRetentionPolicy,
  parseWebhookOwnerEmailPreference,
  sameExportRetentionRevision,
  sameWebhookPreferenceRevision,
  updateExportRetentionPolicy,
  updateWebhookOwnerEmailPreference,
} from "@/lib/workspace-settings-controls-api";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function exportPolicy(overrides: Record<string, unknown> = {}) {
  return {
    retention_days: 30,
    max_per_tenant: 20,
    current_storage_bytes: 1_024,
    updated_at: "2026-08-30 14:52:39.849236+05:30",
    ...overrides,
  };
}

function webhookPreference(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    notify_auto_disabled: true,
    notify_failure_rate: false,
    failure_rate_pct: 20,
    notify_latency: true,
    latency_ms: 5_000,
    last_alerted_at: null,
    updated_at: "2026-08-30T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("export retention settings client", () => {
  it("binds cancellation to reads and requires online no-retry fresh reads", async () => {
    const controller = new AbortController();
    mocks.get.mockResolvedValue(exportPolicy());

    await getExportRetentionPolicy({
      signal: controller.signal,
      fresh: true,
    });

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/exports/retention-policy",
      {
        signal: controller.signal,
        requireOnline: true,
        maxAttempts: 1,
        cache: "no-store",
      },
    );
  });

  it("sends only bounded policy fields and refuses offline replay", async () => {
    const controller = new AbortController();
    mocks.patch.mockResolvedValue(exportPolicy({
      retention_days: 45,
      max_per_tenant: 25,
    }));

    await updateExportRetentionPolicy(
      { retentionDays: 45, maxPerTenant: 25 },
      { signal: controller.signal },
    );

    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/v1/exports/retention-policy",
      { retention_days: 45, max_per_tenant: 25 },
      {
        signal: controller.signal,
        requireOnline: true,
        maxAttempts: 1,
      },
    );
  });

  it.each([
    ["fractional days", { retention_days: 7.5 }],
    ["days below the server floor", { retention_days: 6 }],
    ["cap above the server ceiling", { max_per_tenant: 501 }],
    ["negative storage", { current_storage_bytes: -1 }],
    ["unparseable revision", { updated_at: "not-a-time" }],
  ])("fails closed on %s", (_label, override) => {
    expect(() => parseExportRetentionPolicy(exportPolicy(override))).toThrow();
  });

  it("does not treat live storage recomputation as a policy conflict", () => {
    const baseline = parseExportRetentionPolicy(exportPolicy());
    const fresh = parseExportRetentionPolicy(
      exportPolicy({ current_storage_bytes: 9_999 }),
    );
    expect(sameExportRetentionRevision(baseline, fresh)).toBe(true);
    expect(
      sameExportRetentionRevision(
        baseline,
        parseExportRetentionPolicy(exportPolicy({ retention_days: 31 })),
      ),
    ).toBe(false);
  });
});

describe("webhook auto-pause owner email client", () => {
  it("strictly parses the current-user preference and binds abortable reads", async () => {
    const controller = new AbortController();
    mocks.get.mockResolvedValue(webhookPreference());

    await expect(
      getWebhookOwnerEmailPreference({ signal: controller.signal }),
    ).resolves.toMatchObject({
      userId: USER_ID,
      tenantId: TENANT_ID,
      notifyAutoDisabled: true,
    });
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/webhooks/alert-prefs",
      { signal: controller.signal },
    );
  });

  it("round-trips every replacement-only legacy field without IDs or timestamps", async () => {
    const preference = parseWebhookOwnerEmailPreference(webhookPreference());
    mocks.put.mockResolvedValue({ ok: true });

    await updateWebhookOwnerEmailPreference(preference, false);

    expect(mocks.put).toHaveBeenCalledWith(
      "/api/v1/webhooks/alert-prefs",
      {
        notify_auto_disabled: false,
        notify_failure_rate: false,
        failure_rate_pct: 20,
        notify_latency: true,
        latency_ms: 5_000,
      },
      {
        signal: undefined,
        requireOnline: true,
        maxAttempts: 1,
      },
    );
  });

  it.each([
    ["invalid user UUID", { user_id: "owner" }],
    ["missing auto-pause boolean", { notify_auto_disabled: undefined }],
    ["failure threshold out of range", { failure_rate_pct: 101 }],
    ["latency threshold out of range", { latency_ms: 0 }],
    ["oversized timestamp", { updated_at: "x".repeat(129) }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      parseWebhookOwnerEmailPreference(webhookPreference(override)),
    ).toThrow();
  });

  it("requires an explicit positive write acknowledgement", async () => {
    mocks.put.mockResolvedValue({ ok: false });
    const preference = parseWebhookOwnerEmailPreference(webhookPreference());
    await expect(
      updateWebhookOwnerEmailPreference(preference, false),
    ).rejects.toThrow(/acknowledgement\.ok/u);
  });

  it("compares all replacement fields but tolerates synthetic default timestamps", () => {
    const baseline = parseWebhookOwnerEmailPreference(webhookPreference());
    const sameDefaults = parseWebhookOwnerEmailPreference(
      webhookPreference({ updated_at: "2026-08-30T10:00:01Z" }),
    );
    expect(sameWebhookPreferenceRevision(baseline, sameDefaults)).toBe(true);
    expect(
      sameWebhookPreferenceRevision(
        baseline,
        parseWebhookOwnerEmailPreference(
          webhookPreference({ notify_latency: false }),
        ),
      ),
    ).toBe(false);
  });
});
