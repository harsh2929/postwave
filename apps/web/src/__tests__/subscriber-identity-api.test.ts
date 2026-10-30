// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  addSubscriberEmail,
  getSubscriberLifecycle,
  listSubscriberAliases,
  setSubscriberEmailSuppression,
  updateSubscriberEmailConsent,
  type SubscriberEmailAddress,
} from "@/lib/subscriber-identity-api";

const subscriberId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const aliasId = "33333333-3333-4333-8333-333333333333";
const addressId = "44444444-4444-4444-8444-444444444444";
const parentVersion = `"subscriber:${subscriberId}:v1"`;
const addressVersion = `"subscriber-email:${addressId}:v1"`;
const now = "2026-08-29T08:00:00Z";

function emitEtag(options: unknown, etag: string): void {
  const onResponse = (options as { onResponse?: (response: Response) => void })
    ?.onResponse;
  onResponse?.(new Response(null, { headers: { ETag: etag } }));
}

function address(
  overrides: Partial<SubscriberEmailAddress> = {},
): SubscriberEmailAddress {
  return {
    id: addressId,
    subscriber_id: subscriberId,
    email: "ada@example.com",
    is_primary: false,
    consent_status: "never_subscribed",
    suppressed: false,
    created_at: now,
    updated_at: now,
    version: addressVersion,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("subscriber identity API contracts", () => {
  it("binds the alias collection to its parent ETag and subscriber identity", async () => {
    mocks.get.mockImplementation(async (_path, options) => {
      emitEtag(options, parentVersion);
      return {
        items: [
          {
            id: aliasId,
            subscriber_id: subscriberId,
            alias_type: "external_id",
            alias_value: "crm-1042",
            confidence: 1,
            source: "operator",
            provenance: { surface: "web_subscriber_profile" },
            first_seen_at: now,
            last_seen_at: now,
            created_at: now,
            updated_at: now,
          },
        ],
        subscriber_version: parentVersion,
      };
    });

    const result = await listSubscriberAliases(subscriberId);
    expect(result.subscriber_version).toBe(parentVersion);
    expect(result.items[0]).toMatchObject({
      id: aliasId,
      subscriber_id: subscriberId,
      alias_value: "crm-1042",
    });
  });

  it("attaches an address with one exact parent revision and verifies the address revision", async () => {
    const freshAddressVersion = `"subscriber-email:${addressId}:v2"`;
    mocks.post.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshAddressVersion);
      return address({
        email: "alternate@example.com",
        version: freshAddressVersion,
      });
    });

    await addSubscriberEmail(
      subscriberId,
      " Alternate@Example.com ",
      parentVersion,
      { idempotencyKey: "subscriber-profile:email-add-0001" },
    );

    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/subscribers/${subscriberId}/emails`,
      { email: "alternate@example.com", is_primary: false },
      expect.objectContaining({
        headers: { "If-Match": parentVersion },
        idempotencyKey: "subscriber-profile:email-add-0001",
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
  });

  it("sends the operator's reviewed suppression evidence without fabricating it", async () => {
    const freshAddressVersion = `"subscriber-email:${addressId}:v2"`;
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshAddressVersion);
      return address({ suppressed: true, version: freshAddressVersion });
    });

    await setSubscriberEmailSuppression(
      subscriberId,
      address(),
      {
        suppressed: true,
        reason: " Hard bounce trace reviewed ",
        evidence: " Provider trace PW-1042 ",
      },
      { idempotencyKey: "subscriber-profile:suppress-0001" },
    );

    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${subscriberId}/emails/${addressId}`,
      {
        suppressed: true,
        suppression_reason: "Hard bounce trace reviewed",
        suppression_evidence: "Provider trace PW-1042",
      },
      expect.objectContaining({
        headers: { "If-Match": addressVersion },
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
  });

  it("rejects an address from another subscriber before issuing a consent write", async () => {
    await expect(
      updateSubscriberEmailConsent(
        subscriberId,
        address({
          subscriber_id: "55555555-5555-4555-8555-555555555555",
        }),
        {
          consent_status: "subscribed",
          source: "double_optin",
          channel: "email",
          legal_basis: "consent",
          occurred_at: now,
          jurisdiction: "GB",
          evidence: "Receipt PW-1042",
          reason: "Exact address confirmed",
          policy_version: "privacy-2026-08",
        },
        { idempotencyKey: "subscriber-profile:consent-0001" },
      ),
    ).rejects.toThrow("Reload this address");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("rejects a lifecycle response whose tenant identity or ETag changed", async () => {
    mocks.get.mockImplementation(async (_path, options) => {
      emitEtag(options, parentVersion);
      return {
        subscriber_id: subscriberId,
        tenant_id: "66666666-6666-4666-8666-666666666666",
        stage: "lead",
        score: 3,
        updated_at: now,
        transition_sequence: 1,
        subscriber_version: parentVersion,
      };
    });

    await expect(
      getSubscriberLifecycle(subscriberId, tenantId),
    ).rejects.toThrow("invalid");
  });
});
