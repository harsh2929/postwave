/**
 * The approvals badge mounts in the TAB LAYOUT — unconditionally, for the whole
 * session — and shares one cache entry with the approvals LIST screen. Both
 * observers previously asked for the list's 60-second cadence, so every admin
 * spent their entire session issuing 60 requests an hour to keep a number
 * fresh that only changes when somebody else submits something for review.
 *
 * TanStack v5 gives each observer its own refetch timer over the shared entry,
 * so asking for different cadences is safe and composes the right way round:
 * the shortest MOUNTED observer wins. These tests pin both halves — that the
 * badge asks for the slow one and the list still asks for the fast one —
 * because either half alone is a bug. Slowing the list would leave an operator
 * staring at a stale governance queue; leaving the badge fast changes nothing.
 */
import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above every const in the file, so the spy has to be
// created inside vi.hoisted to exist by the time the factory runs.
const { useQuery } = vi.hoisted(() => ({
  useQuery: vi.fn((_options: { refetchInterval?: unknown; refetchIntervalInBackground?: unknown }) => ({
    data: [] as unknown[],
    isSuccess: true,
  })),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/api/client", () => ({ getClient: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => ({ enabled: true, tenantId: "t1" }),
}));

// eslint-disable-next-line import/first
import {
  APPROVALS_BADGE_POLL_MS,
  APPROVALS_LIST_POLL_MS,
  usePendingApprovals,
  usePendingApprovalsCount,
  usePendingApprovalsPublishable,
} from "./useApprovals";

/** The refetchInterval the last useQuery call asked for. */
function lastInterval(): unknown {
  return useQuery.mock.calls.at(-1)?.[0]?.refetchInterval;
}

describe("approvals poll cadence", () => {
  it("gives the list screen the fast cadence", () => {
    useQuery.mockClear();
    usePendingApprovals(true);
    expect(lastInterval()).toBe(APPROVALS_LIST_POLL_MS);
    expect(APPROVALS_LIST_POLL_MS).toBe(60_000);
  });

  it("gives the always-mounted tab badge the slow one", () => {
    useQuery.mockClear();
    usePendingApprovalsCount(true);
    expect(lastInterval()).toBe(APPROVALS_BADGE_POLL_MS);
  });

  it("gives the widget's publishable count the slow one too", () => {
    useQuery.mockClear();
    usePendingApprovalsPublishable(true);
    expect(lastInterval()).toBe(APPROVALS_BADGE_POLL_MS);
  });

  it("keeps the badge cadence aligned with the notification feed", () => {
    // useAppBadgeSync polls the feed at 5 minutes. Two always-mounted pollers
    // on different clocks is how a phone ends up waking for one of them every
    // couple of minutes; matching them lets the radio sleep between.
    expect(APPROVALS_BADGE_POLL_MS).toBe(5 * 60_000);
    expect(APPROVALS_BADGE_POLL_MS).toBeGreaterThan(APPROVALS_LIST_POLL_MS);
  });

  it("never polls in the background, at either cadence", () => {
    useQuery.mockClear();
    usePendingApprovals(true);
    // A backgrounded app polling a governance queue is battery spent on a
    // screen nobody is looking at.
    expect(
      useQuery.mock.calls.at(-1)?.[0]?.refetchIntervalInBackground,
    ).toBe(false);
  });
});
