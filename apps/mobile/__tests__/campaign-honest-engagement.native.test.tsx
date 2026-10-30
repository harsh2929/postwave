import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";

/**
 * The "Honest engagement" insight card on the campaign detail screen
 * (P2.22), pinned at the level where its honesty rules become pixels.
 *
 * Both files are imported by RELATIVE path on purpose: jest.routes.config
 * stubs every `@/components/campaigns/*` leaf to a null component, which is
 * right for the detail-screen composition tests and would make every
 * assertion here a test of the stub.
 */
import { CampaignHonestEngagementBody } from "../src/components/campaigns/CampaignHonestEngagementBody";
import { CampaignInsightCard } from "../src/components/campaigns/CampaignInsightCard";
import { readHonestEngagement } from "../src/lib/campaignHonestEngagement";
import type { ThemeTokens } from "../src/lib/theme";

const t = new Proxy({}, { get: () => "#777777" }) as unknown as ThemeTokens;

/** A stock deployment: bot filtering off, human fields zeroed, nil slices null. */
const FLAG_OFF = {
  campaign_id: "c1",
  classification_filter: "all",
  delivered: 980,
  human_unique_opens: 0,
  human_open_rate: 0,
  raw_open_rate: 0.52,
  reply_count: 0,
  distinct_replyers: 0,
  reply_rate: 0,
  open_decoupled_conversions: 0,
  total_attributed_conversions: 0,
  bot_signatures_applied: null,
  ai_surfacing_score: 0.31,
  ai_surfacing_basis: null,
  ai_surfacing_confidence_level: "low",
  ai_surfacing_sample_opens: 510,
};

const FLAG_ON = {
  ...FLAG_OFF,
  human_unique_opens: 372,
  human_open_rate: 0.38,
  reply_count: 14,
  distinct_replyers: 12,
  reply_rate: 0.0122,
  open_decoupled_conversions: 3,
  total_attributed_conversions: 9,
  bot_signatures_applied: ["Apple Mail Privacy Protection"],
  ai_surfacing_score: 0.62,
  ai_surfacing_basis: ["human_open_rate", "reply_rate"],
  ai_surfacing_confidence_level: "ok",
  ai_surfacing_sample_opens: 372,
};

async function card(payload: unknown, expanded = true) {
  const view = readHonestEngagement(payload);
  return await render(
    <CampaignInsightCard
      title="Honest engagement"
      expanded={expanded}
      onToggle={() => undefined}
      loading={false}
      error={null}
      onRetry={() => undefined}
      empty={payload == null}
      emptyMessage="This workspace doesn't expose the engagement trust panel."
    >
      <CampaignHonestEngagementBody view={view} t={t} />
    </CampaignInsightCard>,
  );
}

describe("Honest engagement card — the human/raw split", () => {
  it("shows the raw rate with the disclosure, and NO human row, when bot filtering is off", async () => {
    const screen = await card(FLAG_OFF);
    expect(screen.getByText("Open rate")).toBeTruthy();
    expect(screen.getByText("52.0%")).toBeTruthy();
    expect(
      screen.getByText("bot filtering not enabled — showing raw rate"),
    ).toBeTruthy();
    // The lie this card must never tell on a stock deployment.
    expect(screen.queryByText("Human open rate")).toBeNull();
    expect(screen.queryByText("Machine inflation")).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
  });

  it("shows human vs raw with the inflation delta in points when filtering is on", async () => {
    const screen = await card(FLAG_ON);
    expect(screen.getByText("Human open rate")).toBeTruthy();
    expect(screen.getByText("38.0%")).toBeTruthy();
    expect(screen.getByText("Raw open rate")).toBeTruthy();
    expect(screen.getByText("52.0%")).toBeTruthy();
    expect(screen.getByText("Machine inflation")).toBeTruthy();
    expect(screen.getByText("14.0 pts")).toBeTruthy();
    expect(
      screen.getByText("Stripped: Apple Mail Privacy Protection"),
    ).toBeTruthy();
    expect(screen.getByText("Acted without an open")).toBeTruthy();
    expect(screen.getByText("3 of 9")).toBeTruthy();
  });

  it("reads each stat to a screen reader WITH its qualifier", async () => {
    const screen = await card(FLAG_ON);
    expect(
      screen.getByLabelText(
        "Machine inflation: 14.0 pts. Points of the raw open rate that came from machines and proxies",
      ),
    ).toBeTruthy();
  });
});

describe("Honest engagement card — the AI-surfacing estimate", () => {
  it("always labels the block as an estimate", async () => {
    const screen = await card(FLAG_ON);
    expect(screen.getByText("AI-surfacing estimate")).toBeTruthy();
    expect(screen.getByText("Estimate")).toBeTruthy();
  });

  it("renders the bucket and score only when the server trusts the sample", async () => {
    const screen = await card(FLAG_ON);
    expect(screen.getByText("Moderate · 62%")).toBeTruthy();
    expect(screen.getByText("372 opens analysed · ok confidence")).toBeTruthy();
    expect(screen.getByText("Based on human open rate, reply rate")).toBeTruthy();
  });

  it("renders the server's qualifier and NO number on low confidence", async () => {
    const screen = await card(FLAG_OFF);
    expect(
      screen.getByText(
        "Estimate not shown: the server rates its confidence low (510 opens analysed).",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/31%/)).toBeNull();
    expect(screen.queryByText(/Low ·/)).toBeNull();
  });
});

describe("Honest engagement card — disclosure", () => {
  it("renders none of the body while collapsed", async () => {
    const screen = await card(FLAG_ON, false);
    expect(screen.getByText("Honest engagement")).toBeTruthy();
    expect(screen.queryByText("Human open rate")).toBeNull();
    expect(screen.queryByText("AI-surfacing estimate")).toBeNull();
  });

  it("says so, rather than rendering zeros, when the deployment lacks the panel", async () => {
    const screen = await card(null);
    expect(
      screen.getByText(
        "This workspace doesn't expose the engagement trust panel.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Open rate")).toBeNull();
  });

  it("names a 2xx it cannot read as a shape problem, never as zeros", async () => {
    // The response-shape-drift class the mobile logic audit found everywhere:
    // a truthy payload the reader rejects must not become a blank card.
    const screen = await card([FLAG_ON]);
    expect(
      screen.getByText(
        "The engagement panel answered in a shape this app can't read, so nothing is shown rather than a guess.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Open rate")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });
});
