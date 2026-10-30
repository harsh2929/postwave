// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const subscriberId = "subscriber-1";
const staleVersion = '"subscriber:subscriber-1:v1"';
const freshVersion = '"subscriber:subscriber-1:v2"';
const now = "2026-08-29T08:00:00Z";

const evidence = {
  status: "opted_in" as const,
  consent_source: "double_optin" as const,
  consent_timestamp: now,
  evidence_channel: "web" as const,
  legal_basis: "consent" as const,
  evidence: "Hosted confirmation receipt PW-1042",
  jurisdiction: "in",
  reason: "Subscriber confirmed this exact email address",
  policy_version: "privacy-2026-08",
};

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

function consent(version: string) {
  return {
    id: "consent-1",
    subscriber_id: subscriberId,
    subscriber_version: version,
    channel: "email",
    status: "opted_in",
    consent_source: "double_optin",
    consent_timestamp: now,
    created_at: now,
    updated_at: now,
  };
}

function list(version: string) {
  return { items: [consent(version)], subscriber_version: version };
}

function patchCalls() {
  return fetchMock.mock.calls.filter(
    ([, init]) =>
      ((init as RequestInit)?.method ?? "GET").toUpperCase() === "PATCH",
  );
}

describe("channel consent exact-state contract", () => {
  it("binds a consent write to the revision returned with the reviewed collection", async () => {
    const { getChannelConsents, updateChannelConsent } =
      await import("@/lib/subscriber-profile-api");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(list(staleVersion), staleVersion))
      .mockResolvedValueOnce(jsonResponse(consent(freshVersion), freshVersion));

    const reviewed = await getChannelConsents(subscriberId);
    await updateChannelConsent(
      subscriberId,
      "email",
      evidence,
      reviewed.subscriber_version,
      { idempotencyKey: "consent-write-1" },
    );

    const init = patchCalls()[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("If-Match")).toBe(staleVersion);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      "consent-write-1",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      ...evidence,
      jurisdiction: "IN",
    });
  });

  it("requires an explicit reread after a lost race instead of silently replaying a new decision", async () => {
    const { getChannelConsents, updateChannelConsent } =
      await import("@/lib/subscriber-profile-api");
    const newestVersion = '"subscriber:subscriber-1:v3"';
    fetchMock
      .mockResolvedValueOnce(jsonResponse(list(staleVersion), staleVersion))
      .mockResolvedValueOnce(
        jsonResponse({ error: "precondition_failed" }, undefined, 412),
      )
      .mockResolvedValueOnce(jsonResponse(list(freshVersion), freshVersion))
      .mockResolvedValueOnce(
        jsonResponse(consent(newestVersion), newestVersion),
      );

    const stale = await getChannelConsents(subscriberId);
    await expect(
      updateChannelConsent(
        subscriberId,
        "email",
        evidence,
        stale.subscriber_version,
        { idempotencyKey: "consent-write-race-1" },
      ),
    ).rejects.toMatchObject({ status: 412 });

    const reviewedAgain = await getChannelConsents(subscriberId);
    await updateChannelConsent(
      subscriberId,
      "email",
      evidence,
      reviewedAgain.subscriber_version,
      { idempotencyKey: "consent-write-race-2" },
    );

    expect(
      patchCalls().map(([_, init]) =>
        new Headers((init as RequestInit).headers).get("If-Match"),
      ),
    ).toEqual([staleVersion, freshVersion]);
  });

  it("rejects a mismatched body/header revision and unavailable channel write", async () => {
    const { getChannelConsents, updateChannelConsent } =
      await import("@/lib/subscriber-profile-api");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(list(staleVersion), freshVersion),
    );
    await expect(getChannelConsents(subscriberId)).rejects.toThrow(
      "invalid response",
    );

    await expect(
      updateChannelConsent(subscriberId, "sms", evidence, staleVersion, {
        idempotencyKey: "consent-write-2",
      }),
    ).rejects.toThrow("complete consent evidence");
    expect(patchCalls()).toHaveLength(0);
  });
});
