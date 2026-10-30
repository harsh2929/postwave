import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The Deliverability hub had 2,600 lines of screen code in this cluster and
 * one unit test of a single parser. That is precisely why the offline-empty
 * bugs survived: nothing pinned a STATE LADDER, so "offline" and "no data"
 * rendered the same and nobody could tell.
 *
 * These tests pin the three rungs that carry a claim about the world:
 *   - a live hub renders the score, the auto-throttle alarm and the diagnostic
 *     block below it;
 *   - a failed side-read says it FAILED, never "nothing to report";
 *   - the offline rung says "offline", never "no deliverability data".
 *
 * Mock shapes match the hooks' real return types exactly — a `{data: {...}}`
 * shim where the hook returns `{value, fromSnapshot}` passes only on the error
 * path and hides every loaded-state assertion.
 */
const mockHubQuery: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  refetch: jest.fn(async () => undefined),
};

const mockBlocklistQuery: {
  data: unknown;
  isError: boolean;
  refetch: () => Promise<unknown>;
} = { data: [], isError: false, refetch: jest.fn(async () => undefined) };

const mockDiagnostics = {
  isp: { data: undefined as unknown, isError: false },
  bounces: { data: undefined as unknown, isError: false },
  push: {
    data: undefined as unknown,
    isError: false,
    isSuccess: false,
    isPending: false,
    access: {
      roleAllowed: false,
      denialReason: "Registry restricted" as string | null,
    },
  },
  sendWindow: { data: undefined as unknown, isError: false },
  warmup: { data: undefined as unknown, isError: false },
  today: { data: undefined as unknown, isError: false },
};

jest.mock("@/hooks/useDeliverability", () => ({
  useDeliverabilityHub: () => mockHubQuery,
  useBlocklistHits: () => mockBlocklistQuery,
}));

const mockSetTier = { mutate: jest.fn(), isPending: false };

/**
 * The home-screen widget's sender-health writer (DELIVERABILITY#64). Mocked at
 * the App Group boundary rather than below it, so what is asserted is the
 * PAYLOAD this screen publishes — the thing a home screen would render — and
 * not that some native call happened.
 */
const mockWriteDeliverabilityWidget =
  jest.fn<(input: Record<string, unknown>) => unknown>();

jest.mock("@/lib/widgetDeliverability", () => ({
  writeDeliverabilityWidgetSnapshot: (input: Record<string, unknown>) =>
    mockWriteDeliverabilityWidget(input),
  clearDeliverabilityWidgetSnapshot: () => true,
  hasPublishedDeliverabilityWidget: () => false,
}));

