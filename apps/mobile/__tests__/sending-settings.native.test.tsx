import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * DELIVERABILITY#21: the deliverability cluster's 2,600 lines of screen code
 * were covered by ONE unit test of ONE parser. `sending-settings.tsx` is the
 * largest file in it (751 lines) and the only genuinely EDIT-shaped screen in
 * the cluster, and nothing pinned the two behaviours that make it safe:
 *
 *  1. THE DIRTY-FORM BASELINE RECONCILIATION (sending-settings.tsx:101-119).
 *     `initial` is derived from the query object, so a background refetch on
 *     flaky cellular produces a NEW object identity with identical values. The
 *     effect adopts a new baseline ONLY when there are no unsaved edits;
 *     without that guard the operator's half-typed quiet-hours window is wiped
 *     mid-edit by a reconnect. That is invisible in review and invisible in a
 *     screenshot, and it is the exact class of bug this file exists to catch.
 *
 *  2. THE SAVE GATE. "No changes" must be un-pressable, an invalid field must
 *     block the write rather than round-trip a 422, and the "Remove all
 *     throttles" escape hatch must appear only for a workspace that HAS
 *     throttles.
 *
 * Mock shapes match the hooks' real return types: `useSendingSettings` returns
 * a SnapshotBacked envelope (`{value, fromSnapshot, capturedAt}`), so a
 * `{data: row}` shim would pass on the error path while hiding every
 * loaded-state assertion (house rule 10).
 */
const mockSettings: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  refetch: jest.fn(async () => undefined),
};

const mockStatus: {
  data: unknown;
  isError: boolean;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isError: false,
  refetch: jest.fn(async () => undefined),
};

// Typed with its INPUT so the assertions below can read the payload the
// screen actually sent; a bare `jest.fn(async () => ({}))` infers a
// zero-arity tuple and `calls[0][0]` stops type-checking.
type MockMutationResult = {
  kind: string;
  settings?: Record<string, unknown>;
  message?: string;
  mutationDispatchedAt?: number;
};

const mockMutateAsync = jest.fn(
  async (input: Record<string, unknown>): Promise<MockMutationResult> => ({
    kind: "applied",
    settings: {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      ...input,
      updated_at: "2026-07-20T09:01:00Z",
    },
  }),
);
const mockReconcileAsync = jest.fn(
  async (_input: Record<string, unknown>): Promise<MockMutationResult> => ({
    kind: "pending",
    message: "The outcome is still being reconciled.",
  }),
);
// The mutation's own in-flight flag, so a test can hold the screen in its
// "Saving…" state without racing a real promise.
const mockUpdate = { isPending: false };

jest.mock("@/hooks/useSendingOps", () => ({
  useSendingSettings: () => mockSettings,
  useSendingStatus: () => mockStatus,
  useUpdateSendingSettings: () => ({
    mutateAsync: mockMutateAsync,
    reconcileAsync: mockReconcileAsync,
    isPending: mockUpdate.isPending,
  }),
  CLEARED_SENDING_SETTINGS: {
    max_sends_per_hour: null,
    quiet_hours_start: "",
    quiet_hours_end: "",
    quiet_hours_tz: "",
    quiet_hours_per_recipient: false,
  },
}));

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import SendingSettings from "../app/(tabs)/sending-settings";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

function backed(row: Record<string, unknown> | undefined) {
  return { value: row, fromSnapshot: false, capturedAt: null };
}

const THROTTLED = {
  max_sends_per_hour: 5000,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/New_York",
  quiet_hours_per_recipient: false,
  updated_at: "2026-07-20T09:00:00Z",
};

