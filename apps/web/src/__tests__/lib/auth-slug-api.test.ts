// SPDX-License-Identifier: AGPL-3.0-only
//
// AUTH-015: the advisory workspace-slug availability probe. We assert the client
// encodes the slug into the query and forwards the abort signal (the debounce +
// stale-drop logic lives in the signup page's effect; the signal is how a stale
// request is cancelled).

import { afterEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: apiGet, post: apiPost },
  };
});

import { checkWorkspaceSlug, magicLinkConsume } from "@/lib/auth-api";

afterEach(() => vi.clearAllMocks());

describe("checkWorkspaceSlug", () => {
  it("builds an encoded query and returns the availability body", async () => {
    apiGet.mockResolvedValue({ available: true });
    const res = await checkWorkspaceSlug("acme co");
    expect(res.available).toBe(true);
    expect(apiGet).toHaveBeenCalledWith(
      "/api/v1/auth/slug-available?slug=acme%20co",
      expect.any(Object),
    );
  });

  it("forwards the abort signal so a stale probe can be cancelled", async () => {
    apiGet.mockResolvedValue({ available: false });
    const controller = new AbortController();
    await checkWorkspaceSlug("taken", { signal: controller.signal });
    expect(apiGet).toHaveBeenCalledWith(
      "/api/v1/auth/slug-available?slug=taken",
      { signal: controller.signal },
    );
  });
});

describe("magicLinkConsume", () => {
  it("submits a one-time proof once and fails fast on an authoritative response", async () => {
    apiPost.mockResolvedValue({ ok: true });
    const proof = {
      token: "one-time-token",
      link_version: 1 as const,
      link_flow: "magic" as const,
      link_audience: "web" as const,
      link_signature: "A".repeat(43),
    };

    await magicLinkConsume(proof);

    expect(apiPost).toHaveBeenCalledWith(
      "/api/v1/auth/magic-link/consume",
      proof,
      { maxAttempts: 1, requireOnline: true },
    );
  });
});
