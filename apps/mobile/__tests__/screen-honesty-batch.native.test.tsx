/**
 * Four claims a screen must not make when it has not measured anything.
 *
 * Each block below pins one finding from the state audit of this batch. They
 * share a file because they share a thesis: an ABSENT measurement — a failed
 * fetch, a disabled query, a mutation the transport will never start — must
 * never be rendered as a successful zero, a clean empty state, or an offered
 * button.
 *
 *   1. DASHBOARD / AuditFeedCard. The API declares
 *      `RecentAudit []DashboardAuditEvent json:"recent_audit,omitempty"` and
 *      deliberately leaves it EMPTY ("audit actor/action data belongs behind
 *      the dedicated audit:read surface"), so omitempty drops the key on every
 *      response and the /audit fallback is this card's only production source.
 *      A 403 for a role without `audit:read` therefore printed "No recent
 *      activity." on the landing screen, permanently.
 *
 *   2. SUPPRESSIONS / SuppressionTrendHeader. `useSuppressionTrend` is gated on
 *      `gate.enabled && tenantId`, so offline it is DISABLED — not loading, not
 *      errored, `data` undefined — and the tiles coerced that with `?? 0` into
 *      "0 new this week · 0 bounces · 0 complaints" on a compliance screen.
 *
 *   3. SUPPRESSIONS / SuppressionHeaderActions. The "+" sheet POSTs to the
 *      EMAIL suppression table. Offered above the PUSH roster it accepted an
 *      address, said "suppressed", and wrote a row the operator could not see.
 *
 *   4. REVIEWS. The app's default mutation policy is `networkMode: "online"`,
 *      so a moderation started with no connection is PAUSED by TanStack:
 *      `mutateAsync` neither resolves nor rejects. Every catch below it hangs,
 *      no toast fires, and `moderate.isPending` latches true — which the guard
 *      at the top of `decide` reads as "already running", blocking every later
 *      tap for the life of the screen.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { AuditFeedCard } from "@/components/dashboard/AuditFeedCard";
import { SuppressionHeaderActions } from "@/components/deliverability/SuppressionHeaderActions";
import { SuppressionTrendHeader } from "@/components/deliverability/SuppressionTrendHeader";
import { parseReviewList, type MobileReview } from "@/lib/reviewQueue";
import {
  parseSuppressionTrend,
  type SuppressionTrend,
} from "@/lib/suppressionContracts";

import Reviews from "../app/(tabs)/reviews";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __setIsOnlineForTests: (value: boolean) => void;
  __resetOnlineGateForTests: () => void;
};

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

const EMPTY_COPY = "No recent activity.";

describe("dashboard audit feed: a failed fetch is not an empty workspace", () => {
  it("does not claim there is no activity when the fetch failed", async () => {
    await render(<AuditFeedCard events={undefined} loading={false} failed />);

    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    // And it says so, rather than rendering an empty card with no explanation.
    expect(
      screen.getByText(/Recent activity couldn't be loaded/i),
    ).toBeTruthy();
  });

  it("still says 'no activity' for a SUCCESSFUL empty fetch", async () => {
    // Without this, a card hard-coded to the failure string would pass above.
    await render(
      <AuditFeedCard events={[]} loading={false} failed={false} />,
    );

    expect(screen.getByText(EMPTY_COPY)).toBeTruthy();
  });

  it("still renders real rows — the failure branch must not swallow them", async () => {
    await render(
      <AuditFeedCard
        events={[
          {
            id: "a1",
            action: "campaign.sent",
            actor: "ava@example.test",
            at: "2026-08-18T10:00:00Z",
            description: "sent a campaign",
          },
        ]}
        loading={false}
        failed={false}
      />,
    );

    expect(screen.getByText(/sent a campaign/)).toBeTruthy();
  });

  it("survives a truthy NON-ARRAY payload instead of throwing on .slice", async () => {
    for (const hostile of [{}, { items: [] }, "nope", 7, true]) {
      await expect(
        render(
          <AuditFeedCard events={hostile as never} loading={false} />,
        ),
      ).resolves.toBeTruthy();
    }
  });
});

describe("suppression trend: an unmeasured figure is an em-dash, not zero", () => {
  const EMDASH = "—";

  it("renders em-dashes when the trend never loaded", async () => {
    // The exact shape of a DISABLED query: undefined data, isLoading false.
    await render(
      <SuppressionTrendHeader trend={undefined} total={412} loading={false} />,
    );

    // Three tiles: New · 7d, Bounces, Complaints. The level ("Suppressed")
    // comes from the page query and is genuinely 412 here.
    expect(screen.getAllByText(EMDASH).length).toBeGreaterThanOrEqual(3);
    // A hard zero on a compliance surface is the specific lie being pinned.
    expect(screen.queryByText("0")).toBeNull();
  });

  it("still renders the real figures when the trend DID load", async () => {
    // A component that returned an em-dash unconditionally would pass above.
    // Built through the real parser rather than hand-typed, so the fixture
    // cannot drift from the shape the product actually produces.
    const trend: SuppressionTrend = parseSuppressionTrend({
      days: 30,
      items: [
        { date: "2026-08-17", count: 5, by_reason: { hard_bounce: 5 } },
        { date: "2026-08-18", count: 12, by_reason: { complaint: 12 } },
      ],
    });

    await render(
      <SuppressionTrendHeader trend={trend} total={412} loading={false} />,
    );

    // last7 = 5 + 12; bounces = 5; complaints = 12.
    expect(screen.getByText("17")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });
});

describe("suppression header: add writes to the EMAIL table", () => {
  const noop = () => undefined;

  function actions(channel: "email" | "push") {
    return (
      <SuppressionHeaderActions
        channel={channel}
        canWrite
        rowCount={5}
        total={5}
        online
        selecting={false}
        exporting={false}
        onSelect={noop}
        onExport={noop}
        onAdd={noop}
        onMirror={noop}
      />
    );
  }

  it("hides the add action above the push roster", async () => {
    await render(actions("push"));

    expect(screen.queryByLabelText("Suppress an address")).toBeNull();
  });

  it("still offers it on the email channel", async () => {
    await render(actions("email"));

    expect(screen.getByLabelText("Suppress an address")).toBeTruthy();
  });
});

describe("reviews: a decision is never started without a connection", () => {
  function review(overrides: Record<string, unknown> = {}): MobileReview {
    return parseReviewList({
      items: [
        {
          id: "rev-1",
          rating: 5,
          title: "Great",
          body: "Loved it",
          status: "pending",
          reviewer_name: "Sam",
          created_at: "2026-08-18T09:00:00Z",
          ...overrides,
        },
      ],
    })[0]!;
  }

  function loaded(rows: readonly MobileReview[]) {
    return {
      data: rows,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({ data: rows })),
    };
  }

  it("offers the swipe verbs to an admin who is online", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    queryHarness.__setQueryResultForTests(loaded([review()]));

    await render(<Reviews />, { wrapper });

    expect(screen.getByText("Publish")).toBeTruthy();
    expect(screen.getByText("Reject")).toBeTruthy();
  });

  it("withholds them offline, where the mutation would pause and never settle", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    gateHarness.__setIsOnlineForTests(false);
    queryHarness.__setQueryResultForTests(loaded([review()]));

    await render(<Reviews />, { wrapper });

    expect(screen.queryByText("Publish")).toBeNull();
    expect(screen.queryByText("Reject")).toBeNull();
    // The row itself must still be there — this is a withheld verb, not a
    // hidden queue.
    expect(screen.getByText("Great")).toBeTruthy();
  });
});