async function renderScreen() {
  return await render(React.createElement(SendingSettings), {
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

function reset() {
  mockSettings.data = undefined;
  mockSettings.isLoading = false;
  mockSettings.isError = false;
  mockSettings.error = null;
  mockStatus.data = undefined;
  mockStatus.isError = false;
  mockSettings.refetch = jest.fn(async () => undefined);
  mockStatus.refetch = jest.fn(async () => undefined);
  mockMutateAsync.mockClear();
  mockReconcileAsync.mockClear();
  mockUpdate.isPending = false;
  gateHarness.__resetOnlineGateForTests();
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Host = ReturnType<Screen["getByText"]>;

/**
 * The button that DISPLAYS `visible`, found by walking up from the words on
 * screen rather than by its accessibility label, so an assertion about that
 * label cannot pass merely because the query already matched it.
 */
function buttonShowing(screen: Screen, visible: string): Host {
  let node: Host | null = screen.getByText(visible);
  while (node && node.props.accessibilityRole !== "button") node = node.parent;
  if (!node) throw new Error(`no button displays "${visible}"`);
  return node;
}

describe("sending settings — the state ladder", () => {
  it("never asserts a missing workspace ceiling from a row it has not loaded", async () => {
    reset();
    gateHarness.__setOnlineGateForTests({
      enabled: false,
      isOnline: false,
      canReadOfflineSnapshots: false,
    });
    const screen = await renderScreen();
    // The pre-fix screen printed a definitive claim about a compliance
    // control while offline, because `data === undefined` with isLoading and
    // isError both false fell through the render guard.
    expect(screen.queryByText("No workspace ceiling")).toBeNull();
    expect(
      screen.getByText(
        /No saved copy of your sending settings is available offline/u,
      ),
    ).toBeTruthy();
  });

  it("qualifies a missing workspace ceiling once a real row arrives", async () => {
    reset();
    mockSettings.data = backed({ max_sends_per_hour: null });
    const screen = await renderScreen();
    expect(screen.getByText("No workspace ceiling")).toBeTruthy();
    expect(
      screen.getByText(/Provider, quota, and safety controls still apply/u),
    ).toBeTruthy();
  });

  it("renders the saved throttles as labelled badges", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    expect(screen.getByText("Cap 5,000/hr")).toBeTruthy();
    expect(screen.getByText("Quiet 22:00–07:00")).toBeTruthy();
  });
});

describe("sending settings — live counter truth", () => {
  it("shows configuration-only copy when the active shared counter is unavailable", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    mockStatus.data = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      maxSendsPerHour: 5000,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      quietHoursTz: "America/New_York",
      quietHoursPerRecipient: false,
      bucketCount: null,
      windowStart: null,
      windowResetsAt: null,
      inQuietHours: false,
      quietChangesAt: null,
      counterAuthoritative: false,
      counterSource: "unavailable",
      counterScope: "unavailable",
      capCoordinationState: "ready",
      capCoordinationReady: true,
      capCoordinationCap: 5000,
      capCoordinationMatchesSettings: true,
      capCoordinationFenceStartedAt: null,
    };

    const screen = await renderScreen();
    expect(screen.getByText("Hourly usage unavailable")).toBeTruthy();
    expect(
      screen.getByText(/does not certify the active shared send counter/u),
    ).toBeTruthy();
    expect(screen.queryByText(/0 sent this hour/u)).toBeNull();
    expect(screen.getByText("Cap 5,000/hr")).toBeTruthy();
  });
});

describe("sending settings — the save gate", () => {
  it("labels an untouched form 'No changes' and refuses the press", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    const save = screen.getByRole("button", { name: "No changes" });
    expect(save.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("enables the save the moment a field actually differs", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    expect(
      screen.getByRole("button", { name: "Save changes" }).props
        .accessibilityState?.disabled,
    ).toBe(false);
    expect(screen.getByText("Save changes")).toBeTruthy();
  });

  it("blocks the write on an invalid field instead of round-tripping a 422", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Quiet hours start"),
      "25:99",
    );
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(save);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("blocks a quiet window that ends when it starts, at the end field", async () => {
    // CQ-3: the server answers 22:00–22:00 with a 400 (equal_quiet_hours) and
    // both wire schemas refuse it; the form did not, so the PUT went out and
    // the operator got the server's raw sentence with no field marked.
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    expect(
      screen.queryByText("End time must differ from the start time."),
    ).toBeNull();
    await fireEvent.changeText(
      screen.getByLabelText("Quiet hours end"),
      "22:00",
    );
    expect(
      screen.getByText("End time must differ from the start time."),
    ).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(save);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("sends the trimmed form, with a blank cap as an explicit null", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(screen.getByLabelText("Max sends per hour"), "");
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    // `null` and not `0`: a blank cap means "no cap", and 0 would mean
    // "never send".
    expect(mockMutateAsync.mock.calls[0]?.[0]).toMatchObject({
      max_sends_per_hour: null,
      quiet_hours_start: "22:00",
      expected_updated_at: THROTTLED.updated_at,
    });
  });

  it("fails closed when the loaded row has no exact mutation revision", async () => {
    reset();
    mockSettings.data = backed({
      ...THROTTLED,
      updated_at: undefined,
    });
    const screen = await renderScreen();

    expect(
      screen.getByText(/exact settings revision is unavailable/u),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "No changes" }).props
        .accessibilityState?.disabled,
    ).toBe(true);
    expect(
      screen.queryByLabelText("Remove all throttles"),
    ).toBeNull();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("holds editing on an ambiguous result and reconciles without a second PUT", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    mockMutateAsync.mockResolvedValueOnce({
      kind: "pending",
      message:
        "The settings are persisted, but cap convergence is not yet verified.",
    });
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByLabelText("Refresh to reconcile sending settings");
    expect(screen.getByRole("alert")).toHaveTextContent(/draft is still here/u);
    for (const fieldName of [
      "Max sends per hour",
      "Quiet hours start",
      "Quiet hours end",
      "Quiet hours timezone",
    ]) {
      expect(screen.getByLabelText(fieldName).props.editable).toBe(false);
    }
    expect(
      screen.getByLabelText("Use each recipient's timezone for quiet hours")
        .props.accessibilityState?.disabled,
    ).toBe(true);
    // The held draft still differs from the server, so the button still
    // SAYS "Save changes" — it is the disabled state that refuses it.
    expect(
      screen.getByRole("button", { name: "Save changes" }).props
        .accessibilityState?.disabled,
    ).toBe(true);
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);

    mockReconcileAsync.mockResolvedValueOnce({
      kind: "applied",
      settings: {
        tenant_id: "11111111-1111-4111-8111-111111111111",
        ...THROTTLED,
        max_sends_per_hour: 4000,
        updated_at: "2026-07-20T09:01:00Z",
      },
    });
    await fireEvent.press(
      screen.getByLabelText("Refresh to reconcile sending settings"),
    );

    await waitFor(() => {
      expect(
        screen.queryByLabelText("Refresh to reconcile sending settings"),
      ).toBeNull();
    });
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockReconcileAsync).toHaveBeenCalledTimes(1);
  });

  it("offers 'Remove all throttles' only to a workspace that HAS throttles", async () => {
    reset();
    mockSettings.data = backed({ max_sends_per_hour: null });
    let screen = await renderScreen();
    expect(
      screen.queryByLabelText("Remove all throttles"),
    ).toBeNull();

    reset();
    mockSettings.data = backed(THROTTLED);
    screen = await renderScreen();
    expect(
      screen.getByLabelText("Remove all throttles"),
    ).toBeTruthy();
  });

  it("withdraws the destructive clear while the form is dirty", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    // An operator mid-edit pressing "Remove all throttles" would silently
    // discard the edit as well as the config, so the two are never offered
    // at the same time.
    expect(
      screen.queryByLabelText("Remove all throttles"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Discard changes" }),
    ).toBeTruthy();
  });
});

