import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

/**
 * SMS opt-outs (app/(tabs)/sms/suppressions.tsx) — the count claim.
 *
 * The private roster mixes reversible manual holds with source-authoritative
 * STOP/carrier/complaint state. A manufactured empty result can make an
 * operator misclassify that authority, so loading and failed reads must never
 * be presented as a verified zero.
 *
 * `SearchField`'s result line is an `accessibilityLiveRegion="polite"` Text, so
 * it is not decoration — VoiceOver ANNOUNCES it. The screen passed
 * `resultCount={rows.length}` unconditionally, and `rows` is derived from
 * `list.data ?? []`, so a first load and a failed GET both announced "0
 * numbers" while the list below them was still a skeleton or an error. Every
 * sibling screen already guards this: templates passes
 * `catalog.data ? rows.length : undefined`, approvals passes it only when the
 * query box is non-empty.
 *
 * `useSuppressionOps` is mocked here rather than through the shared queryHooks
 * proxy because that module also exports MUTATIONS, and the proxy would hand
 * `useRemoveSmsSuppression` back in the query shape — permanently `isPending`,
 * which would silently disable the row action these tests do not touch but a
 * later one would.
 */
const mockList: {
  data: unknown;
  isError: boolean;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
} = {
  data: undefined,
  isError: false,
  isLoading: true,
  isFetching: false,
  error: null,
  hasNextPage: false,
  isFetchingNextPage: false,
};
const mockRemove = jest.fn<(row: unknown) => Promise<void>>(
  async () => undefined,
);
const mockAdd = jest.fn<(phone: string) => Promise<void>>(
  async () => undefined,
);
const mockConfirm = jest.fn<(options: unknown) => Promise<boolean>>(
  async () => true,
);
const mockAccess: {
  identity: Record<string, unknown> | null;
  roleAllowed: boolean;
  canRequest: boolean;
  online: boolean;
  sessionReady: boolean;
  denialReason: string | null;
} = {
  identity: { fingerprint: "sms-admin-identity", tenantId: "tenant-1" },
  roleAllowed: true,
  canRequest: true,
  online: true,
  sessionReady: true,
  denialReason: null as string | null,
};
const mockUseSmsSuppressions = jest.fn();

jest.mock("@/hooks/useSuppressionOps", () => ({
  useSmsSuppressions: (...args: unknown[]) => {
    mockUseSmsSuppressions(...args);
    return {
      ...mockList,
      isFetching: mockList.isFetching,
      isSuccess: !mockList.isLoading && !mockList.isError,
      refetch: jest.fn(async () => ({ data: undefined })),
      refreshFirstPage: jest.fn(async () => undefined),
      fetchNextPage: jest.fn(async () => undefined),
      hasNextPage: mockList.hasNextPage,
      isFetchingNextPage: mockList.isFetchingNextPage,
    };
  },
  useRemoveSmsSuppression: () => ({
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: mockRemove,
  }),
  useAddSmsSuppression: () => ({
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: mockAdd,
  }),
}));
jest.mock("@/hooks/useSmsInbox", () => ({
  useSmsInboxAccess: () => mockAccess,
}));
jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
}));
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => mockConfirm,
}));
jest.mock("@/components/SwipeableRow", () => {
  const ReactRuntime = require("react");
  const { View } = require("react-native");
  return {
    SwipeableRow: ({
      children,
      right = [],
      accessibilityLabel,
    }: {
      children: React.ReactNode;
      right?: Array<{ label: string; onPress: () => void }>;
      accessibilityLabel?: string;
    }) =>
      ReactRuntime.createElement(
        View,
        {
          accessibilityLabel,
          accessibilityActions: right.map((action) => ({
            name: action.label,
            label: action.label,
          })),
          onAccessibilityAction: (event: {
            nativeEvent: { actionName: string };
          }) =>
            right
              .find((action) => action.label === event.nativeEvent.actionName)
              ?.onPress(),
        },
        children,
      ),
  };
});

// The policy panel above the list has its own contract in
// sms-policies.native.test.tsx; stub it so these assertions stay about the
// opt-out list and its count.
jest.mock("@/components/sms/SmsPolicyPanel", () => ({
  SmsPolicyPanel: () => null,
}));

// eslint-disable-next-line import/first
import SmsSuppressions from "../app/(tabs)/sms/suppressions";

