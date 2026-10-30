// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign concurrency tokens: what the client CAN and CANNOT do.
//
// An earlier version of this file asserted that a save carried an `If-Match`
// header and called that "a campaign save must never be an unconditional
// overwrite". Those are different claims. The implementation it was written
// against fetched an ETag AT SAVE TIME — a token describing the server's
// current state, including the concurrent edit it was about to destroy — so the
// header was present and the write still lost data. An adversarial review
// demonstrated exactly that against a server mock that honours If-Match.
//
// These assert the honest properties instead: a token captured WITH the content
// is used, a dead token is discarded so the editor can recover, and the client
// does not manufacture a token it does not have.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, etag?: string, status = 200): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (etag) headers.set("ETag", etag);
  return new Response(JSON.stringify(body), { status, headers });
}

describe("campaign concurrency tokens", () => {
  it("sends the token captured with the content the editor loaded", async () => {
    const { getCampaign, updateCampaign } = await import("@/lib/campaigns-api");

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "c1", name: "Before" }, '"v1"'))
      .mockResolvedValueOnce(jsonResponse({ id: "c1", name: "After" }, '"v2"'));

    await getCampaign("c1");
    await updateCampaign("c1", { name: "After" });

    const [, patchInit] = fetchMock.mock.calls[1]!;
    expect(new Headers((patchInit as RequestInit).headers).get("If-Match")).toBe('"v1"');
  });

  it("does NOT manufacture a token when it has none", async () => {
    // The withdrawn behaviour. Fetching one here would describe the server's
    // CURRENT state — the very edit about to be overwritten — so the
    // precondition would pass by construction and the save would still lose
    // data while looking protected. Exactly one request must go out.
    const { updateCampaign } = await import("@/lib/campaigns-api");

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "c2", name: "After" }, '"v2"'));

    await updateCampaign("c2", { name: "After" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, patchInit] = fetchMock.mock.calls[0]!;
    expect(new Headers((patchInit as RequestInit).headers).get("If-Match")).toBeNull();
  });

  it("discards a token the server rejected, so a retry is not doomed", async () => {
    // `api.patch` runs onResponse BEFORE checking res.ok, and a 412 carries no
    // ETag — so a naive capture left the dead token cached and every retry
    // resent it. The editor could never recover, and the campaigns UI has no
    // 412 handling to explain why.
    const { getCampaign, updateCampaign } = await import("@/lib/campaigns-api");

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "c3", name: "Before" }, '"stale"'))
      .mockResolvedValueOnce(jsonResponse({ error: "precondition" }, undefined, 412))
      .mockResolvedValueOnce(jsonResponse({ id: "c3", name: "After" }, '"fresh"'));

    await getCampaign("c3");
    await updateCampaign("c3", { name: "After" }).catch(() => {});
    await updateCampaign("c3", { name: "After" }).catch(() => {});

    const [, retryInit] = fetchMock.mock.calls[2]!;
    expect(new Headers((retryInit as RequestInit).headers).get("If-Match")).not.toBe('"stale"');
  });
});