describe("sending settings — names match what the screen shows (WCAG 2.5.3)", () => {
  // Label in Name, Level A. A Voice Control user says the words they SEE —
  // "Tap Save changes" — and the pre-fix button answered only to a fixed
  // "Save sending settings" that none of its three visible states displays.
  // Each button is found by its on-screen words and then asked for its name.
  it("names the save button 'No changes' while nothing differs", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    expect(buttonShowing(screen, "No changes")).toHaveAccessibleName(
      "No changes",
    );
  });

  it("names it 'Save changes' once a field differs, keeping the context as a hint", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    const save = buttonShowing(screen, "Save changes");
    expect(save).toHaveAccessibleName("Save changes");
    // What the old name carried is still spoken, as the hint, after the name.
    expect(save.props.accessibilityHint).toMatch(/sending settings/iu);
  });

  it("names it 'Saving…' while the write is in flight", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    mockUpdate.isPending = true;
    await screen.rerender(React.createElement(SendingSettings));
    const save = buttonShowing(screen, "Saving…");
    expect(save).toHaveAccessibleName("Saving…");
    expect(save.props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
  });

  it("names the discard button 'Discard changes', as displayed", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    expect(buttonShowing(screen, "Discard changes")).toHaveAccessibleName(
      "Discard changes",
    );
  });

  it("names the clear button 'Remove all throttles', as displayed, keeping what it removes as the hint", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    const clear = buttonShowing(screen, "Remove all throttles");
    expect(clear).toHaveAccessibleName("Remove all throttles");
    // The old name's detail is still spoken, after the name, as the hint.
    expect(clear.props.accessibilityHint).toMatch(
      /send cap and quiet hours/iu,
    );
  });

  it("keeps the four field captions out of the screen's heading list", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    // The title is still a heading; without this the absences below would
    // also pass on a screen that had lost every heading.
    expect(
      screen.getByRole("header", { name: "Sending settings" }),
    ).toBeTruthy();
    for (const [caption, saved] of [
      ["Max sends per hour", "5000"],
      ["Quiet hours start", "22:00"],
      ["Quiet hours end", "07:00"],
      ["Quiet hours timezone", "America/New_York"],
    ] as const) {
      // Still shown above its field, and still the name of that field...
      expect(screen.getByText(caption)).toBeTruthy();
      expect(screen.getByLabelText(caption).props.value).toBe(saved);
      // ...but not a heading: VoiceOver's rotor lists sections, not inputs.
      expect(screen.queryByRole("header", { name: caption })).toBeNull();
    }
  });
});

