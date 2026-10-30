import { beforeEach, describe, expect, it, vi } from "vitest";

import { WireShapeError } from "@/lib/wireShapeError";

import {
  getEmailHealth,
  getEmailHealthBatch,
  parseEmailHealth,
} from "./emailHealth";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({ client: { request: mocks.request } }),
}));

const NOW = "2026-08-13T09:00:00.000Z";

function health(email: string, grade: "A" | "B" | "D" | "F" = "A") {
  const hardStop = grade === "F";
  const reasonCode =
    grade === "A"
      ? "verification_valid_30d"
      : grade === "B"
        ? "event_delivered"
        : grade === "D"
          ? "event_bounced_hard"
          : "suppression_hard_bounce";
  const evidence =
    grade === "B"
      ? [
          {
            kind: "delivered",
            at: NOW,
            source: "subscriber_events",
            reason_code: reasonCode,
          },
        ]
      : grade === "D"
        ? [
            {
              kind: "hard_bounce",
              at: NOW,
              source: "subscriber_events",
              reason_code: reasonCode,
            },
          ]
        : grade === "F"
          ? [
              {
                kind: "hard_stop",
                at: NOW,
                source: "send_eligibility",
                reason_code: reasonCode,
              },
            ]
          : [];
  return {
    email,
    grade,
    recommendation:
      grade === "D" ? "do_not_send" : hardStop ? "blocked" : "send",
    hard_stop: hardStop,
    send_eligible: grade === "A" || grade === "B",
    evidence_complete: true,
    reason_codes: [reasonCode],
    evidence,
    evidence_at: NOW,
    ...(grade === "A"
      ? { status: "valid", provider: "kickbox", checked_at: NOW }
      : {}),
    model_version: "postwave-email-health-v1",
    computed_at: NOW,
  };
}

beforeEach(() => mocks.request.mockReset());

