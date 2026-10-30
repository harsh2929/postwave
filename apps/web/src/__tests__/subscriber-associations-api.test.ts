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
  createSubscriberFederationLink,
  deleteSubscriberFederationLink,
  listSubscriberAccounts,
  listSubscriberFederationLinks,
  setSubscriberAccountLink,
} from "@/lib/subscriber-associations-api";

const subscriberId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const linkId = "44444444-4444-4444-8444-444444444444";
const parentTenantId = "55555555-5555-4555-8555-555555555555";
const masterId = "66666666-6666-4666-8666-666666666666";
const v1 = `"subscriber:${subscriberId}:v1"`;
const v2 = `"subscriber:${subscriberId}:v2"`;
const now = "2026-08-29T08:00:00Z";

function emitEtag(options: unknown, etag: string): void {
  const callback = (options as { onResponse?: (response: Response) => void })
    ?.onResponse;
  callback?.(new Response(null, { headers: { ETag: etag } }));
}

function link(version = v2) {
  return {
    id: linkId,
    child_subscriber_id: subscriberId,
    parent_tenant_id: parentTenantId,
    master_subscriber_id: masterId,
    match_type: "manual",
    match_key: "Ticket PW-1042",
    created_at: now,
    updated_at: now,
    subscriber_version: version,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("subscriber association API contracts", () => {
  it("tenant-binds and validates the account directory", async () => {
    mocks.get.mockResolvedValue({
      items: [
        {
          id: accountId,
          tenant_id: tenantId,
          name: "Acme",
          industry: "Software",
          country: "US",
          metadata: {},
          created_at: now,
          updated_at: now,
        },
      ],
      total: 1,
    });

    await expect(listSubscriberAccounts(tenantId)).resolves.toHaveLength(1);
    mocks.get.mockResolvedValueOnce({
      items: [
        {
          id: accountId,
          tenant_id: parentTenantId,
          name: "Wrong tenant",
          industry: "",
          country: "",
          metadata: {},
          created_at: now,
          updated_at: now,
        },
      ],
      total: 1,
    });
    await expect(listSubscriberAccounts(tenantId)).rejects.toThrow("invalid");
  });

  it("links an account with one exact parent revision and validates the fresh revision", async () => {
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, v2);
      return {
        id: subscriberId,
        email: "ada@example.test",
        status: "enabled",
        consent_timestamp: null,
        consent_source: "unknown",
        custom_fields: {},
        tags: [],
        account_id: accountId,
        version: v2,
      };
    });

    await setSubscriberAccountLink(subscriberId, accountId, v1, {
      idempotencyKey: "subscriber-profile:account-link-0001",
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${subscriberId}/account`,
      { account_id: accountId },
      expect.objectContaining({
        headers: { "If-Match": v1 },
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
  });

  it("binds federation reads to the matching child revision and ETag", async () => {
    mocks.get.mockImplementation(async (_path, options) => {
      emitEtag(options, v1);
      return { items: [link(v1)], subscriber_version: v1 };
    });
    await expect(listSubscriberFederationLinks(subscriberId)).resolves.toEqual({
      items: [link(v1)],
      subscriber_version: v1,
    });

    mocks.get.mockImplementationOnce(async (_path, options) => {
      emitEtag(options, v2);
      return { items: [link(v1)], subscriber_version: v1 };
    });
    await expect(listSubscriberFederationLinks(subscriberId)).rejects.toThrow(
      "invalid",
    );
  });

  it("uses exact online federation writes and verifies their fresh child revision", async () => {
    mocks.post.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, v2);
      return link(v2);
    });
    await createSubscriberFederationLink(
      subscriberId,
      {
        parent_tenant_id: parentTenantId,
        master_subscriber_id: masterId,
        match_type: "manual",
        match_key: " Ticket PW-1042 ",
      },
      v1,
      { idempotencyKey: "subscriber-profile:federation-add-0001" },
    );
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/subscribers/${subscriberId}/federated-links`,
      expect.objectContaining({ match_key: "Ticket PW-1042" }),
      expect.objectContaining({
        headers: { "If-Match": v1 },
        maxAttempts: 1,
        requireOnline: true,
      }),
    );

    mocks.delete.mockImplementation(async (_path, options) => {
      emitEtag(options, v2);
      return { deleted: true, subscriber_version: v2 };
    });
    await expect(
      deleteSubscriberFederationLink(subscriberId, masterId, v1, {
        idempotencyKey: "subscriber-profile:federation-delete-0001",
      }),
    ).resolves.toBe(v2);
  });
});