describe("sending settings — the dirty-form baseline (the reconnect wipe)", () => {
  it("keeps an in-progress edit when a refetch returns the SAME values", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "4000",
    );

    // A background refetch on flaky cellular: identical values, brand-new
    // object identity. The sync effect must NOT adopt it.
    mockSettings.data = backed({ ...THROTTLED });
    await screen.rerender(React.createElement(SendingSettings));

    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "4000",
    );
    expect(screen.getByText("Save changes")).toBeTruthy();
  });

  it("never submits an R1 draft with the R2 token after a changed refetch", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );

    const remoteR2 = {
      ...THROTTLED,
      max_sends_per_hour: 6000,
      updated_at: "2026-07-20T09:02:00Z",
    };
    mockSettings.data = backed(remoteR2);
    await screen.rerender(React.createElement(SendingSettings));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /newer sending settings arrived/iu,
      );
    });
    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "4000",
    );
    expect(
      screen.getByRole("button", { name: "Save changes" }).props
        .accessibilityState?.disabled,
    ).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
    expect(mockMutateAsync).not.toHaveBeenCalled();

    await fireEvent.press(
      screen.getByLabelText("Discard draft and load current sending settings"),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
        "6000",
      );
    });
    expect(screen.queryByText(/newer sending settings arrived/iu)).toBeNull();

    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4500",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0]?.[0]).toMatchObject({
      max_sends_per_hour: 4500,
      expected_updated_at: remoteR2.updated_at,
    });
  });

  it("remounts drafts across API-key generations and API origins", async () => {
    reset();
    gateHarness.__setOnlineGateForTests({
      baseUrl: "https://api-a.postwave.test",
      credentialScope: "api-key:generation-1",
      effectiveRole: null,
      userId: null,
    });
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );

    gateHarness.__setOnlineGateForTests({
      baseUrl: "https://api-a.postwave.test",
      credentialScope: "api-key:generation-2",
      effectiveRole: null,
      userId: null,
    });
    mockSettings.data = backed({
      ...THROTTLED,
      max_sends_per_hour: 6000,
      updated_at: "2026-07-20T09:02:00Z",
    });
    await screen.rerender(React.createElement(SendingSettings));
    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "6000",
    );
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.queryByText(/newer sending settings arrived/iu)).toBeNull();

    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4500",
    );
    gateHarness.__setOnlineGateForTests({
      baseUrl: "https://api-b.postwave.test",
      credentialScope: "api-key:generation-2",
      effectiveRole: null,
      userId: null,
    });
    mockSettings.data = backed({
      ...THROTTLED,
      max_sends_per_hour: 7000,
      updated_at: "2026-07-20T09:03:00Z",
    });
    await screen.rerender(React.createElement(SendingSettings));
    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "7000",
    );
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("ignores an old in-flight save after the API authority rotates", async () => {
    reset();
    gateHarness.__setOnlineGateForTests({
      baseUrl: "https://api-a.postwave.test",
      credentialScope: "api-key:generation-1",
      effectiveRole: null,
      userId: null,
    });
    mockSettings.data = backed(THROTTLED);
    let resolveOldMutation!: (value: MockMutationResult) => void;
    mockMutateAsync.mockImplementationOnce(
      async () =>
        await new Promise<MockMutationResult>((resolve) => {
          resolveOldMutation = resolve;
        }),
    );
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));

    gateHarness.__setOnlineGateForTests({
      baseUrl: "https://api-b.postwave.test/gateway",
      credentialScope: "api-key:generation-2",
      effectiveRole: null,
      userId: null,
    });
    const authorityB = {
      ...THROTTLED,
      max_sends_per_hour: 7000,
      updated_at: "2026-07-20T09:03:00Z",
    };
    mockSettings.data = backed(authorityB);
    await screen.rerender(React.createElement(SendingSettings));
    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "7000",
    );

    resolveOldMutation({
      kind: "applied",
      settings: {
        ...THROTTLED,
        max_sends_per_hour: 4000,
        updated_at: "2026-07-20T09:01:00Z",
      },
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
        "7000",
      );
    });
    expect(screen.queryByText(/saved and verified/iu)).toBeNull();
  });

  it("drops an ambiguous hold when the exact API-key owner rotates", async () => {
    reset();
    gateHarness.__setOnlineGateForTests({
      baseUrl: "https://api.postwave.test/gateway",
      credentialScope: "api-key:generation-1",
      effectiveRole: null,
      userId: null,
    });
    mockSettings.data = backed(THROTTLED);
    mockMutateAsync.mockResolvedValueOnce({
      kind: "pending",
      message: "The old authority outcome is still unknown.",
      mutationDispatchedAt: 100,
    });
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByLabelText("Refresh to reconcile sending settings");

    gateHarness.__setOnlineGateForTests({
      baseUrl: "https://api.postwave.test/gateway/",
      credentialScope: "api-key:generation-2",
      effectiveRole: null,
      userId: null,
    });
    mockSettings.data = backed({
      ...THROTTLED,
      max_sends_per_hour: 8000,
      updated_at: "2026-07-20T09:04:00Z",
    });
    await screen.rerender(React.createElement(SendingSettings));

    expect(
      screen.queryByLabelText("Refresh to reconcile sending settings"),
    ).toBeNull();
    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "8000",
    );
    expect(screen.queryByText(/old authority outcome/iu)).toBeNull();
    expect(mockReconcileAsync).not.toHaveBeenCalled();
  });

  it("adopts a new server baseline when the form is CLEAN", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "5000",
    );

    mockSettings.data = backed({ ...THROTTLED, max_sends_per_hour: 1234 });
    await screen.rerender(React.createElement(SendingSettings));

    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "1234",
    );
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("adopts the server value when the operator has typed it back by hand", async () => {
    // Dirty against the LAST APPLIED baseline but equal to the INCOMING one:
    // there is nothing to lose, so adopting is correct and keeps the form
    // from reporting "Unsaved changes" over an identical row.
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "1234",
    );
    expect(screen.getByText("Save changes")).toBeTruthy();

    mockSettings.data = backed({ ...THROTTLED, max_sends_per_hour: 1234 });
    await screen.rerender(React.createElement(SendingSettings));

    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("announces the unsaved state in the header, not only on the button", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });
});

