// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));

import {
  fetchCheckDetail,
  isCheckDetail,
  verdict,
  type CheckDetail,
} from "./checkDetail";

const card = {
  id: "billing.dlq-depth",
  why: "A dead-lettered event means a customer paid and got nothing.",
  kind: "evaluated",
  severity: "critical",
  status: "red",
  remediation: "Replay the bounded dead-letter batch.",
};

const detail: CheckDetail = {
  card,
  history: [
    { check_id: "billing.dlq-depth", from: "ok", to: "red", at: "2026-09-05T10:00:00Z" },
  ],
  flap_count: 1,
  flap_window_hours: 24,
};

describe("check detail contract", () => {
  it("accepts the API's shape", () => {
    expect(isCheckDetail(detail)).toBe(true);
  });

  it("refuses a history entry with an unknown status", () => {
    expect(
      isCheckDetail({
        ...detail,
        history: [{ ...detail.history[0], to: "probably_fine" }],
      }),
    ).toBe(false);
  });

  it("refuses a check id that could redirect the forwarded path", () => {
    expect(
      isCheckDetail({
        ...detail,
        history: [{ ...detail.history[0], check_id: "../../v1/subscribers" }],
      }),
    ).toBe(false);
  });

  it("refuses a tick log with an unbounded note", () => {
    expect(
      isCheckDetail({
        ...detail,
        ticks: [
          {
            check_id: "billing.dlq-depth",
            operator: "ops@postwave.local",
            note: "x".repeat(5000),
            ticked_at: "2026-09-05T10:00:00Z",
          },
        ],
      }),
    ).toBe(false);
  });

  it("never forwards a path-traversing id upstream", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchCheckDetail("../../v1/subscribers");
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("verdict", () => {
  // The distinction that decides what an operator does: a check that has never
  // been anything but red is a measurement problem, not an incident.
  it("calls out a check that has never transitioned while failing", () => {
    expect(verdict({ ...detail, history: [], flap_count: 0 })).toContain(
      "threshold is wrong",
    );
  });

  it("does not accuse a passing check that has simply been steady", () => {
    const steady = { ...detail, card: { ...card, status: "ok" }, history: [], flap_count: 0 };
    expect(verdict(steady)).toContain("steady");
    expect(verdict(steady)).not.toContain("threshold is wrong");
  });

  it("names flapping for what it is rather than counting incidents", () => {
    expect(verdict({ ...detail, flap_count: 8 })).toContain("flapping");
  });

  it("reports a stable check plainly", () => {
    expect(verdict({ ...detail, flap_count: 0 })).toContain("not intermittent");
  });
});
