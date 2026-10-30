/**
 * Referrals — the render contract for the read-only inspection surface.
 *
 * WHAT THIS FILE EXISTS TO CATCH. This screen makes three separate claims off
 * three separate queries — what the programme gives away, what the funnel did,
 * and who is on the leaderboard — and the worst way any of them can fail is
 * QUIETLY. "No referral programme configured." is a legitimate resting state
 * (the route answers 404 when nothing is set up, and `useReferralProgram` maps
 * that to `null` data on purpose), which is exactly what makes it dangerous:
 * a 500 also leaves `data` undefined, and the card cannot tell the two apart.
 * Saying a workspace has no referral programme because a GET broke is the
 * failure mode this file pins shut.
 *
 * THE HARNESS SETS ONE RESULT FOR EVERY `useQuery` in the module graph, so a
 * payload here reaches the programme, the stats and the leaderboard queries at
 * once. That is fine for the states asserted below — failure and offline are
 * screen-wide by construction — and each assertion names the copy owned by the
 * query it is about.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import {
  REFERRAL_EMPTY_WINDOW_DESCRIPTION,
  REFERRAL_PROGRAM_READ_ONLY_NOTE,
  REFERRAL_RUNTIME_AVAILABLE,
  REFERRAL_RUNTIME_NOTICE,
  SUBSCRIBER_REFERRAL_ROLE_NOTE,
  parseReferralProgram,
} from "@/lib/referrals";

import Referrals from "../app/(tabs)/referrals";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  /** Every options object handed to `useQuery`, in call order. */
  __getQueryOptionsForTests: () => {
    kind: string;
    options: { queryKey?: unknown[]; enabled?: boolean };
  }[];
};
const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

/**
 * The subscriber-link query's options, newest last.
 *
 * This is how the no-prefetch invariant is observed from a render test at all.
 * The harness replaces `useQuery`, so nothing here can watch a request go out —
 * but it RECORDS every options object, and `enabled` is the exact switch that
 * decides whether TanStack issues the code-minting GET. Reading it is reading
 * the decision, not a proxy for it.
 */
function subscriberLinkQueries() {
  return queryHarness
    .__getQueryOptionsForTests()
    .filter(
      (entry) =>
        Array.isArray(entry.options.queryKey) &&
        entry.options.queryKey[0] === "referrals" &&
        entry.options.queryKey[1] === "subscriber",
    )
    .map((entry) => ({
      enabled: entry.options.enabled,
      subscriberId: (entry.options.queryKey as unknown[])[3],
    }));
}

/** Ids the gate actually opened for, across the whole render so far. */
function mintedFor() {
  return subscriberLinkQueries()
    .filter((entry) => entry.enabled === true)
    .map((entry) => entry.subscriberId);
}

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

function settled(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data })),
  };
}

const FAILED = {
  data: undefined,
  error: new Error("boom"),
  isError: true,
  isFetching: false,
  isLoading: false,
  isPending: false,
  isRefetching: false,
  isSuccess: false,
  refetch: jest.fn(async () => ({ data: undefined })),
};

/** Built through the real parser, from the row the programme route serialises. */
const PROGRAM = parseReferralProgram({
  id: "rp-1",
  active: true,
  milestones: [{ count: 3, reward_label: "Free month", reward_kind: "credit" }],
  referee_reward_label: "10% off",
  verification_window_days: 30,
});