function renderScreen() {
  return render(React.createElement(SmsSuppressions), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
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

function row(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    phone: "+12025550101",
    reason: "stop_keyword",
    source: "twilio",
    createdAt: "2026-08-01T10:00:00.000Z",
    reversible: false,
    lockedReason: "carrier_or_system_authority",
    ...over,
  };
}

function page(rows: unknown[], total = rows.length) {
  return {
    pages: [
      {
        items: rows,
        total,
        snapshotAt: "2026-08-21T11:00:00Z",
      },
    ],
    pageParams: [undefined],
  };
}

const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  mockList.data = undefined;
  mockList.isError = false;
  mockList.isLoading = true;
  mockList.isFetching = false;
  mockList.error = null;
  mockList.hasNextPage = false;
  mockList.isFetchingNextPage = false;
  mockRemove.mockClear();
  mockAdd.mockClear();
  mockConfirm.mockClear();
  mockUseSmsSuppressions.mockClear();
  mockAccess.identity = {
    fingerprint: "sms-admin-identity",
    tenantId: "tenant-1",
  };
  mockAccess.roleAllowed = true;
  mockAccess.canRequest = true;
  mockAccess.online = true;
  mockAccess.sessionReady = true;
  mockAccess.denialReason = null;
  gateHarness.__resetOnlineGateForTests();
});

