import { describe, expect, it, jest, beforeEach, afterEach } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";

/**
 * The per-cohort funnel table and its audience filter.
 *
 * Three claims are pinned here because each one, broken, produces a card that
 * still LOOKS right:
 *
 *  - every purchase line carries the denominator its rate is measured against
 *    (signups for the first stage, first-purchasers for the repeat stage). The
 *    server computes them against different populations, so a line that drops
 *    the denominator overstates the bottom of the funnel;
 *  - choosing an audience re-keys the query with the tag NAME, because
 *    `audience_id` is matched against `subscribers.tags` — a key that ignored
 *    the selection would render the unfiltered numbers under a filter chip;
 *  - a filtered table says the bars above it are unfiltered. The stage bars
 *    come from the screen's own unscoped query, and nothing else on the card
 *    would tell the reader the two halves measure different populations.
 */
const tags = {
  data: { rows: [{ id: "t1", name: "vip" }], fromSnapshot: false, capturedAt: null },
  isLoading: false,
  isError: false,
};

jest.mock("@/hooks/useTagCatalogue", () => ({
  useTagCatalogue: () => tags,
}));

// The real network call is the one thing a render test must not make; the
// query mock never invokes queryFn anyway, so this only keeps the import graph
// free of the SDK client.
jest.mock("@/api/cohortFunnel", () => ({
  fetchCohortFunnel: jest.fn(async () => ({ rows: [], stages: [] })),
}));

// eslint-disable-next-line import/first
import * as ReactQuery from "@tanstack/react-query";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryOptionsForTests: () => {
    kind: string;
    options: { queryKey: unknown[] };
  }[];
};
// eslint-disable-next-line import/first
import { CohortFunnelDetail } from "@/components/analytics/CohortFunnelDetail";

const VIEW = {
  rows: [
    {
      label: "2026-08",
      signups: 200,
      firstPurchases: 6,
      repeatPurchases: 1,
      firstRatePct: 3,
      repeatRatePct: 16.666,
    },
    {
      label: "2026-07",
      signups: 300,
      firstPurchases: 34,
      repeatPurchases: 9,
      firstRatePct: 11.333,
      repeatRatePct: 26.47,
    },
  ],
  stages: [
    { stage: "signup", label: "Signed Up", count: 500 },
    { stage: "first_purchase", label: "First Purchase", count: 40 },
    { stage: "repeat_purchase", label: "Repeat Purchase", count: 10 },
  ],
};

function loaded(data: unknown) {
  queryHarness.__setQueryResultForTests({
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data })),
  });
}

beforeEach(() => {
  queryHarness.__resetQueryResultForTests();
});

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
});

describe("CohortFunnelDetail", () => {
  it("renders one block per signup cohort, newest first", async () => {
    loaded(VIEW);
    const screen = await render(<CohortFunnelDetail months={12} />);
    expect(screen.getByText("2026-08")).toBeTruthy();
    expect(screen.getByText("2026-07")).toBeTruthy();
    expect(screen.getByText(/Newest cohort first/u)).toBeTruthy();
  });

  it("carries each rate's own denominator on the line it belongs to", async () => {
    loaded(VIEW);
    const screen = await render(<CohortFunnelDetail months={12} />);
    // Both lines are hidden from VoiceOver on purpose — the block speaks them
    // as one sentence — so the query has to opt into hidden elements.
    const opts = { includeHiddenElements: true } as const;
    expect(screen.getByText("34 · 11% of signups", opts)).toBeTruthy();
    expect(screen.getByText("9 · 26% of first purchasers", opts)).toBeTruthy();
    // And in the spoken row, where a cell-by-cell reading loses them entirely.
    expect(
      screen.getByLabelText(
        /2026-07: 300 signups, 34 first purchases, 11% of signups, 9 repeat purchases, 26% of first purchasers\./u,
      ),
    ).toBeTruthy();
  });

  it("re-keys the query with the chosen tag NAME and says the bars are unscoped", async () => {
    loaded(VIEW);
    const screen = await render(<CohortFunnelDetail months={12} />);
    expect(screen.queryByText(/Scoped to audience/u)).toBeNull();

    await fireEvent.press(screen.getByLabelText("vip"));

    const keys = queryHarness
      .__getQueryOptionsForTests()
      .filter((entry) => entry.kind === "query")
      .map((entry) => entry.options.queryKey);
    expect(keys[keys.length - 1]).toContain("vip");
    expect(
      screen.getByText(/Scoped to audience “vip”: 500 signed up/u),
    ).toBeTruthy();
    expect(
      screen.getByText(/The stage bars above cover all subscribers\./u),
    ).toBeTruthy();
  });

  it("offers no audience row at all when the tag catalogue is unreadable", async () => {
    const previous = tags.data;
    tags.data = null as unknown as typeof tags.data;
    loaded(VIEW);
    const screen = await render(<CohortFunnelDetail months={12} />);
    expect(screen.queryByText("vip")).toBeNull();
    // The table itself is a different scope (read:reports) and still renders.
    expect(screen.getByText("2026-08")).toBeTruthy();
    tags.data = previous;
  });

  it("names the window and the scope when the server returned no cohorts", async () => {
    loaded({ rows: [], stages: [] });
    const screen = await render(<CohortFunnelDetail months={12} />);
    expect(
      screen.getByText(/No signups in the last 12 signup months/u),
    ).toBeTruthy();
  });
});