jest.mock("@/hooks/useDeliverabilityDiagnostics", () => ({
  useIspBreakdown: () => mockDiagnostics.isp,
  useBounceClasses: () => mockDiagnostics.bounces,
  useSendWindow: () => mockDiagnostics.sendWindow,
  useWarmupPlans: () => mockDiagnostics.warmup,
  useWarmupToday: () => mockDiagnostics.today,
  useSetSendWindowTier: () => mockSetTier,
  useSetWarmupStatus: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock("@/hooks/usePushSuppressions", () => ({
  usePushSuppressionAccess: () => mockDiagnostics.push.access,
  usePushSuppressions: () => mockDiagnostics.push,
}));

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import Deliverability from "../app/(tabs)/deliverability";

/**
 * The gate is served by `__tests__/mocks/queryHooks.cjs`, whose test-only
 * escape hatches are not on the real module's type. Same harness cast the
 * other route suites use.
 */
const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const SEND_WINDOW = {
  startLocal: "09:00",
  endLocal: "17:00",
  timezone: "America/New_York",
  weekdayBitmap: 62,
  weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  enforcement: "block" as const,
};

function hub(over: Record<string, unknown> = {}) {
  return {
    value: {
      score: 62,
      grade: "Fair",
      status: "degraded",
      trend: "down",
      trendDelta: 9,
      history: [88, 84, 71, 62],
      bounceRate: 0.061,
      complaintRate: 0.0004,
      engagementRate: 0.21,
      windowDays: 30,
      sends7d: 41200,
      autoThrottled: true,
      autoThrottleReason: "bounce rate above 5%",
      breaches: [
        {
          code: "bounce_rate",
          severity: "critical",
          title: "Bounce rate above 5%",
          detail: "Clean the list before the next send.",
          fixLabel: "Clean list",
        },
      ],
      blocklistHits: [],
      computedAt: "2026-07-25T09:00:00Z",
      ...over,
    },
    fromSnapshot: false,
    capturedAt: null,
  };
}

async function renderScreen() {
  return await render(React.createElement(Deliverability), {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

function resetQueries() {
  mockHubQuery.data = undefined;
  mockHubQuery.isLoading = false;
  mockHubQuery.isError = false;
  mockBlocklistQuery.data = [];
  mockBlocklistQuery.isError = false;
  mockDiagnostics.isp = { data: undefined, isError: false };
  mockDiagnostics.bounces = { data: undefined, isError: false };
  mockDiagnostics.push = {
    data: undefined,
    isError: false,
    isSuccess: false,
    isPending: false,
    access: { roleAllowed: false, denialReason: "Registry restricted" },
  };
  mockDiagnostics.sendWindow = { data: undefined, isError: false };
  mockDiagnostics.warmup = { data: undefined, isError: false };
  mockDiagnostics.today = { data: undefined, isError: false };
  mockSetTier.mutate.mockClear();
  mockWriteDeliverabilityWidget.mockClear();
  mockWriteDeliverabilityWidget.mockReturnValue(null);
  gateHarness.__resetOnlineGateForTests();
}

describe("deliverability hub — a snapshot whose shape we cannot read", () => {
  it("survives non-array breaches and blocklist hits", async () => {
    // The hub is SNAPSHOT-BACKED, and `loadSnapshotBacked`'s `isStored` guard
    // checks only that the vault record has a `value` key and a numeric
    // `capturedAt` — never that the fields inside it are the shape this build
    // expects. A snapshot written by a build with a different payload (or a
    // restored persisted query cache) therefore reaches `sortedBreaches`,
    // which SPREADS its argument, and `(hub.blocklistHits ?? []).map`. Both
    // threw and took the one screen an operator opens to ask "are we
    // throttled?" with them.
    resetQueries();
    mockHubQuery.data = hub({
      breaches: { items: [] },
      blocklistHits: { items: [] },
    });
    await expect(renderScreen()).resolves.toBeTruthy();
    // Still the screen, not a blank: the score it exists to show is on it.
    expect(screen.getByText("62")).toBeTruthy();
  });
});

describe("deliverability hub", () => {
  it("renders the score, the auto-throttle alarm and the diagnostic block", async () => {
    resetQueries();
    mockHubQuery.data = hub();
    mockDiagnostics.isp = {
      data: {
        windowDays: 30,
        buckets: [
          {
            isp: "gmail",
            label: "Gmail",
            subscribers: 8000,
            opens: 3000,
            clicks: 400,
            bounces: 12,
            complaints: 1,
            openRate: 0.375,
            bounceRate: 0.0015,
            complaintRate: 0.0001,
          },
          {
            isp: "outlook",
            label: "Microsoft",
            subscribers: 2000,
            opens: 200,
            clicks: 10,
            bounces: 150,
            complaints: 4,
            openRate: 0.1,
            bounceRate: 0.075,
            complaintRate: 0.002,
          },
        ],
      },
      isError: false,
    };
    mockDiagnostics.bounces = {
      data: {
        windowDays: 30,
        totalBounces: 162,
        classes: [
          { code: "hard", label: "Hard bounce", count: 130, share: 0.802 },
          { code: "soft", label: "Soft bounce", count: 32, share: 0.198 },
        ],
      },
      isError: false,
    };

    const screen = await renderScreen();

    // The score, spoken as a sentence rather than as a bare number.
    expect(
      screen.getByLabelText(/Deliverability score 62 out of 100, graded Fair/),
    ).toBeTruthy();
    // Auto-throttle is the one thing an operator must not miss.
    expect(screen.getByText("Bounce rate above 5%")).toBeTruthy();
    // The diagnostic block: the ISP verdict is STATED, not left to be derived.
    expect(screen.getByText(/Microsoft is bouncing 7\.5%/)).toBeTruthy();
    expect(screen.getByText(/Gmail is fine at/)).toBeTruthy();
    // …and the bounce-class ranking is present with its counts.
    expect(screen.getByText("Why they bounced")).toBeTruthy();
    expect(
      screen.getByLabelText(/Hard bounce: 130 bounces, 80% of the total/),
    ).toBeTruthy();
    // The throttle release card is WIRED under the banner that names the
    // throttle. This test says nothing about who may PRESS it — the shared
    // gate fixture defaults to `effectiveRole: "owner"`, so the session here
    // is an admin one; the read-only rendering is pinned by the send-window
    // test below, which asks for a below-admin role by name.
    expect(screen.getByText("Repair active")).toBeTruthy();
    // The 2026-08 ops cluster is wired below the diagnostics: ingestion
    // health and the retry queue are its sentinel cards.
    expect(screen.getByText("Ingestion health")).toBeTruthy();
    // `IntelligentRetryCard`'s heading, quoted exactly. It has been "Retry
    // queue" since the card shipped — "Held retries" was never a string this
    // app rendered, on this card or any other, so the assertion could only
    // ever fail and it told nobody whether the card was mounted.
    expect(screen.getByText("Retry queue")).toBeTruthy();
  });

  it("says a failed side-read FAILED rather than showing an empty section", async () => {
    resetQueries();
    mockHubQuery.data = hub();
    mockDiagnostics.isp = { data: undefined, isError: true };
    mockDiagnostics.bounces = { data: undefined, isError: true };

    const screen = await renderScreen();
    expect(
      screen.getByText(/The provider breakdown couldn't be loaded/),
    ).toBeTruthy();
    // Both failed reads say so — the count is the point: neither card is
    // allowed to fall back to a confident empty state.
    expect(
      screen.getAllByText(/This is a failed read, not an empty result/),
    ).toHaveLength(2);
    // The verdict sentence must NOT appear — asserting "every provider is
    // fine" off a failed read is the exact lie this rung exists to prevent.
    expect(screen.queryByText(/is bouncing/)).toBeNull();
  });

  it("never turns a pending customer-push read into a zero registry claim", async () => {
    resetQueries();
    mockHubQuery.data = hub();
    mockDiagnostics.push = {
      data: undefined,
      isError: false,
      isSuccess: false,
      isPending: true,
      access: { roleAllowed: true, denialReason: null },
    };

    const screen = await renderScreen();
    expect(screen.getByText("Loading the customer push registry…")).toBeTruthy();
    expect(
      screen.queryByText(/verified registry snapshot contains no active/iu),
    ).toBeNull();
  });

  it("never renders the diagnostic block when the hub itself is empty", async () => {
    resetQueries();
    mockHubQuery.data = undefined;

    const screen = await renderScreen();
    expect(screen.getByText("No deliverability data yet")).toBeTruthy();
    // Five diagnostic reads firing behind an empty hub would be five spinners
    // under an empty state.
    expect(screen.queryByText("Where mail lands")).toBeNull();
    expect(screen.queryByText("Customer push registry")).toBeNull();
  });

  it("labels a cached read as cached instead of passing it off as live", async () => {
    resetQueries();
    mockHubQuery.data = {
      ...hub(),
      fromSnapshot: true,
      capturedAt: Date.now() - 3_600_000,
    };

    const screen = await renderScreen();
    expect(
      screen.getByLabelText(/Cached .* reconnect to refresh/i),
    ).toBeTruthy();
  });

  it("shows the blocking send window read-only to a non-admin", async () => {
    resetQueries();
    // EDITOR, named out loud. `HubDiagnostics` derives `canEdit` from
    // `isAdminRole(gate.effectiveRole)`, and editor is the highest role that
    // must not get the tier switch — the boundary this test exists for.
    //
    // The role cannot be left to the fixture: the shared OPEN_GATE defaults to
    // `effectiveRole: "owner"`, so an un-configured gate is the most
    // privileged session there is, and "read-only to a non-admin" would be
    // demanding that an OWNER be denied a control they are entitled to.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    mockHubQuery.data = hub();
    mockDiagnostics.sendWindow = { data: SEND_WINDOW, isError: false };

    const screen = await renderScreen();
    expect(screen.getByLabelText("Enforcement is blocking")).toBeTruthy();
    expect(
      screen.getByText(
        "09:00–17:00 America/New_York · Mon, Tue, Wed, Thu, Fri",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Sends scheduled outside this window are refused."),
    ).toBeTruthy();
    // A control that can only 403 is worse than no control.
    expect(screen.queryByLabelText("Send-window enforcement")).toBeNull();
    expect(
      screen.getByText("Only an admin can change the enforcement tier."),
    ).toBeTruthy();
  });

  it("lets an admin flip block → warn without rewriting the window", async () => {
    resetQueries();
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockHubQuery.data = hub();
    mockDiagnostics.sendWindow = { data: SEND_WINDOW, isError: false };

    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText("Warn"));

    expect(mockSetTier.mutate).toHaveBeenCalledTimes(1);
    const [input] = mockSetTier.mutate.mock.calls[0] as [
      { policy: typeof SEND_WINDOW; tier: string },
    ];
    expect(input.tier).toBe("warn");
    // The WHOLE policy goes back: PUT is a full upsert that defaults an
    // omitted weekday_bitmap to 126, so sending `{enforcement}` alone would
    // silently rewrite a Sat/Sun-inclusive window to Mon–Fri.
    expect(input.policy).toEqual(SEND_WINDOW);
  });
});

/**
 * DELIVERABILITY#64 — this screen is the only foreground writer of the
 * home-screen widget's sender-health record. Sender health is the number whose
 * value is highest when it is checked PASSIVELY, so what matters is that the
 * numbers reaching the App Group are the ones on screen, stamped with the time
 * the SERVER computed them.
 */
describe("deliverability hub — home-screen widget mirror", () => {
  it("publishes the on-screen score, grade, throttle state and evidence", async () => {
    resetQueries();
    mockHubQuery.data = hub({ grade: "D", status: "Degraded" });

    await renderScreen();

    expect(mockWriteDeliverabilityWidget).toHaveBeenCalledTimes(1);
    const [published] = mockWriteDeliverabilityWidget.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(published).toEqual({
      score: 62,
      grade: "D",
      status: "Degraded",
      autoThrottled: true,
      breaches: 1,
      sends7d: 41200,
      // The SERVER's computed_at, not this device's clock — the hub query is
      // snapshot-backed, so an offline replay must age rather than re-stamp.
      measuredAtMs: Date.parse("2026-07-25T09:00:00Z"),
    });
  });

  it("publishes NOTHING when the grade did not come from the scorer", async () => {
    resetQueries();
    // The scorer emits exactly A|B|C|D|F (hub.go:526-538). Anything else means
    // the payload drifted — and `parseDeliverabilityHub` would have coerced a
    // missing score to 0, i.e. to the worst possible verdict. A home screen
    // reading "0 · Critical" over a schema change is the failure this refuses.
    mockHubQuery.data = hub({ grade: "Fair" });

    await renderScreen();

    expect(mockWriteDeliverabilityWidget).not.toHaveBeenCalled();
  });

  it("publishes nothing when the server did not say when it measured", async () => {
    resetQueries();
    mockHubQuery.data = hub({ grade: "B", status: "Good", computedAt: "" });

    await renderScreen();

    expect(mockWriteDeliverabilityWidget).not.toHaveBeenCalled();
  });

  it("writes once per mount, not once per render", async () => {
    resetQueries();
    mockHubQuery.data = hub({ grade: "B", status: "Good" });

    await renderScreen();

    // A widget reload is a budgeted iOS resource; spending it on identical
    // data makes one unavailable when something genuinely changes. The
    // re-publish RULE itself (fingerprint + re-stamp window) is pinned
    // exhaustively in src/lib/widgetDeliverabilitySnapshot.test.ts; what this
    // asserts is that mounting a screen whose SectionList renders many rows
    // does not turn into many writes.
    expect(mockWriteDeliverabilityWidget).toHaveBeenCalledTimes(1);
  });
});
