import { describe, expect, it } from "vitest";

import {
  campaignEventsPath,
  parseCampaignStreamFrame,
} from "./campaignReportStream";

const REPORT = {
  campaign_id: "c1",
  sent: 120,
  delivered: 118,
  opens: 9,
};

function frame(event: string, payload: unknown) {
  return { event, data: JSON.stringify(payload) };
}

describe("parseCampaignStreamFrame", () => {
  it("accepts the connect snapshot", () => {
    const parsed = parseCampaignStreamFrame(frame("snapshot", REPORT), "c1");
    expect(parsed).toEqual({ kind: "report", event: "snapshot", report: REPORT });
  });

  it("accepts a later delta", () => {
    const parsed = parseCampaignStreamFrame(frame("delta", REPORT), "c1");
    expect(parsed.kind).toBe("report");
  });

  it("IGNORES the anomaly event — it is a different payload shape", () => {
    // apps/api/internal/analytics/sse.go emits CampaignAnomaliesResult here.
    // Writing it into the report cache would replace live send numbers with an
    // object that has none of them.
    const parsed = parseCampaignStreamFrame(
      frame("anomaly", { campaign_id: "c1", anomalies: [] }),
      "c1",
    );
    expect(parsed).toEqual({ kind: "ignored", reason: "anomaly" });
  });

  it("surfaces the server's error frame rather than treating it as a report", () => {
    const parsed = parseCampaignStreamFrame(
      frame("error", {
        code: "analytics_stream_unavailable",
        message: "Live analytics could not be refreshed. Reconnect to retry.",
      }),
      "c1",
    );
    expect(parsed).toEqual({
      kind: "error",
      code: "analytics_stream_unavailable",
      message: "Live analytics could not be refreshed. Reconnect to retry.",
    });
  });

  it("fills in an error frame that arrives without fields", () => {
    const parsed = parseCampaignStreamFrame(frame("error", {}), "c1");
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") throw new Error("unreachable");
    expect(parsed.code).toBe("analytics_stream_unavailable");
    expect(parsed.message).toBeTruthy();
  });

  it("refuses a report for a DIFFERENT campaign", () => {
    // One campaign's send numbers painted over another's, on the screen an
    // operator is watching a live send from, is the worst outcome available.
    const parsed = parseCampaignStreamFrame(
      frame("delta", { ...REPORT, campaign_id: "other" }),
      "c1",
    );
    expect(parsed).toEqual({ kind: "ignored", reason: "wrong-campaign" });
  });

  it("refuses a report with no campaign id to check", () => {
    const parsed = parseCampaignStreamFrame(frame("delta", { sent: 5 }), "c1");
    expect(parsed).toEqual({ kind: "ignored", reason: "malformed" });
  });

  it("ignores an unknown event name", () => {
    const parsed = parseCampaignStreamFrame(frame("heartbeat", REPORT), "c1");
    expect(parsed).toEqual({ kind: "ignored", reason: "unknown-event" });
  });

  it("ignores malformed and non-object payloads", () => {
    expect(parseCampaignStreamFrame({ event: "delta", data: "{" }, "c1")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(parseCampaignStreamFrame(frame("delta", [REPORT]), "c1")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(parseCampaignStreamFrame(frame("delta", null), "c1")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
  });

  it("tolerates whitespace around the event name", () => {
    expect(
      parseCampaignStreamFrame({ event: " delta ", data: JSON.stringify(REPORT) }, "c1")
        .kind,
    ).toBe("report");
  });
});

describe("campaignEventsPath", () => {
  it("encodes the id so a path segment cannot be forged", () => {
    expect(campaignEventsPath("a/b")).toBe("/api/v1/campaigns/a%2Fb/events");
  });
});