describe("sending settings — last-verified recovery", () => {
  it("retains committed R2 read-only when its verification refresh fails", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));

    mockSettings.isError = true;
    mockSettings.error = new Error("verification refresh failed");
    await screen.rerender(React.createElement(SendingSettings));

    expect(screen.getByLabelText("Max sends per hour").props.value).toBe(
      "4000",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /last verified settings remain visible/iu,
    );
    expect(screen.getByLabelText("Max sends per hour").props.editable).toBe(
      false,
    );
    // The save was applied, so the retained R2 IS the baseline: nothing
    // differs, and the button says so while the stale read disables it.
    expect(
      screen.getByRole("button", { name: "No changes" }).props
        .accessibilityState?.disabled,
    ).toBe(true);
    expect(
      screen.queryByLabelText("Remove all throttles"),
    ).toBeNull();

    await fireEvent.press(
      screen.getByLabelText("Retry sending settings verification"),
    );
    expect(mockSettings.refetch).toHaveBeenCalledTimes(2);
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("sending settings — the hold banners are spoken on iOS (A11Y-3)", () => {
  // jest-expo renders as iOS, where an alert-role banner joins the reading
  // order but is NOT announced (lib/a11y.ts). Each banner that pauses editing
  // must also call announce(). The mutation-error banner is left out on
  // purpose: every sentence it shows is toasted too, and Toast announces.
  const listen = () =>
    jest.spyOn(AccessibilityInfo, "announceForAccessibility");
  let spoken: ReturnType<typeof listen> | null = null;
  afterEach(() => {
    spoken?.mockRestore();
    spoken = null;
  });

  it("says newer settings arrived under a dirty draft", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    spoken = listen();
    mockSettings.data = backed({
      ...THROTTLED,
      max_sends_per_hour: 6000,
      updated_at: "2026-07-20T09:02:00Z",
    });
    await screen.rerender(React.createElement(SendingSettings));

    await waitFor(() => {
      expect(spoken).toHaveBeenCalledWith(
        expect.stringContaining("Newer sending settings arrived"),
      );
    });
  });

  it("says the verification refresh failed and editing is paused", async () => {
    reset();
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    await fireEvent.changeText(
      screen.getByLabelText("Max sends per hour"),
      "4000",
    );
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));

    spoken = listen();
    mockSettings.isError = true;
    mockSettings.error = new Error("verification refresh failed");
    await screen.rerender(React.createElement(SendingSettings));

    expect(spoken).toHaveBeenCalledWith(
      expect.stringContaining("The latest verification refresh failed"),
    );
  });

  it("says the exact revision is unavailable when the row carries none", async () => {
    reset();
    spoken = listen();
    mockSettings.data = backed({ ...THROTTLED, updated_at: undefined });
    await renderScreen();
    expect(spoken).toHaveBeenCalledWith(
      expect.stringContaining("The exact settings revision is unavailable"),
    );
  });
});

describe("sending settings — the IP pool card (desktop parity, read-only)", () => {
  it("names the pool the workspace sends from, off the already-fetched row", async () => {
    reset();
    mockSettings.data = backed({
      ...THROTTLED,
      ip_pool: { name: "pool-eu-1", dedicated: true },
    });
    const screen = await renderScreen();
    expect(screen.getByText("pool-eu-1")).toBeTruthy();
    expect(screen.getByText("Dedicated")).toBeTruthy();
  });

  it("an absent ip_pool reads as unknown, never as the shared pool", async () => {
    reset();
    // An older API build omits the field entirely; that is not evidence the
    // workspace sends from the shared pool, and the card must not claim it.
    mockSettings.data = backed(THROTTLED);
    const screen = await renderScreen();
    expect(
      screen.getByText("Unknown — not reported by this server"),
    ).toBeTruthy();
    expect(screen.queryByText("Shared")).toBeNull();
  });
});
