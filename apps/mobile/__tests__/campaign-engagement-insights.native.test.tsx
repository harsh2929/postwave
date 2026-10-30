import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";

/**
 * The two campaign-report drilldowns added for desktop parity — "Engagement
 * over time" (GET /campaigns/{id}/timeseries) and "By locale"
 * (GET /campaigns/{id}/locale-report) — pinned at the level where their
 * reading rules become pixels.
 *
 * Imported by RELATIVE path on purpose: jest.routes.config stubs every
 * `@/components/campaigns/*` leaf to a null component, which is right for the
 * detail-screen composition tests and would make every assertion here a test
 * of the stub.
 */
import {
  CampaignEngagementOverTimeCard,
  CampaignLocaleReportCard,
  type InsightCardQuery,
} from "../src/components/campaigns/CampaignEngagementInsightCards";

/** A settled useCampaignInsight result: the card reads only these four. */
function settled(data: unknown): InsightCardQuery {
  return { data, isLoading: false, error: null, refetch: () => undefined };
}

const SERIES = {
  campaign_id: "c1",
  buckets: [
    { hour: "2026-08-21T13:00:00Z", opens: 12, clicks: 3, unsubs: 0 },
    { hour: "2026-08-21T14:00:00Z", opens: 0, clicks: 0, unsubs: 0 },
    { hour: "2026-08-21T15:00:00Z", opens: 40, clicks: 9, unsubs: 2 },
  ],
  timezone: "UTC",
  granularity: "hour",
  truncated: false,
};

const LOCALES = {
  campaign_id: "c1",
  locales: [
    { locale: "en-US", sent: 1200, opens: 480, clicks: 96 },
    { locale: "de-DE", sent: 300, opens: 90, clicks: 12 },
    { locale: "unknown", sent: 60, opens: 6, clicks: 0 },
  ],
};

async function hourlyCard(data: unknown, expanded = true) {
  return await render(
    <CampaignEngagementOverTimeCard
      query={settled(data)}
      expanded={expanded}
      onToggle={() => undefined}
    />,
  );
}

async function localeCard(data: unknown, expanded = true) {
  return await render(
    <CampaignLocaleReportCard
      query={settled(data)}
      expanded={expanded}
      onToggle={() => undefined}
    />,
  );
}

describe("Engagement over time card", () => {
  it("plots all three series the endpoint reports, each named in the legend", async () => {
    const screen = await hourlyCard(SERIES);
    expect(screen.getByText("Engagement by hour")).toBeTruthy();
    expect(screen.getByText("Opens")).toBeTruthy();
    expect(screen.getByText("Clicks")).toBeTruthy();
    // The series an operator checks for damage; the desktop plots it too.
    expect(screen.getByText("Unsubscribes")).toBeTruthy();
  });

  it("captions the chart with the totals and the server's timezone", async () => {
    const screen = await hourlyCard(SERIES);
    expect(
      screen.getByText(
        "Hour by hour after the send, UTC · 52 opens, 12 clicks, 2 unsubscribes.",
      ),
    ).toBeTruthy();
  });

  it("says WHICH 30 days a truncated series is, and never says the first", async () => {
    const screen = await hourlyCard({ ...SERIES, truncated: true });
    expect(
      screen.getByText(
        "Hour by hour after the send, UTC · 52 opens, 12 clicks, 2 unsubscribes. The server keeps 30 days of hourly buckets, so these are the most recent 30 days — earlier hours of this send are not shown.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/first 30 days/u)).toBeNull();
  });

  it("says nothing was recorded rather than drawing an empty chart", async () => {
    const screen = await hourlyCard({ campaign_id: "c1", buckets: [] });
    expect(
      screen.getByText(
        "No hourly engagement has been recorded for this campaign.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Engagement by hour")).toBeNull();
  });

  it("names a 2xx it cannot read as a shape problem, never as no engagement", async () => {
    const screen = await hourlyCard({ data: SERIES });
    expect(
      screen.getByText(
        "The hourly series answered in a shape this app can't read, so nothing is shown rather than a guess.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "No hourly engagement has been recorded for this campaign.",
      ),
    ).toBeNull();
  });

  it("says the deployment lacks the endpoint when the read resolved to null", async () => {
    const screen = await hourlyCard(null);
    expect(
      screen.getByText(
        "No hourly engagement has been recorded for this campaign.",
      ),
    ).toBeTruthy();
  });

  it("renders none of the body — and draws no chart — while collapsed", async () => {
    const screen = await hourlyCard(SERIES, false);
    expect(screen.getByText("Engagement over time")).toBeTruthy();
    expect(screen.queryByText("Engagement by hour")).toBeNull();
    expect(screen.queryByText("Unsubscribes")).toBeNull();
  });
});

describe("By locale card", () => {
  it("ranks the locales and calls the figure an open rate", async () => {
    const screen = await localeCard(LOCALES);
    expect(screen.getByText("en-US")).toBeTruthy();
    expect(screen.getByText("1,200 sent · 40% open rate")).toBeTruthy();
    expect(screen.getByText("de-DE")).toBeTruthy();
    expect(screen.getByText("300 sent · 30% open rate")).toBeTruthy();
  });

  it("writes the server's 'unknown' locale out in words", async () => {
    const screen = await localeCard(LOCALES);
    expect(screen.getByText("No locale recorded")).toBeTruthy();
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("reads each row to a screen reader with the counts the line compacts away", async () => {
    const screen = await localeCard(LOCALES);
    expect(
      screen.getByLabelText("de-DE: 300 sent, 90 opens, 12 clicks"),
    ).toBeTruthy();
  });

  it("says no locales were recorded when the report is empty", async () => {
    const screen = await localeCard({ campaign_id: "c1", locales: [] });
    expect(
      screen.getByText(
        "No per-locale stats have been recorded for this campaign.",
      ),
    ).toBeTruthy();
  });

  it("names an unreadable payload as drift, not as an untranslated campaign", async () => {
    const screen = await localeCard([LOCALES]);
    expect(
      screen.getByText(
        "The per-locale report answered in a shape this app can't read, so nothing is shown rather than a guess.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "No per-locale stats have been recorded for this campaign.",
      ),
    ).toBeNull();
  });

  it("renders nothing but its own title while collapsed", async () => {
    const screen = await localeCard(LOCALES, false);
    expect(screen.getByText("By locale")).toBeTruthy();
    expect(screen.queryByText("en-US")).toBeNull();
  });
});
