// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    delete: mocks.delete,
  },
}));

import { listOAuthIdentities, unlinkOAuthIdentity } from "@/lib/auth-api";

beforeEach(() => vi.clearAllMocks());

describe("linked identity security transport", () => {
  it("uses an online, one-attempt, abortable read and validates the envelope", async () => {
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValue({
      identities: [
        {
          provider: "google",
          email: "ada@example.test",
          linked_at: "2026-09-04T00:00:00Z",
        },
      ],
      has_password: true,
      has_passkey: false,
    });
    await expect(listOAuthIdentities({ signal })).resolves.toMatchObject({
      identities: [{ provider: "google" }],
    });
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/auth/oauth/identities",
      expect.objectContaining({
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal,
      }),
    );
  });

  it("rejects duplicate or malformed identity records instead of hiding them", async () => {
    const duplicate = {
      identities: [
        {
          provider: "google",
          email: "ada@example.test",
          linked_at: "2026-09-04T00:00:00Z",
        },
        {
          provider: "google",
          email: "other@example.test",
          linked_at: "2026-09-04T00:00:00Z",
        },
      ],
      has_password: true,
      has_passkey: false,
    };
    mocks.get.mockResolvedValue(duplicate);
    await expect(listOAuthIdentities()).rejects.toThrow(/invalid record/i);
  });

  it("encodes the provider and sends one stable, online-only unlink attempt", async () => {
    const signal = new AbortController().signal;
    mocks.delete.mockResolvedValue(undefined);
    await unlinkOAuthIdentity("google/root", {
      signal,
      idempotencyKey: "idem-1",
    });
    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/v1/auth/oauth/google%2Froot/link",
      expect.objectContaining({
        requireOnline: true,
        maxAttempts: 1,
        signal,
        idempotencyKey: "idem-1",
      }),
    );
  });
});
