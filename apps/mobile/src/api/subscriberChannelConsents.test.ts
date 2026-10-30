/**
 * The channel-consent PATCH is the one mobile write whose safety lives in a
 * HEADER: channel_consents.go answers 428 unless it receives a strong
 * `If-Match` carrying the CURRENT subscriber version. A parser test cannot
 * see that, and a component test mocks the hook away — so this file pins the
 * transport itself with `rawRequest` mocked:
 *
 *  - the write is CONDITIONAL: a fresh version is read from the profile
 *    route immediately before the PATCH and sent as `If-Match`;
 *  - the body reaches the wire untouched (the evidence envelope is built by
 *    lib/subscriberConsentEvidence — this module must not edit it);
 *  - envelopes are unwrapped and `error` becomes a THROW, so a refused
 *    consent change can never look recorded;
 *  - a deployment that returns no version token refuses to write at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchChannelConsents,
  setChannelConsent,
} from "./subscriberChannelConsents";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

const BODY = {
  status: "opted_in",
  consent_source: "double_optin",
  consent_timestamp: "2026-08-29T10:00:00.000Z",
  evidence_channel: "mobile",
  legal_basis: "consent",
  evidence: "ticket #812",
  jurisdiction: "EU",
  reason: "asked on the support call",
  policy_version: "2026-05",
};

describe("GET /subscribers/{id}/channel-consents", () => {
  it("unwraps the envelope and returns the raw body for the lib parser", async () => {
    rawRequest.mockResolvedValue({
      data: { items: [{ channel: "sms", status: "opted_out" }] },
      error: null,
    });
    const body = await fetchChannelConsents("sub-1");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/subscribers/sub-1/channel-consents",
    );
    expect(body).toEqual({ items: [{ channel: "sms", status: "opted_out" }] });
  });

  it("surfaces the envelope error as a throw", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "not found" },
    });
    await expect(fetchChannelConsents("sub-1")).rejects.toThrow("not found");
  });
});

describe("PATCH /subscribers/{id}/channel-consents/{channel}", () => {
  it("reads a FRESH subscriber version and sends it as strong If-Match", async () => {
    rawRequest.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/api/v1/subscribers/sub-1") {
        return { data: { version: "v-42" }, error: null };
      }
      return { data: { subscriber_version: "v-43" }, error: null };
    });
    await setChannelConsent("sub-1", "sms", BODY);

    expect(rawRequest).toHaveBeenCalledTimes(2);
    // First the token read, THEN the conditional write.
    expect(rawRequest.mock.calls[0]?.[0]).toBe("GET");
    expect(rawRequest.mock.calls[1]).toEqual([
      "PATCH",
      "/api/v1/subscribers/sub-1/channel-consents/sms",
      BODY,
      { headers: { "If-Match": "v-42" } },
    ]);
  });

  it("accepts the {data:{version}} detail wrapper some deployments use", async () => {
    rawRequest.mockImplementation(async (method: string) =>
      method === "GET"
        ? { data: { data: { version: "v-7" } }, error: null }
        : { data: {}, error: null },
    );
    await setChannelConsent("sub-1", "email", BODY);
    expect(rawRequest.mock.calls[1]?.[3]).toEqual({
      headers: { "If-Match": "v-7" },
    });
  });

  it("REFUSES to write when the deployment returns no concurrency token", async () => {
    rawRequest.mockResolvedValue({ data: { id: "sub-1" }, error: null });
    await expect(setChannelConsent("sub-1", "sms", BODY)).rejects.toThrow(
      /concurrency token/,
    );
    // The PATCH was never issued — an unconditional consent write is worse
    // than no write.
    expect(
      rawRequest.mock.calls.filter((c) => c[0] === "PATCH"),
    ).toHaveLength(0);
  });

  it("surfaces a refused change (409 protected suppression) as a throw", async () => {
    rawRequest.mockImplementation(async (method: string) =>
      method === "GET"
        ? { data: { version: "v-1" }, error: null }
        : {
            data: null,
            error: {
              message:
                "this address has an active complaint, bounce, erasure, or separately reviewed suppression; resolve that hold before granting email consent",
            },
          },
    );
    await expect(setChannelConsent("sub-1", "email", BODY)).rejects.toThrow(
      /active complaint/,
    );
  });
});
