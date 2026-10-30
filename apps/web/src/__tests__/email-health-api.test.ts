import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("../lib/api", () => ({
  api: { get: mocks.get, post: mocks.post },
}));

import {
  getEmailHealth,
  getEmailHealthBatch,
  parseEmailHealth,
} from "../lib/email-health-api";

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

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
});

describe("email health API contract", () => {
  it("accepts the closed grade model and rejects contradictory safety fields", () => {
    expect(parseEmailHealth(health("person@example.com", "F"))).toMatchObject({
      grade: "F",
      recommendation: "blocked",
      hard_stop: true,
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
      parseEmailHealth(health("person@example.com"), "other@example.com"),
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

  it("requests one grade by query and rejects a malformed receipt", async () => {
    mocks.get.mockResolvedValue(health("person+sales@example.com", "B"));
    await expect(
      getEmailHealth("person+sales@example.com"),
    ).resolves.toMatchObject({
      grade: "B",
      reason_codes: ["event_delivered"],
      evidence: [{ kind: "delivered", source: "subscriber_events" }],
    });
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/verification/health", {
      query: { email: "person+sales@example.com" },
    });

    mocks.get.mockResolvedValue({ grade: "A" });
    await expect(getEmailHealth("person@example.com")).rejects.toThrow(
      "malformed",
    );
  });

  it("validates the closed six-grade batch summary and deduplicated results", async () => {
    mocks.post.mockResolvedValue({
      results: [health("a@example.com"), health("b@example.com", "F")],
      summary: { A: 1, B: 0, C: 0, D: 0, F: 1, U: 0 },
      total: 2,
      duplicates: 1,
      model_version: "postwave-email-health-v1",
    });
    await expect(
      getEmailHealthBatch(["a@example.com", "a@example.com", "b@example.com"]),
    ).resolves.toMatchObject({ total: 2, duplicates: 1 });

    mocks.post.mockResolvedValue({
      results: [health("a@example.com")],
      summary: { A: 1, B: 0, C: 0, D: 0, F: 0 },
      total: 1,
      duplicates: 0,
      model_version: "postwave-email-health-v1",
    });
    await expect(getEmailHealthBatch(["a@example.com"])).rejects.toThrow(
      "malformed",
    );
  });
});
