/**
 * AudienceMixSection — the workspace rollup of mail clients, countries and
 * links across recent sends.
 *
 * What these tests pin, and why each one is a defect that still LOOKS right:
 *
 *  - THE ROLLUP DOES NOT FIRE ON MOUNT. It is `campaigns × 3` aggregate
 *    queries; the analytics tab is a scroll, and a section that reads fifteen
 *    aggregates because someone scrolled past a heading is a bill nobody
 *    agreed to. The hook itself must not mount until armed — an `enabled:
 *    false` query would still have run the campaigns list read.
 *  - THE SCOPE SENTENCE NAMES THE SEND FILTER. These totals cover recent SENT
 *    campaigns, not the reporting window at the top of the screen, and not
 *    the ten rows the list returned. "3 of 10" without the word `sent` reads
 *    as a failure rather than as a choice.
 *  - THE QUERY KEY CARRIES THE CAMPAIGN IDS. A send completing while the
 *    screen is open makes this a different question; a tenant-only key would
 *    answer it from the previous set's cache.
 *  - A FAILED READ NEVER BORROWS THE EMPTY COPY. "No opens or clicks recorded"
 *    is a claim about the audience. When the read failed, the honest sentence
 *    is about the request.
 *
 * The merge arithmetic is pinned in src/lib/audienceMix.test.ts; this file
 * proves the sentences and the gates reach the screen.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import React from "react";

import { AudienceMixSection } from "@/components/analytics/AudienceMixSection";
import { buildAudienceMix } from "@/lib/audienceMix";

const queryHooks = require("./mocks/queryHooks.cjs");

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryOptionsForTests: () => {
    kind: string;
    options: { enabled?: boolean; queryKey?: unknown };
  }[];
};

function settled(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: async () => ({ data }),
  };
}

/** The campaigns list read, as `useCampaignsList` hands it back. */
function listReturns(rows: unknown[]) {
  queryHooks.__setHookResultForTests("useCampaignsList", settled(rows));
}

const sentCampaign = (id: string) => ({
  id,
  name: `Campaign ${id}`,
  status: "finished",
  sent_at: "2026-08-30T09:00:00Z",
});

const perCampaign = (id: string) => ({
  campaignId: id,
  devices: [{ client: "Apple Mail", opens: 30, clicks: 4 }],
  geography: [{ country: "DE", opens: 30, clicks: 4 }],
  links: [{ url: "https://shop.example/sale", clicks: 4, ctr: 0.2 }],
  failures: [],
  absent: [],
});

function audienceMixQueries() {
  return queryHarness
    .__getQueryOptionsForTests()
    .filter((entry) =>
      JSON.stringify(entry.options.queryKey ?? []).includes("audience-mix"),
    );
}

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("AudienceMixSection", () => {
  it("reads nothing until the reader asks — no rollup query is even registered", async () => {
    listReturns([sentCampaign("a"), sentCampaign("b")]);
    const screen = await render(<AudienceMixSection />);

    expect(
      screen.getByLabelText("Show the audience mix across recent sent campaigns"),
    ).toBeTruthy();
    expect(audienceMixQueries()).toHaveLength(0);
    expect(screen.queryByText("Mail clients")).toBeNull();
  });

  it("names the send filter in the scope sentence, not just a count", async () => {
    listReturns([
      sentCampaign("a"),
      sentCampaign("b"),
      { id: "c", status: "draft", sent_at: null },
    ]);
    queryHarness.__setQueryResultForTests(
      settled(buildAudienceMix([perCampaign("a"), perCampaign("b")])),
    );

    const screen = await render(<AudienceMixSection />);
    await fireEvent.press(
      screen.getByLabelText("Show the audience mix across recent sent campaigns"),
    );

    expect(
      screen.getByText("Across 2 sent campaigns of the 3 most recent."),
    ).toBeTruthy();
    expect(screen.getByText("Mail clients")).toBeTruthy();
    expect(screen.getByText("Top countries")).toBeTruthy();
    expect(screen.getByText("Top links")).toBeTruthy();
  });

  it("keys the rollup by the campaigns it read, so a new send is a new question", async () => {
    listReturns([sentCampaign("a"), sentCampaign("b")]);
    queryHarness.__setQueryResultForTests(
      settled(buildAudienceMix([perCampaign("a"), perCampaign("b")])),
    );

    const screen = await render(<AudienceMixSection />);
    await fireEvent.press(
      screen.getByLabelText("Show the audience mix across recent sent campaigns"),
    );

    const key = JSON.stringify(audienceMixQueries()[0]?.options.queryKey ?? []);
    expect(key).toContain("a|b");
  });

  it("says the read failed rather than reporting an audience that did nothing", async () => {
    listReturns([sentCampaign("a")]);
    queryHarness.__setQueryResultForTests(
      settled(
        buildAudienceMix([
          {
            ...perCampaign("a"),
            geography: [],
            failures: [{ read: "geography" as const, status: 502 }],
          },
        ]),
      ),
    );

    const screen = await render(<AudienceMixSection />);
    await fireEvent.press(
      screen.getByLabelText("Show the audience mix across recent sent campaigns"),
    );

    expect(
      screen.getByText(
        "Couldn't read countries for these sends. This is not a reading of zero.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Couldn't read countries — those opens are missing from these totals.",
      ),
    ).toBeTruthy();
    // The panels that DID load are still offered.
    expect(screen.getByText("Mail clients")).toBeTruthy();
  });

  it("refuses offline rather than claiming the workspace has no sent campaigns", async () => {
    // The specific defect: with nothing cached, the offline path reaches the
    // zero-campaigns branch, and "No sent campaigns in the recent list." is a
    // claim about the workspace made from a phone that never got to ask.
    queryHooks.__setOnlineGateForTests({ enabled: false });
    const screen = await render(<AudienceMixSection />);

    expect(
      screen.getByText(
        "The audience mix needs a connection — it's summed live across recent sends.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("No sent campaigns in the recent list."),
    ).toBeNull();
    expect(
      screen.queryByLabelText(
        "Show the audience mix across recent sent campaigns",
      ),
    ).toBeNull();
    expect(audienceMixQueries()).toHaveLength(0);
  });

  it("explains an empty rollup instead of drawing three blank panels", async () => {
    listReturns([{ id: "c", status: "draft", sent_at: null }]);

    const screen = await render(<AudienceMixSection />);
    await fireEvent.press(
      screen.getByLabelText("Show the audience mix across recent sent campaigns"),
    );

    expect(
      screen.getByText("No sent campaigns in the recent list."),
    ).toBeTruthy();
    expect(screen.queryByText("Mail clients")).toBeNull();
    expect(audienceMixQueries()[0]?.options.enabled).toBe(false);
  });
});
