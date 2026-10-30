// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: {
    delete: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: mocks.post,
    postRaw: vi.fn(),
  },
}));

import { recordSmsConsent, type SmsConsentInput } from "@/lib/sms-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const DEMO_TENANT = "00000000-0000-0000-0000-000000000001";
const LIST = "33333333-3333-4333-8333-333333333333";
const PHONE = "+14155550123";

const revocation = (): SmsConsentInput => ({
  list_id: LIST,
  phone_e164: PHONE,
  action: "revoked",
  source: "manual",
  proof_text: "Operator safety request",
});

beforeEach(() => mocks.post.mockReset());

describe("web SMS consent revocation boundary", () => {
  it.each([
    ["granted", "carrier_resubscribe_authority_required", 409],
    ["imported", "invalid_consent_action", 400],
    ["help_requested", "invalid_consent_action", 400],
  ])(
    "holds action %s locally with zero network",
    async (action, code, status) => {
      await expect(
        Promise.resolve().then(() =>
          recordSmsConsent(
            { ...revocation(), action } as unknown as SmsConsentInput,
            TENANT,
          ),
        ),
      ).rejects.toMatchObject({ code, status });
      expect(mocks.post).not.toHaveBeenCalled();
    },
  );

  it("rejects proof-asset metadata and blank/unsafe reasons before network", async () => {
    for (const input of [
      { ...revocation(), metadata: { evidence_url: "https://private.test" } },
      { ...revocation(), proof_text: "   " },
      { ...revocation(), proof_text: "spoof\u202Ereason" },
      { ...revocation(), proof_text: "x".repeat(501) },
    ]) {
      await expect(
        Promise.resolve().then(() =>
          recordSmsConsent(input as unknown as SmsConsentInput, TENANT),
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("accepts the authoritative non-v4 tenant but keeps malformed tenants and list IDs local", async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      tenantId: DEMO_TENANT,
      phoneE164: PHONE,
      action: "revoked",
      source: "manual",
      provider: "product",
    });
    await expect(
      recordSmsConsent(revocation(), DEMO_TENANT),
    ).resolves.toMatchObject({ tenantId: DEMO_TENANT });

    expect(() => recordSmsConsent(revocation(), "tenant")).toThrow(
      /canonical lowercase tenant UUID/u,
    );
    await expect(
      Promise.resolve().then(() =>
        recordSmsConsent(
          {
            ...revocation(),
            list_id: "33333333-3333-1333-8333-333333333333",
          },
          DEMO_TENANT,
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_list_id", status: 400 });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("sends only the revocation body and strictly binds the success receipt", async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      tenantId: TENANT,
      phoneE164: PHONE,
      action: "revoked",
      source: "manual",
      provider: "product",
    });

    await expect(
      recordSmsConsent(
        { ...revocation(), proof_text: "  Operator safety request  " },
        TENANT,
      ),
    ).resolves.toMatchObject({ tenantId: TENANT, phoneE164: PHONE });
    expect(mocks.post).toHaveBeenCalledWith("/api/v1/sms/consent", {
      ...revocation(),
      proof_text: "Operator safety request",
    });

    mocks.post.mockResolvedValueOnce({
      ok: true,
      tenantId: "99999999-9999-4999-8999-999999999999",
      phoneE164: PHONE,
      action: "revoked",
      source: "manual",
      provider: "product",
    });
    await expect(recordSmsConsent(revocation(), TENANT)).rejects.toThrow(
      /Invalid SMS consent revocation receipt/u,
    );
  });
});
