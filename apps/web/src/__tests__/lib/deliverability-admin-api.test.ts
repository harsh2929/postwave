// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  buildProviderConfigInput,
  createFrequencyCapRule,
  credentialReferenceError,
  deleteFrequencyCapRule,
  getBlocklistAutoSuppress,
  listDeliverabilityProviders,
  listFrequencyCapRules,
  sameFrequencyCapRevision,
  sameProviderRevision,
  saveDeliverabilityProvider,
  setBlocklistAutoSuppress,
  updateFrequencyCapRule,
  webhookTokenError,
} from "@/lib/deliverability-admin-api";

const TENANT = "11111111-1111-4111-8111-111111111111";

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    tenant_id: TENANT,
    provider: "sendgrid",
    display_name: "Production",
    config: {
      webhook_token_hash: "redacted",
      credential_ref: "deliverability/sendgrid",
    },
    active: true,
    created_at: "2026-08-30T10:00:00Z",
    updated_at: "2026-08-30T10:01:00Z",
    ...overrides,
  };
}

function cap(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    label: "Marketing",
    max_sends: 3,
    window_hours: 24,
    active: true,
    channels: ["email", "sms"],
    created_at: "2026-08-30T10:00:00Z",
    updated_at: "2026-08-30T10:01:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deliverability provider administration client", () => {
  it("strictly parses bounded rows and makes fresh reads online/no-retry", async () => {
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValue({ items: [provider()] });

    await expect(
      listDeliverabilityProviders({ signal, fresh: true }),
    ).resolves.toMatchObject([{ tenant_id: TENANT, provider: "sendgrid" }]);
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/deliverability/providers", {
      signal,
      requireOnline: true,
      maxAttempts: 1,
    });
  });

  it("uses the targeted PATCH contract for an existing row and validates its receipt", async () => {
    mocks.patch.mockResolvedValue({ item: provider({ active: false }) });
    await expect(
      saveDeliverabilityProvider(
        {
          provider: "sendgrid",
          display_name: "Production",
          config: {},
          active: false,
        },
        { id: provider().id as string },
      ),
    ).resolves.toMatchObject({ active: false });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/deliverability/providers/${provider().id}`,
      {
        provider: "sendgrid",
        display_name: "Production",
        config: {},
        active: false,
      },
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });

  it.each([
    ["unknown provider", { provider: "smtp" }],
    ["cross-shape config", { config: [] }],
    ["invalid timestamp", { updated_at: "today" }],
    ["oversized label", { display_name: "x".repeat(161) }],
  ])("fails closed on %s", async (_label, override) => {
    mocks.get.mockResolvedValue({ items: [provider(override)] });
    await expect(listDeliverabilityProviders()).rejects.toThrow(/invalid/i);
  });

  it("builds only sparse write-only config and rejects credential-looking references", () => {
    expect(
      buildProviderConfigInput({
        webhookToken: "redacted",
        credentialReference: "deliverability/sendgrid",
      }),
    ).toEqual({ credential_ref: "deliverability/sendgrid" });
    expect(credentialReferenceError("SG.not-a-reference")).toMatch(
      /do not paste/i,
    );
    expect(credentialReferenceError("deliverability/sendgrid")).toBeNull();
    expect(webhookTokenError("too-short")).toMatch(/32-512/u);
    expect(webhookTokenError("x".repeat(32))).toBeNull();
  });

  it("compares the server revision instead of volatile object identity", () => {
    const first = {
      ...provider(),
      provider: "sendgrid" as const,
    };
    const same = { ...first, config: { webhook_token_hash: "another-mask" } };
    expect(sameProviderRevision(first, same)).toBe(true);
    expect(
      sameProviderRevision(first, {
        ...same,
        updated_at: "2026-08-30T10:02:00Z",
      }),
    ).toBe(false);
  });
});

describe("blocklist containment client", () => {
  const state = {
    auto_suppress: false,
    eligible_now: 4,
    active_suppressions: 2,
    observed_at: "2026-08-30T10:00:00Z",
  };

  it("round-trips only the policy boolean and validates server impact", async () => {
    mocks.get.mockResolvedValue(state);
    mocks.patch.mockResolvedValue({ ...state, auto_suppress: true });
    await expect(getBlocklistAutoSuppress()).resolves.toEqual(state);
    await expect(setBlocklistAutoSuppress(true)).resolves.toMatchObject({
      auto_suppress: true,
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/v1/blocklist/auto-suppress",
      { auto_suppress: true },
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });

  it("rejects fractional/negative counts and malformed observations", async () => {
    mocks.get.mockResolvedValue({ ...state, eligible_now: 1.5 });
    await expect(getBlocklistAutoSuppress()).rejects.toThrow(/invalid/i);
    mocks.get.mockResolvedValue({ ...state, observed_at: "not-a-time" });
    await expect(getBlocklistAutoSuppress()).rejects.toThrow(/invalid/i);
  });
});

describe("canonical enforced frequency-cap client", () => {
  it("reads only the sending path and preserves legacy empty/global channels", async () => {
    mocks.get.mockResolvedValue({ rules: [cap({ channels: [] })] });
    await expect(listFrequencyCapRules()).resolves.toMatchObject([
      { channels: [] },
    ]);
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/sending/frequency-caps", {
      signal: undefined,
    });
  });

  it("sends the exact revision on PATCH and canonical 204 DELETE", async () => {
    const idempotencyKey = "01990a8f-4d90-7c11-8b72-3d2f2e598301";
    mocks.post.mockResolvedValue({ rule: cap() });
    mocks.patch.mockResolvedValue({
      rule: cap({
        label: "Transactional",
        updated_at: "2026-08-30T10:02:00Z",
      }),
    });
    mocks.delete.mockResolvedValue(undefined);
    await expect(
      createFrequencyCapRule(
        {
          label: "Marketing",
          max_sends: 3,
          window_hours: 24,
          active: true,
          channels: ["email", "sms"],
        },
        { idempotencyKey },
      ),
    ).resolves.toMatchObject({ label: "Marketing" });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/sending/frequency-caps",
      {
        label: "Marketing",
        max_sends: 3,
        window_hours: 24,
        active: true,
        channels: ["email", "sms"],
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey,
        signal: undefined,
      },
    );
    await expect(
      updateFrequencyCapRule(
        cap().id as string,
        { label: "Transactional" },
        cap().updated_at as string,
        { idempotencyKey },
      ),
    ).resolves.toMatchObject({ label: "Transactional" });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/sending/frequency-caps/${cap().id}`,
      {
        label: "Transactional",
        expected_updated_at: cap().updated_at,
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey,
        signal: undefined,
      },
    );
    await expect(
      deleteFrequencyCapRule(cap().id as string, cap().updated_at as string, {
        idempotencyKey,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.delete).toHaveBeenCalledWith(
      `/api/v1/sending/frequency-caps/${cap().id}`,
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey,
        signal: undefined,
        body: { expected_updated_at: cap().updated_at },
      },
    );
  });

  it.each([
    ["unknown channel", { channels: ["email", "fax"] }],
    ["duplicate channel", { channels: ["email", "email"] }],
    ["zero max", { max_sends: 0 }],
    ["oversized window", { window_hours: 721 }],
    ["missing revision", { updated_at: undefined }],
  ])("fails closed on %s", async (_label, override) => {
    mocks.get.mockResolvedValue({ rules: [cap(override)] });
    await expect(listFrequencyCapRules()).rejects.toThrow(/invalid/i);
  });

  it("rejects duplicate canonical rule IDs", async () => {
    mocks.get.mockResolvedValue({
      rules: [cap(), cap({ label: "Duplicate projection" })],
    });
    await expect(listFrequencyCapRules()).rejects.toThrow(/invalid/i);
  });

  it("compares the monotonic server revision", async () => {
    mocks.get.mockResolvedValue({ rules: [cap()] });
    const [baseline] = await listFrequencyCapRules();
    expect(baseline).toBeDefined();
    if (!baseline) return;
    expect(sameFrequencyCapRevision(baseline, { ...baseline })).toBe(true);
    expect(
      sameFrequencyCapRevision(baseline, {
        ...baseline,
        updated_at: "2026-08-30T10:02:00Z",
      }),
    ).toBe(false);
  });
});
