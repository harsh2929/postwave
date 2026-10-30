import { describe, expect, it } from "vitest";

import {
  analyticsAskErrorMessage,
  AnalyticsAnswerUnreadableError,
  humanizeColumn,
  parseAnalyticsAnswer,
} from "@/lib/analyticsAnswer";

/** Shaped exactly like the handler's `analyticsNLQResponse`. */
function response(overrides: Record<string, unknown> = {}) {
  return {
    question: "which campaigns got the most opens?",
    answer_kind: "table",
    template: "top_campaigns_by_opens",
    params: { window_days: 30, limit: 10 },
    columns: ["campaign_id", "campaign_name", "unique_opens"],
    rows: [
      {
        campaign_id: "11111111-1111-1111-1111-111111111111",
        campaign_name: "March newsletter",
        unique_opens: 4120,
      },
      {
        campaign_id: "22222222-2222-2222-2222-222222222222",
        campaign_name: "Spring sale",
        unique_opens: 980,
      },
    ],
    summary_text: "Returned 2 result row(s) for the last 30 days.",
    trace: { reasoning: "", prompt_tokens: 1, response_tokens: 2 },
    ...overrides,
  };
}

describe("parseAnalyticsAnswer", () => {
  it("reads the handler's envelope", () => {
    const answer = parseAnalyticsAnswer(response());
    expect(answer).toMatchObject({
      kind: "table",
      template: "top_campaigns_by_opens",
      windowDays: 30,
      limit: 10,
    });
    expect(answer.rows).toHaveLength(2);
  });

  it("never picks a UUID column as the row label", () => {
    const answer = parseAnalyticsAnswer(response());
    expect(answer.labelColumn).toBe("campaign_name");
    expect(answer.rows[0]?.label).toBe("March newsletter");
  });

  it("picks the LAST numeric column as the measure", () => {
    // Identifiers come first in every template; the measure is last.
    const answer = parseAnalyticsAnswer(response());
    expect(answer.valueColumn).toBe("unique_opens");
    expect(answer.rows[0]?.value).toBe(4120);
  });

  it("keeps an empty result set as a real answer, not a failure", () => {
    const answer = parseAnalyticsAnswer(
      response({
        rows: [],
        summary_text: "No data matched this query in the last 30 days.",
      }),
    );
    expect(answer.rows).toEqual([]);
    expect(answer.summaryText).toContain("No data matched");
  });

  it("throws when there is no summary — a table with no statement is unusable", () => {
    expect(() => parseAnalyticsAnswer(response({ summary_text: "  " }))).toThrow(
      AnalyticsAnswerUnreadableError,
    );
    expect(() => parseAnalyticsAnswer(null)).toThrow(
      AnalyticsAnswerUnreadableError,
    );
  });

  it("renders an absent cell as an em-dash and never as zero", () => {
    const answer = parseAnalyticsAnswer(
      response({
        rows: [
          { campaign_id: "x", campaign_name: "Nameless", unique_opens: null },
        ],
      }),
    );
    expect(answer.rows[0]?.value).toBeNull();
    const cell = answer.rows[0]?.cells.find((c) => c.column === "unique_opens");
    expect(cell?.text).toBe("—");
    expect(cell?.value).toBeNull();
  });

  it("treats an unknown answer_kind as a table rather than trusting it", () => {
    expect(parseAnalyticsAnswer(response({ answer_kind: "wat" })).kind).toBe(
      "table",
    );
    expect(parseAnalyticsAnswer(response({ answer_kind: "summary" })).kind).toBe(
      "summary",
    );
  });

  it("reports an unstated window as 0 so the caller can omit it", () => {
    expect(parseAnalyticsAnswer(response({ params: {} })).windowDays).toBe(0);
  });

  it("drops non-object rows instead of rendering [object Object]", () => {
    const answer = parseAnalyticsAnswer(
      response({ rows: [["not", "a", "row"], null, { campaign_name: "Ok" }] }),
    );
    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0]?.label).toBe("Ok");
  });
});

describe("humanizeColumn", () => {
  it("turns a Postgres column into a phrase", () => {
    expect(humanizeColumn("unique_opens")).toBe("Unique opens");
    expect(humanizeColumn("top_campaigns_by_opens")).toBe(
      "Top campaigns by opens",
    );
  });
});

describe("analyticsAskErrorMessage", () => {
  it("tells an unconfigured workspace to stop retrying", () => {
    expect(analyticsAskErrorMessage(503, "nlq_unavailable", "")).toContain(
      "administrator",
    );
  });

  it("names the budget reset rather than saying it failed", () => {
    expect(analyticsAskErrorMessage(429, "cost_cap_exceeded", "")).toContain(
      "midnight UTC",
    );
  });

  it("suggests rephrasing for a question outside the registry", () => {
    expect(
      analyticsAskErrorMessage(422, "invalid_template", "unknown template"),
    ).toContain("saved report");
  });

  it("keeps a server sentence but not a transport string", () => {
    expect(analyticsAskErrorMessage(500, undefined, "the server is busy")).toBe(
      "the server is busy",
    );
    expect(analyticsAskErrorMessage(0, undefined, "ECONNRESET")).toContain(
      "Try again",
    );
  });
});
