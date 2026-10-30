/**
 * BotOpenSplitSection — "how much of that open rate is machines?", asked on
 * the screen that shows the open rate.
 *
 * This card is a claim about real numbers, so what these tests pin is what it
 * is NOT allowed to do:
 *
 *  - NO PERCENTAGE, ANYWHERE. The server returns four integers and no share.
 *    Rounding one here turns 4 machine opens in 5,000 into "0% machines" —
 *    which is a different sentence from the one the server can support, and
 *    the one a reader would act on. The whole rendered tree is checked for a
 *    `%`, because the failure is a helpful addition rather than a crash.
 *  - THE SERVER'S OWN VOCABULARY. `by_signature` labels name real detectors;
 *    a client-side rewording describes a detector that does not exist.
 *  - PARTS THAT DON'T SUM ARE REPORTED, NOT CORRECTED. Silently fixing the
 *    total hides the drift a reader most needs to see.
 *  - NO REGEX SCAN ON MOUNT. The stats read scans the tenant's open history;
 *    it must wait to be asked, and refuse offline rather than look empty.
 *
 * The sentences themselves are pinned in src/lib/botOpenSplit.test.ts.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import React from "react";

import { BotOpenSplitSection } from "@/components/analytics/BotOpenSplitSection";

const queryHooks = require("./mocks/queryHooks.cjs");

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryOptionsForTests: () => {
    kind: string;
    options: { enabled?: boolean; queryKey?: unknown };
  }[];
};

const ARM = "Check how many opens were machines";

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

/** The stats payload, in the shape `api/botOpens` parses it into. */
function stats(over: Record<string, unknown> = {}) {
  return {
    totalOpens: 5000,
    botOpens: 4,
    humanOpens: 4996,
    since: "2026-08-01T00:00:00Z",
    bySignature: [{ label: "GoogleImageProxy", opens: 3 }],
    ...over,
  };
}

function statsQueries() {
  return queryHarness
    .__getQueryOptionsForTests()
    .filter((entry) =>
      JSON.stringify(entry.options.queryKey ?? []).includes("bot-open-stats"),
    );
}

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("BotOpenSplitSection", () => {
  it("does not scan the open history until asked", async () => {
    const screen = await render(<BotOpenSplitSection />);
    expect(screen.getByLabelText(ARM)).toBeTruthy();
    expect(statsQueries()).toHaveLength(0);
    // And the reader learns where signatures are edited before paying for a
    // scan, not after it.
    expect(
      screen.getByText(
        "Detection signatures are added and removed on the Deliverability screen.",
      ),
    ).toBeTruthy();
  });

  it("prints the server's three counts and never a machine share", async () => {
    queryHarness.__setQueryResultForTests(settled(stats()));
    const screen = await render(<BotOpenSplitSection />);
    await fireEvent.press(screen.getByLabelText(ARM));

    expect(
      screen.getByText(
        "5,000 opens: 4 matched a machine signature, 4,996 did not.",
      ),
    ).toBeTruthy();
    // A percentage anywhere in the tree is the defect: 4 in 5,000 rounds to
    // "0% machines", which the server never said.
    expect(JSON.stringify(screen.toJSON())).not.toContain("%");
    // Loose on the rendering (device locale and timezone decide it) and exact
    // on the claim: the window is stated, because the counts mean nothing
    // without it.
    expect(screen.getByText(/^Opens recorded since .*2026.*\.$/u)).toBeTruthy();
  });

  it("renders the detection signature's own label, not a friendlier one", async () => {
    queryHarness.__setQueryResultForTests(
      settled(
        stats({
          bySignature: [
            { label: "GoogleImageProxy", opens: 1200 },
            { label: "Apple MPP", opens: 40 },
          ],
        }),
      ),
    );
    const screen = await render(<BotOpenSplitSection />);
    await fireEvent.press(screen.getByLabelText(ARM));

    expect(screen.getByText("GoogleImageProxy")).toBeTruthy();
    expect(screen.getByLabelText("GoogleImageProxy, 1,200 opens")).toBeTruthy();
    expect(screen.getByText("Apple MPP")).toBeTruthy();
  });

  it("reports parts that do not sum instead of correcting either number", async () => {
    queryHarness.__setQueryResultForTests(
      settled(stats({ botOpens: 10, humanOpens: 4996 })),
    );
    const screen = await render(<BotOpenSplitSection />);
    await fireEvent.press(screen.getByLabelText(ARM));

    expect(screen.getByText(/don't add up to the total/u)).toBeTruthy();
    // Both reported numbers still stand as sent.
    expect(screen.getByText(/10 matched a machine signature/u)).toBeTruthy();
  });

  it("says there is no split rather than a zero when nothing was opened", async () => {
    queryHarness.__setQueryResultForTests(
      settled(
        stats({ totalOpens: 0, botOpens: 0, humanOpens: 0, bySignature: [] }),
      ),
    );
    const screen = await render(<BotOpenSplitSection />);
    await fireEvent.press(screen.getByLabelText(ARM));

    expect(
      screen.getByText(
        "No opens recorded in this window, so there is no machine/human split to report yet.",
      ),
    ).toBeTruthy();
  });

  it("says a failed read is not a reading of zero machine opens", async () => {
    queryHarness.__setQueryResultForTests({
      data: undefined,
      error: Object.assign(new Error("boom"), { status: 500 }),
      isError: true,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isSuccess: false,
      refetch: async () => ({ data: undefined }),
    });
    const screen = await render(<BotOpenSplitSection />);
    await fireEvent.press(screen.getByLabelText(ARM));

    expect(
      screen.getByText(
        "The machine/human split couldn't be read. This is not a reading of zero machine opens.",
      ),
    ).toBeTruthy();
  });

  it("refuses offline rather than presenting an unread split as empty", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    const screen = await render(<BotOpenSplitSection />);

    expect(screen.getByText("Open quality can't be read offline.")).toBeTruthy();
    expect(screen.queryByLabelText(ARM)).toBeNull();
    expect(statsQueries()).toHaveLength(0);
  });
});