describe("the referrals surface", () => {
  it("renders a bounded first frame while the reads are still in flight", async () => {
    const view = await render(<Referrals />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    expect(screen.getByText("Referrals")).toBeTruthy();
  });

  it("reads a configured programme off the wire rather than describing it", async () => {
    queryHarness.__setQueryResultForTests(settled(PROGRAM));

    await render(<Referrals />, { wrapper });

    expect(screen.getByText(/Free month/)).toBeTruthy();
  });

  it("says a workspace has no programme only when the server said so", async () => {
    // `null` is what useReferralProgram returns for the route's 404 — the
    // genuine "nothing is configured" answer, and a legitimate resting state.
    queryHarness.__setQueryResultForTests(settled(null));

    await render(<Referrals />, { wrapper });

    expect(screen.getByText("No referral programme configured.")).toBeTruthy();
  });

  /**
   * THE ONE THIS FILE WAS WRITTEN FOR.
   *
   * A failed programme read leaves `data` undefined and `isLoading` false —
   * indistinguishable, to ReferralProgramCard's three-state ladder, from the
   * 404 above. The screen rendered "No referral programme configured." for a
   * 500, i.e. it denied the existence of a live referral scheme because a GET
   * broke. An error must win over the resting state, always.
   */
  it("renders a failed programme read as an error, never as 'no programme'", async () => {
    queryHarness.__setQueryResultForTests(FAILED);

    await render(<Referrals />, { wrapper });

    expect(screen.queryByText("No referral programme configured.")).toBeNull();
  });

  it("reads a cold offline session as offline, never as an empty workspace", async () => {
    // Nothing cached: `data` is undefined for every read on this screen.
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(settled(undefined));

    await render(<Referrals />, { wrapper });

    expect(screen.queryByText("No referral programme configured.")).toBeNull();
    expect(
      screen.queryByText("No credited referrals in this window"),
    ).toBeNull();
  });
});

/**
 * THE FALSE FACT, IN BOTH DIRECTIONS.
 *
 * This screen once opened with the "runtime is off" banner UNCONDITIONALLY,
 * which became a false fact when the A2 open landed; these tests then pinned
 * the banner's absence. On 2026-08-30 the server tree RE-CLOSED the gate
 * ("RELEASE REMAINS HELD…", referrals.go:46-52), so the truth flipped again
 * and so did the assertions: now the banner's PRESENCE is what stops the app
 * asserting that live conversions are being credited when nothing is.
 *
 * lib/referrals.boundary.test.ts is the other half — it holds the mirrored flag
 * to the Go source, so "the flag is right" and "the screen obeys the flag" fail
 * separately and say which is broken.
 */
describe("the runtime banner", () => {
  it("renders while the mirrored server gate is CLOSED", async () => {
    // Name the world first: RE-CLOSED 2026-08-30 ("RELEASE REMAINS HELD…",
    // referrals.go:46-52). With the gate shut, the banner is the one honest
    // voice about why nothing below is a live counter — its absence would be
    // the false fact this block has always existed to prevent.
    expect(REFERRAL_RUNTIME_AVAILABLE).toBe(false);
    queryHarness.__setQueryResultForTests(settled(PROGRAM));

    await render(<Referrals />, { wrapper });

    expect(screen.getByText(REFERRAL_RUNTIME_NOTICE.headline)).toBeTruthy();
    expect(screen.getByText(REFERRAL_RUNTIME_NOTICE.detail)).toBeTruthy();
  });

  it("keeps the read-only note a ROLE fact, not a runtime excuse", async () => {
    queryHarness.__setQueryResultForTests(settled(PROGRAM));

    await render(<Referrals />, { wrapper });

    // The default harness session carries no effective role, so the edit
    // affordance is withheld and the note renders — and it must still talk
    // about the role rule, never parrot the runtime state (the banner above
    // owns that claim).
    expect(screen.getByText(REFERRAL_PROGRAM_READ_ONLY_NOTE)).toBeTruthy();
    expect(screen.queryByText(/closed runtime/i)).toBeNull();
  });

  it("explains an empty leaderboard window WITH the closed-runtime cause", async () => {
    // No rows on any query: the leaderboard's own empty state is what renders.
    // With the gate closed, "nobody was credited" without the runtime clause
    // would read as an ordinary quiet period — the conditional copy
    // (referralsCopy.ts:145-147) must carry the cause.
    queryHarness.__setQueryResultForTests(settled({}));

    await render(<Referrals />, { wrapper });

    expect(screen.getByText("No credited referrals in this window")).toBeTruthy();
    expect(screen.getByText(REFERRAL_EMPTY_WINDOW_DESCRIPTION)).toBeTruthy();
    // getAllByText: the banner headline legitimately says it too.
    expect(screen.getAllByText(/runtime is off/i).length).toBeGreaterThan(0);
  });
});

/**
 * The reads and writes that exist only while the gate is open — all of them
 * withheld now, and WITHHELD IS THE ASSERTION. The open-world press-flow
 * suite (reveal-on-press, one-query-at-a-time, no-mint-on-scroll, the 403
 * rendered as a permission rule) lives in git history at the A2-open
 * revisions of this file and must come back with the flag; until then the
 * no-mint invariant is pinned in its strongest form — the affordance does not
 * exist and no link query is ever enabled — and the pure predicate keeps its
 * node coverage in lib/referralsAuthority.test.ts.
 */
describe("the gated surface while the release is held", () => {
  it("withholds the fulfilment ledger — its routes are unmounted", async () => {
    queryHarness.__setQueryResultForTests(
      settled({
        rows: [
          {
            id: "p1",
            referrerId: "11111111-2222-3333-4444-555555555555",
            milestone: 3,
            rewardLabel: "Free month",
            status: "pending",
            createdAt: "2026-08-01T00:00:00Z",
          },
        ],
        total: 9,
      }),
    );

    await render(<Referrals />, { wrapper });

    expect(screen.queryByText("Reward fulfilment")).toBeNull();
    expect(screen.queryByText("Free month")).toBeNull();
  });

  it("withholds Get link from EVERYONE — an owner included — and never arms the minting query", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    queryHarness.__setQueryResultForTests(
      settled({
        topReferrers: [
          {
            subscriberId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            count: 9,
            lastAt: "2026-08-20T00:00:00Z",
          },
        ],
      }),
    );

    await render(<Referrals />, { wrapper });

    // The counts still render — /referrals/stats is an ungated read.
    expect(screen.getByText("9 referrals")).toBeTruthy();
    // No affordance, no role note (the role is not the blocker; the banner
    // explains the absence), and no query ever enabled: the code-minting GET
    // cannot fire from a build whose server has it unmounted.
    expect(
      screen.queryByLabelText(/Get the referral link for referrer/),
    ).toBeNull();
    expect(screen.queryByText(SUBSCRIBER_REFERRAL_ROLE_NOTE)).toBeNull();
    expect(mintedFor()).toEqual([]);
  });
});
