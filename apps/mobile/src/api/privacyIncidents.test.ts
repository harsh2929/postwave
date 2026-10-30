/**
 * The transport seam of the breach-register WRITES.
 *
 * `__tests__/privacy-incidents.native.test.tsx` mocks the hooks outright, and
 * `lib/privacyIncidentWrite.test.ts` drives the pure policy — neither proves
 * that a declare actually carries its Idempotency-Key or that a transition
 * asserts `expected_from`. Those two request properties ARE the safety
 * features (duplicate-record protection and stale-state conflict detection),
 * so this file asserts them against `rawRequest` itself, the way
 * api/audienceDestinations.test.ts does for reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPrivacyIncident,
  PrivacyIncidentError,
  transitionPrivacyIncident,
} from "./privacyIncidents";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("createPrivacyIncident (declare)", () => {
  it("POSTs severity+summary WITH the caller's Idempotency-Key", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "inc-9", status: "open", severity: "high" },
      error: null,
    });
    const incident = await createPrivacyIncident(
      { severity: "high", summary: "Export bucket left public." },
      "declare-key-1",
    );
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/privacy/incidents",
      { severity: "high", summary: "Export bucket left public." },
      { idempotencyKey: "declare-key-1" },
    );
    expect(incident.id).toBe("inc-9");
  });

  it("refuses to send a declare without an idempotency key", async () => {
    await expect(
      createPrivacyIncident(
        { severity: "low", summary: "x" },
        "   ",
      ),
    ).rejects.toThrow(/idempotency key/i);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("surfaces the server denial with status and code, not a generic failure", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 403,
        code: "forbidden",
        message: "admin role required",
        requestId: "req-1",
      },
    });
    const attempt = createPrivacyIncident(
      { severity: "low", summary: "x" },
      "declare-key-2",
    );
    await expect(attempt).rejects.toBeInstanceOf(PrivacyIncidentError);
    await expect(
      createPrivacyIncident({ severity: "low", summary: "x" }, "declare-key-2"),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("transitionPrivacyIncident (state move)", () => {
  it("carries reason AND expected_from — the conflict assertion is the point", async () => {
    rawRequest.mockResolvedValue({
      data: {
        incident_id: "inc-1",
        from: "open",
        to: "contained",
        at: "2026-08-29T08:00:00Z",
      },
      error: null,
    });
    const result = await transitionPrivacyIncident("inc-1", {
      to: "contained",
      reason: "Key rotated; export access revoked.",
      expectedFrom: "open",
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/privacy/incidents/inc-1/transition",
      {
        to: "contained",
        reason: "Key rotated; export access revoked.",
        expected_from: "open",
      },
      undefined,
    );
    expect(result).toEqual({
      incidentId: "inc-1",
      from: "open",
      to: "contained",
      at: "2026-08-29T08:00:00Z",
    });
  });

  it("never sends to:'closed' — the closure release hold is respected locally", async () => {
    await expect(
      transitionPrivacyIncident("inc-1", {
        to: "closed",
        reason: "done",
        expectedFrom: "notifications_pending",
      }),
    ).rejects.toThrow(/release-held/);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("keeps the server's conflict code readable for the fresh-read policy", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 409,
        code: "stale_incident_state",
        message: "incident state changed",
      },
    });
    await expect(
      transitionPrivacyIncident("inc-1", {
        to: "contained",
        reason: "r",
        expectedFrom: "open",
      }),
    ).rejects.toMatchObject({ status: 409, code: "stale_incident_state" });
  });
});