describe("SMS opt-outs count claim", () => {
  it("renders an exact-admin no-request boundary before any PII query", async () => {
    mockAccess.identity = null;
    mockAccess.roleAllowed = false;
    mockAccess.canRequest = false;
    mockAccess.denialReason =
      "Only owners and admins may read SMS suppressions.";
    await renderScreen();

    expect(screen.getByText("SMS suppressions are restricted")).toBeTruthy();
    expect(
      screen.queryByLabelText("Search SMS suppressions by number"),
    ).toBeNull();
    expect(mockUseSmsSuppressions.mock.calls[0]?.[0]).toMatchObject({
      roleAllowed: false,
      canRequest: false,
    });
  });

  it("does not announce '0 numbers' while the list is still loading", async () => {
    mockList.isLoading = true;
    await renderScreen();

    // The screen is up…
    expect(screen.getByText("SMS suppressions")).toBeTruthy();
    // …and says nothing about how many opt-outs exist, because it has not read
    // them yet. "0 numbers" here is a claim, not a placeholder.
    expect(screen.queryByText("0 numbers")).toBeNull();
  });

  it("does not announce '0 numbers' when the read FAILED", async () => {
    // The costly one. A 500 must never be reported as a clean opt-out list on
    // the screen whose answer decides whether someone gets texted again.
    mockList.isLoading = false;
    mockList.isError = true;
    mockList.error = new Error("upstream unavailable");
    await renderScreen();

    expect(screen.queryByText("0 numbers")).toBeNull();
    // And the failure is stated where the list would be — never "No SMS
    // opt-outs", which is QueryStates' error-before-empty rung.
    expect(screen.queryByText("No SMS suppressions")).toBeNull();
  });

  it("warns that cached rows are stale when a refresh/read fails", async () => {
    mockList.isLoading = false;
    mockList.isError = true;
    mockList.error = new Error("refresh failed");
    mockList.data = page([row()]);
    await renderScreen();

    expect(screen.getByText(/current suppression read failed/iu)).toBeTruthy();
    expect(
      screen.getByText(/earlier response and may be stale/iu),
    ).toBeTruthy();
    expect(screen.getByLabelText("Retry SMS suppression read")).toBeTruthy();
    expect(screen.queryByLabelText(/manual SMS hold/u)).toBeNull();
    await fireEvent.changeText(
      screen.getByLabelText("Look up SMS suppression by exact number"),
      "+12025550101",
    );
    expect(
      screen.queryByLabelText("Add manual hold for +12025550101"),
    ).toBeNull();
  });

  it("qualifies a successful count by its response cutoff", async () => {
    mockList.isLoading = false;
    mockList.data = page([
      row(),
      row({
        id: "s2",
        phone: "+12025550102",
        createdAt: "2026-08-01T09:00:00.000Z",
      }),
    ]);
    await renderScreen();

    expect(screen.queryByText("2 numbers")).toBeNull();
    expect(
      screen.getByText(
        /2 matching suppressions reported for this response cutoff/u,
      ),
    ).toBeTruthy();
  });

  it("qualifies a zero response without claiming the workspace is currently empty", async () => {
    mockList.isLoading = false;
    mockList.data = page([]);
    await renderScreen();

    expect(screen.queryByText("0 numbers")).toBeNull();
    expect(
      screen.getByText(
        /0 matching suppressions reported for this response cutoff/u,
      ),
    ).toBeTruthy();
    expect(screen.getByText("No SMS suppressions")).toBeTruthy();
  });

  it("labels a cursor page partial instead of claiming the loaded rows are the tenant total", async () => {
    mockList.isLoading = false;
    mockList.hasNextPage = true;
    mockList.data = {
      pages: [
        {
          items: [row()],
          total: 2,
          nextCursor: "opaque",
          snapshotAt: "2026-08-21T11:00:00Z",
        },
      ],
      pageParams: [undefined],
    };
    await renderScreen();

    expect(
      screen.getByText("1 shown · 2 reported at response cutoff"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /1 of 2 rows loaded for this response cutoff.*more are available/u,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Load more suppressions")).toBeTruthy();
  });

  it.each([
    ["STOP", { reason: "stop_keyword", source: "twilio" }],
    ["carrier", { reason: "carrier_block", source: "telnyx" }],
    ["complaint", { reason: "complaint", source: "bandwidth" }],
    ["system", { reason: "quiet_hours", source: "api" }],
  ])(
    "shows %s authority as locked and exposes no removal action",
    async (_label, over) => {
      gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
      mockList.isLoading = false;
      mockList.data = page([row(over)]);
      await renderScreen();

      const card = screen.getByLabelText(
        /Locked · carrier_or_system_authority/u,
      );
      expect(card.props.accessibilityActions).toBeUndefined();
      expect(screen.queryByLabelText("Remove hold")).toBeNull();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockRemove).not.toHaveBeenCalled();
    },
  );

  it("does not offer add for an existing locked exact-phone row", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockList.isLoading = false;
    mockList.data = page([row()]);
    await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Look up SMS suppression by exact number"),
      "+12025550101",
    );

    expect(
      screen.queryByLabelText("Add manual hold for +12025550101"),
    ).toBeNull();
    expect(
      screen.getByLabelText(/Locked · carrier_or_system_authority/u),
    ).toBeTruthy();
  });

  it("offers removal only for a reversible manual row and never offers add over it", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    const manual = row({
      reason: "manual",
      source: "manual",
      reversible: true,
      lockedReason: undefined,
    });
    mockList.isLoading = false;
    mockList.data = page([manual]);
    await renderScreen();

    const actionRow = screen.getByLabelText(/manual SMS hold/u);
    expect(actionRow.props.accessibilityActions).toEqual([
      expect.objectContaining({ name: "Remove hold" }),
    ]);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(
      screen.queryByLabelText("Add manual hold for +12025550101"),
    ).toBeNull();
  });

  it("awaits destructive confirmation and removes the exact manual row before unlocking", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    const manual = row({
      reason: "manual",
      source: "manual",
      reversible: true,
      lockedReason: undefined,
    });
    mockList.isLoading = false;
    mockList.data = page([manual]);
    mockRemove.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          queueMicrotask(resolve);
        }),
    );
    await renderScreen();

    await fireEvent(
      screen.getByLabelText(/manual SMS hold/u),
      "accessibilityAction",
      { nativeEvent: { actionName: "Remove hold" } },
    );

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Remove this manual workspace hold?",
        confirmLabel: "Remove manual hold",
        confirmPhrase: "+12025550101",
        destructive: true,
        message: expect.stringMatching(
          /does not restore consent or make texting lawful/u,
        ),
        consequence: expect.stringMatching(
          /STOP and other system-authoritative suppressions cannot be cleared here/u,
        ),
      }),
    );
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith(manual);
    expect(
      screen.getByLabelText(/manual SMS hold/u).props.accessibilityActions,
    ).toEqual([expect.objectContaining({ name: "Remove hold" })]);
  });

  it("offers one reauthorized manual add only for a verified exact-empty phone", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockList.isLoading = false;
    mockList.data = page([]);
    await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Look up SMS suppression by exact number"),
      "+12025550101",
    );
    const button = await screen.findByLabelText(
      "Add manual hold for +12025550101",
    );
    await fireEvent.press(button);
    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith("+12025550101"));
    const options = mockConfirm.mock.calls.at(-1)?.[0] as
      | { message?: string }
      | undefined;
    expect(options?.message).toMatch(/does not record a carrier STOP/u);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});
