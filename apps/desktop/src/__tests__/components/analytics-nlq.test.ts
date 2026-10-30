// Analytics NLQ bar pure logic (full-surface wiring): error-code →
// honest copy mapping, the always-shown "interpreted as" provenance
// line, staged progress copy, and table-cell formatting for the
// loosely-typed rows.

import { describe, expect, it } from "vitest";

import {
  NLQ_PROGRESS_STAGES,
  interpretedAsLine,
  isNlqUnavailable,
  nlqCellText,
  nlqColumnLabel,
  nlqErrorMessage,
  nlqProgressCopy,
} from "../../components/analytics/analytics-nlq";
import type { ApiErr } from "../../lib/api-client";

function err(partial: Partial<ApiErr["error"]>): ApiErr["error"] {
  return { message: "boom", ...partial };
}

describe("nlqErrorMessage", () => {
  it("422 invalid_template → 'try rephrasing' copy, not the raw message", () => {
    const msg = nlqErrorMessage(
      err({ status: 422, code: "invalid_template", message: "no template matched" }),
    );
    expect(msg).toContain("Couldn't map that question");
    expect(msg).toContain("rephrasing");
    expect(msg).not.toContain("no template matched");
  });

  it("429 cost_cap_exceeded → honest budget copy with the reset time", () => {
    const msg = nlqErrorMessage(
      err({ status: 429, code: "cost_cap_exceeded" }),
    );
    expect(msg).toContain("Daily AI budget");
    expect(msg).toContain("UTC midnight");
  });

  it("503 nlq_unavailable → 'not configured' copy", () => {
    const msg = nlqErrorMessage(
      err({ status: 503, code: "nlq_unavailable" }),
    );
    expect(msg).toContain("aren't configured");
    expect(msg).toContain("Anthropic");
  });

  it("timeout kind → narrower-window suggestion", () => {
    expect(nlqErrorMessage(err({ kind: "timeout" }))).toContain("timed out");
  });

  it("falls back to the server message for unknown codes", () => {
    expect(nlqErrorMessage(err({ code: "weird", message: "server said X" }))).toBe(
      "server said X",
    );
  });

  it("falls back to generic copy when the message is empty", () => {
    expect(nlqErrorMessage(err({ message: "" }))).toBe("The AI query failed.");
  });
});

describe("isNlqUnavailable", () => {
  it("only the dedicated 503 code collapses the bar", () => {
    expect(isNlqUnavailable(err({ code: "nlq_unavailable" }))).toBe(true);
    expect(isNlqUnavailable(err({ status: 503, code: "other" }))).toBe(false);
    expect(isNlqUnavailable(err({}))).toBe(false);
  });
});

describe("interpretedAsLine", () => {
  it("echoes template + params verbatim — the honest provenance line", () => {
    expect(
      interpretedAsLine({
        template: "top_campaigns_by_revenue",
        params: { window_days: 30, limit: 10 },
      }),
    ).toBe(
      "Interpreted as: top_campaigns_by_revenue · last 30 days · limit 10",
    );
  });
});

describe("nlqProgressCopy", () => {
  it("starts with the first stage", () => {
    expect(nlqProgressCopy(0)).toBe(NLQ_PROGRESS_STAGES[0]?.copy);
  });

  it("advances through stages as time elapses", () => {
    expect(nlqProgressCopy(5_000)).toBe(NLQ_PROGRESS_STAGES[1]?.copy);
    expect(nlqProgressCopy(20_000)).toBe(NLQ_PROGRESS_STAGES[2]?.copy);
  });

  it("sticks on the last stage rather than cycling", () => {
    expect(nlqProgressCopy(10 * 60_000)).toBe(
      NLQ_PROGRESS_STAGES[NLQ_PROGRESS_STAGES.length - 1]?.copy,
    );
  });
});

describe("nlqCellText", () => {
  it("renders explicit em-dash for null/undefined", () => {
    expect(nlqCellText(null)).toBe("—");
    expect(nlqCellText(undefined)).toBe("—");
  });

  it("passes strings through and verbalises booleans", () => {
    expect(nlqCellText("Welcome #4")).toBe("Welcome #4");
    expect(nlqCellText(true)).toBe("yes");
    expect(nlqCellText(false)).toBe("no");
  });

  it("formats small integers without locale surprises", () => {
    expect(nlqCellText(42)).toBe("42");
    expect(nlqCellText(0)).toBe("0");
  });

  it("serialises objects instead of rendering [object Object]", () => {
    expect(nlqCellText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("nlqColumnLabel", () => {
  it("humanises snake_case headers", () => {
    expect(nlqColumnLabel("revenue_cents")).toBe("revenue cents");
    expect(nlqColumnLabel("name")).toBe("name");
  });
});