describe("mobile email health", () => {
  it("accepts the closed grade model and rejects contradictory safety fields", () => {
    expect(parseEmailHealth(health("person@example.com", "F"))).toMatchObject({
      grade: "F",
      recommendation: "blocked",
      send_eligible: false,
    });
    expect(parseEmailHealth(health("person@example.com", "D"))).toMatchObject({
      grade: "D",
      recommendation: "do_not_send",
      hard_stop: false,
      send_eligible: false,
      evidence: [{ kind: "hard_bounce" }],
    });
    expect(
      parseEmailHealth({
        ...health("person@example.com", "F"),
        hard_stop: false,
        reason_codes: ["verification_invalid"],
        evidence: [],
        status: "invalid",
      }),
    ).toMatchObject({
      grade: "F",
      recommendation: "blocked",
      hard_stop: false,
      send_eligible: false,
    });
    expect(
      parseEmailHealth({
        ...health("person@example.com", "F"),
        send_eligible: true,
      }),
    ).toBeNull();
    expect(
      parseEmailHealth({ ...health("person@example.com"), grade: "E" }),
    ).toBeNull();
    expect(
      parseEmailHealth(health("not-an-email", "F"), "not-an-email"),
    ).toMatchObject({ grade: "F" });
    expect(
      parseEmailHealth({
        ...health("person@example.com", "A"),
        checked_at: undefined,
      }),
    ).toBeNull();
    expect(
      parseEmailHealth({
        ...health("person@example.com", "A"),
        provider: "local",
      }),
    ).toBeNull();
    expect(
      parseEmailHealth({
        ...health("person@example.com", "A"),
        computed_at: "2026-02-30T09:00:00Z",
      }),
    ).toBeNull();
    expect(
      parseEmailHealth({
        ...health("person@example.com", "A"),
        email: " Person@Example.com ",
      }),
    ).toBeNull();
    expect(
      parseEmailHealth({
        ...health("person@example.com", "B"),
        evidence: [
          {
            kind: "vendor_activity",
            at: NOW,
            source: "vendor",
            reason_code: "vendor_activity",
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseEmailHealth({
        ...health("person@example.com", "A"),
        status: "unknown",
      }),
    ).toBeNull();

    const incomplete = {
      ...health("person@example.com"),
      grade: "U",
      recommendation: "caution",
      send_eligible: false,
      evidence_complete: false,
      reason_codes: ["health_evidence_unavailable"],
      evidence: [],
    };
    expect(parseEmailHealth(incomplete)).toMatchObject({
      grade: "U",
      send_eligible: false,
      evidence_complete: false,
    });
    expect(parseEmailHealth({ ...incomplete, grade: "A" })).toBeNull();
  });

  it("encodes the address and fails closed on a malformed receipt", async () => {
    mocks.request.mockResolvedValue(health("person+sales@example.com", "B"));
    await expect(
      getEmailHealth(" Person+Sales@Example.com "),
    ).resolves.toMatchObject({
      grade: "B",
      email: "person+sales@example.com",
      reason_codes: ["event_delivered"],
      evidence: [{ kind: "delivered", source: "subscriber_events" }],
    });
    expect(mocks.request).toHaveBeenCalledWith(
      "GET",
      "/api/v1/verification/health?email=person%2Bsales%40example.com",
    );

    mocks.request.mockResolvedValue({ grade: "A" });
    await expect(getEmailHealth("person@example.com")).rejects.toThrow(
      "malformed",
    );
    // errorCopy reads the code to tell drift from a network blip.
    await expect(getEmailHealth("person@example.com")).rejects.toMatchObject({
      code: "wire_shape",
      message: "Email health response was malformed.",
    });
  });

  it("validates all six summary buckets and supports server deduplication", async () => {
    mocks.request.mockResolvedValue({
      results: [health("a@example.com"), health("b@example.com", "F")],
      summary: { A: 1, B: 0, C: 0, D: 0, F: 1, U: 0 },
      total: 2,
      duplicates: 1,
      model_version: "postwave-email-health-v1",
    });
    await expect(
      getEmailHealthBatch(["a@example.com", "a@example.com", "b@example.com"]),
    ).resolves.toMatchObject({ summary: { A: 1, F: 1 } });
    expect(mocks.request).toHaveBeenCalledWith(
      "POST",
      "/api/v1/verification/health/batch",
      {
        body: {
          emails: ["a@example.com", "a@example.com", "b@example.com"],
        },
      },
    );

    mocks.request.mockResolvedValue({
      results: [health("a@example.com")],
      summary: { A: 1, B: 0, C: 0, D: 0, F: 0 },
      total: 1,
      duplicates: 0,
      model_version: "postwave-email-health-v1",
    });
    await expect(getEmailHealthBatch(["a@example.com"])).rejects.toThrow(
      "malformed",
    );
    await expect(getEmailHealthBatch(["a@example.com"])).rejects.toMatchObject({
      code: "wire_shape",
    });
  });

  it("tags every batch drift as a wire-shape failure with its sentence", async () => {
    const valid = {
      results: [health("a@example.com")],
      summary: { A: 1, B: 0, C: 0, D: 0, F: 0, U: 0 },
      total: 1,
      duplicates: 0,
      model_version: "postwave-email-health-v1",
    };
    const drifted: Record<string, unknown>[] = [
      // The envelope itself is not the batch shape.
      { ...valid, results: "a@example.com" },
      // A row answers an address nobody asked about.
      { ...valid, results: [health("stranger@example.com")] },
      // The summary grew a seventh bucket this client does not know.
      { ...valid, summary: { ...valid.summary, Z: 0 } },
    ];
    for (const body of drifted) {
      mocks.request.mockResolvedValueOnce(body);
      const err = await getEmailHealthBatch(["a@example.com"]).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(WireShapeError);
      expect(err).toMatchObject({
        code: "wire_shape",
        message: "Email health batch response was malformed.",
      });
    }
  });
});
