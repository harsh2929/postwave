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

/**
 * SMS stored-policy visibility (MAP#55), plus the exact-admin role gate.
 * These tests pin:
 *
 *   - a verified read states which stored window evaluates active without a
 *     live hold or delivery claim;
 *   - a failed read says it failed, never "no windows configured";
 *   - a viewer sees the policy and gets NO switch, because
 *     PATCH /api/v1/sms/quiet-hours/{id} is `ScopeAdmin` and the only possible
 *     outcome of that control for them is a 403;
 *   - the expanded panel hosts sender pause/resume (SmsSendersSection), and an
 *     unpaused sender never reads as live "Sending" while dispatch is held.
 *
 * Mock shapes mirror the hooks' real return types: `useSmsQuietHours` resolves
 * `SmsQuietHoursRule[]`, not an envelope, so a `{items:[…]}` shim here would
 * pass on the error path while hiding every loaded-state assertion.
 */
const mockQuiet: {
  data: unknown;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  isSuccess: boolean;
} = {
  data: [],
  isError: false,
  isFetching: false,
  isLoading: false,
  isSuccess: true,
};
const mockKeywords: {
  data: unknown;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  isSuccess: boolean;
} = {
  data: [],
  isError: false,
  isFetching: false,
  isLoading: false,
  isSuccess: true,
};
const mockSmsAccess: { current: Record<string, unknown> } = {
  current: {
    identity: { fingerprint: "identity-1", userId: "u1" },
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
  },
};
const mockSetQuiet = { mutateAsync: jest.fn(async () => undefined) };
const mockSetKeyword = { mutateAsync: jest.fn(async () => undefined) };
const mockToast = jest.fn();
const mockConfirm = jest.fn(async () => true);
// The sender pause section is hosted in the expanded panel (CQ-4); its read
// mirrors `useSmsSenders` (a `SmsSenderProfile[]` query) and its write
// `useSmsSenderPaused` (`{ id, paused }`).
const mockSenders: { current: Record<string, unknown> } = { current: {} };
const mockPaused = {
  mutateAsync:
    jest.fn<
      (input: {
        senderId: string;
        paused: boolean;
      }) => Promise<{ id: string; paused: boolean }>
    >(),
  isPending: false,
};

jest.mock("@/hooks/useSmsPolicies", () => ({
  useSmsQuietHours: () => mockQuiet,
  useSmsKeywordResponses: () => mockKeywords,
  useSetQuietHoursEnabled: () => mockSetQuiet,
  useSetKeywordResponseEnabled: () => mockSetKeyword,
}));
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => mockConfirm,
}));
jest.mock("@/hooks/useSmsInbox", () => ({
  useSmsInboxAccess: () => mockSmsAccess.current,
  useSmsSenders: () => mockSenders.current,
}));
jest.mock("@/hooks/useSmsInboxTriage", () => ({
  useSmsSenderPaused: () => mockPaused,
}));

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import { SmsPolicyPanel } from "@/components/sms/SmsPolicyPanel";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

/** 2026-07-15T23:30:00Z — inside a 21:00→09:00 UTC window. */
const NIGHT = Date.UTC(2026, 6, 15, 23, 30, 0);

function nightWindow(over: Record<string, unknown> = {}) {
  return {
    id: "qh_1",
    label: "US night",
    countryCode: "",
    startMinute: 21 * 60,
    endMinute: 9 * 60,
    days: [0, 1, 2, 3, 4, 5, 6],
    timezone: "UTC",
    enabled: true,
    createdAt: "2026-08-21T09:00:00Z",
    updatedAt: "2026-08-21T09:00:00Z",
    ...over,
  };
}

function smsSender(over: Record<string, unknown> = {}) {
  return {
    id: "snd_1",
    tenantId: "11111111-1111-4111-8111-111111111111",
    provider: "twilio",
    country: "US",
    senderType: "long_code",
    phoneNumber: "+1 415 555 0100",
    registrationStatus: "approved",
    paused: false,
    ...over,
  };
}

async function renderPanel(canWrite: boolean) {
  return await render(<SmsPolicyPanel canWrite={canWrite} />, {
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
  mockQuiet.data = [];
  mockQuiet.isError = false;
  mockQuiet.isFetching = false;
  mockQuiet.isLoading = false;
  mockQuiet.isSuccess = true;
  mockKeywords.data = [];
  mockKeywords.isError = false;
  mockKeywords.isFetching = false;
  mockKeywords.isLoading = false;
  mockKeywords.isSuccess = true;
  mockSmsAccess.current = {
    identity: { fingerprint: "identity-1", userId: "u1" },
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
  };
  mockSenders.current = {
    data: [smsSender()],
    isError: false,
    isFetching: false,
    isLoading: false,
    isSuccess: true,
  };
  mockPaused.mutateAsync.mockReset();
  mockPaused.mutateAsync.mockResolvedValue({ id: "snd_1", paused: true });
  mockSetQuiet.mutateAsync.mockClear();
  mockSetKeyword.mutateAsync.mockClear();
  mockToast.mockClear();
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  gateHarness.__resetOnlineGateForTests();
  jest.useRealTimers();
}

afterEach(() => {
  jest.useRealTimers();
});

describe("SMS sending policy panel", () => {
  it("states that a stored window evaluates active without needing a tap", async () => {
    reset();
    jest.useFakeTimers().setSystemTime(NIGHT);
    mockQuiet.data = [nightWindow()];
    await renderPanel(true);

    expect(
      screen.getByText(/US night is active at this device evaluation time/u),
    ).toBeTruthy();
    expect(screen.getByText(/SMS dispatch remains release-held/u)).toBeTruthy();
    // Collapsed by default: the verdict is visible, the rows are not.
    expect(screen.queryByLabelText("US night quiet-hours window")).toBeNull();
  });

  it("makes no live-delivery claim when every stored rule is idle", async () => {
    reset();
    jest.useFakeTimers().setSystemTime(Date.UTC(2026, 6, 15, 12, 0, 0));
    mockQuiet.data = [nightWindow()];
    await renderPanel(true);

    expect(
      screen.getByText(/No stored quiet-hours rule evaluates active/u),
    ).toBeTruthy();
    expect(screen.getByText(/no live-delivery claim/u)).toBeTruthy();
  });

  it("says the read FAILED rather than 'no windows configured'", async () => {
    reset();
    mockQuiet.isError = true;
    await renderPanel(true);

    expect(screen.getByText(/Quiet hours couldn't be loaded/)).toBeTruthy();
    expect(
      screen.queryByText(/No stored quiet-hours rule is configured/),
    ).toBeNull();
  });

  it("keeps stale quiet rows orientation-only after a refresh failure", async () => {
    reset();
    mockQuiet.data = [nightWindow()];
    mockQuiet.isError = true;
    mockQuiet.isSuccess = false;
    await renderPanel(true);
    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));

    expect(
      screen.getAllByText(/Quiet hours couldn't be loaded/u),
    ).not.toHaveLength(0);
    expect(screen.queryByLabelText("US night quiet-hours window")).toBeNull();
    expect(mockSetQuiet.mutateAsync).not.toHaveBeenCalled();
  });

  it("distinguishes 'none configured' from 'could not read'", async () => {
    reset();
    mockQuiet.data = [];
    await renderPanel(true);

    expect(
      screen.getByText(/No stored quiet-hours rule is configured/),
    ).toBeTruthy();
  });

  it("expands to the windows and toggles one for an admin", async () => {
    reset();
    jest.useFakeTimers().setSystemTime(NIGHT);
    mockQuiet.data = [nightWindow()];
    await renderPanel(true);

    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));
    const toggle = screen.getByLabelText("US night quiet-hours window");
    expect(toggle).toBeTruthy();
    await fireEvent(toggle, "valueChange", false);

    expect(mockSetQuiet.mutateAsync).toHaveBeenCalledWith({
      rule: expect.objectContaining({ id: "qh_1" }),
      enabled: false,
    });
  });

  it("confirms that disabling an enabled historical scope also retires unsupported metadata", async () => {
    reset();
    mockQuiet.data = [nightWindow({ countryCode: "US" })];
    await renderPanel(true);
    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));
    await fireEvent(
      screen.getByLabelText("US night quiet-hours window"),
      "valueChange",
      false,
    );

    expect(mockSetQuiet.mutateAsync).toHaveBeenCalledWith({
      rule: expect.objectContaining({ countryCode: "US", enabled: true }),
      enabled: false,
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /unsupported historical US scope was retired/u,
        ),
      }),
    );
  });

  it("blocks enabling an uncleared historical country row", async () => {
    reset();
    mockQuiet.data = [nightWindow({ countryCode: "CA", enabled: false })];
    await renderPanel(true);
    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));
    await fireEvent(
      screen.getByLabelText("US night quiet-hours window"),
      "valueChange",
      true,
    );

    expect(mockSetQuiet.mutateAsync).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "warning",
        message: expect.stringMatching(/cannot be enabled/u),
      }),
    );
  });

  it("serializes quiet and keyword safety writes across rows", async () => {
    reset();
    mockQuiet.data = [nightWindow()];
    mockKeywords.data = [
      {
        id: "out",
        keyword: "LEAVE",
        responseBody:
          "You are unsubscribed from SMS marketing messages from this sender.",
        action: "opt_out",
        enabled: true,
        optInCount: 0,
        autoReplyDispatchAvailable: false,
        autoReplyDispatchUnavailableReason:
          "sms_auto_reply_dispatch_release_held",
        createdAt: "2026-08-21T09:00:00Z",
        updatedAt: "2026-08-21T09:00:00Z",
      },
    ];
    await renderPanel(true);
    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));

    const quietToggle = screen.getByLabelText("US night quiet-hours window");
    const keywordToggle = screen.getByLabelText("LEAVE opt-out state rule");
    const onQuiet = quietToggle.props.onChange;
    const onKeyword = keywordToggle.props.onChange;
    expect(typeof onQuiet).toBe("function");
    expect(typeof onKeyword).toBe("function");
    await act(async () => {
      await Promise.all([
        onQuiet({ nativeEvent: { value: false } }),
        onKeyword({ nativeEvent: { value: false } }),
      ]);
    });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSetKeyword.mutateAsync).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockSetQuiet.mutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(mockSetKeyword.mutateAsync).not.toHaveBeenCalled();
  });

  it("shows a viewer the policy and no switch", async () => {
    reset();
    jest.useFakeTimers().setSystemTime(NIGHT);
    mockQuiet.data = [nightWindow()];
    await renderPanel(false);

    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));
    expect(screen.getByText("US night")).toBeTruthy();
    expect(screen.queryByLabelText("US night quiet-hours window")).toBeNull();
  });

  it("shows reply-only text as stored configuration with dispatch held", async () => {
    reset();
    mockKeywords.data = [
      {
        id: "k1",
        keyword: "INFO",
        responseBody: "Welcome to Acme texts.",
        action: "reply_only",
        enabled: true,
        optInCount: 42,
        autoReplyDispatchAvailable: false,
        autoReplyDispatchUnavailableReason:
          "sms_auto_reply_dispatch_release_held",
        createdAt: "2026-08-21T09:00:00Z",
        updatedAt: "2026-08-21T09:00:00Z",
      },
    ];
    await renderPanel(true);
    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));

    expect(screen.getByText("INFO")).toBeTruthy();
    expect(screen.getByText("Stored reply — dispatch held")).toBeTruthy();
    expect(
      screen.getByText(
        /Stored reply-only configuration has no outbound effect/,
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("INFO opt-out state rule")).toBeNull();
    expect(
      screen.getByText(
        /HELP confirmation and tenant auto-replies are release-held/,
      ),
    ).toBeTruthy();
  });

  it("allows only opt-out state toggles while reply-only dispatch is held", async () => {
    reset();
    const common = {
      responseBody: "Hostile\u202E Active",
      enabled: true,
      optInCount: 0,
      autoReplyDispatchAvailable: false,
      autoReplyDispatchUnavailableReason:
        "sms_auto_reply_dispatch_release_held",
      createdAt: "2026-08-21T09:00:00Z",
      updatedAt: "2026-08-21T09:00:00Z",
    };
    mockKeywords.data = [
      { ...common, id: "reply", keyword: "INFO", action: "reply_only" },
      { ...common, id: "out", keyword: "LEAVE", action: "opt_out" },
    ];
    await renderPanel(true);
    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));

    expect(screen.queryByLabelText("INFO opt-out state rule")).toBeNull();
    const optOut = screen.getByLabelText("LEAVE opt-out state rule");
    await fireEvent(optOut, "valueChange", false);
    expect(mockSetKeyword.mutateAsync).toHaveBeenCalledWith({
      row: expect.objectContaining({ id: "out", action: "opt_out" }),
      enabled: false,
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /LEAVE stored opt-out match rule is disabled\. Verified provider callback ingestion and automatic confirmation dispatch remain release-held/,
        ),
      }),
    );
    expect(
      screen.getByText(
        /Stored reply-only configuration has no outbound effect/,
      ),
    ).toBeTruthy();
  });

  it("offers no toggle offline, because the write is never queued", async () => {
    reset();
    jest.useFakeTimers().setSystemTime(NIGHT);
    gateHarness.__setOnlineGateForTests({ enabled: false });
    mockQuiet.data = [nightWindow()];
    await renderPanel(true);

    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));
    expect(screen.queryByLabelText("US night quiet-hours window")).toBeNull();
    expect(screen.queryByLabelText(/^Sending from/u)).toBeNull();
    // Quiet hours (headline + card), keyword rules and sender profiles each
    // say it, so this asserts the count rather than uniqueness.
    expect(screen.getAllByText(/can't be read offline/)).toHaveLength(4);
    expect(
      screen.getByText(/^Sender profiles can't be read offline/u),
    ).toBeTruthy();
  });
});

describe("sender pause hosted in the sending-policy panel", () => {
  it("reads senders only once expanded, and an admin pauses a number", async () => {
    reset();
    await renderPanel(true);

    // Collapsed: the header answers quiet hours; the sender read is not mounted.
    expect(screen.queryByText("Senders")).toBeNull();
    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));

    expect(screen.getByText("Senders")).toBeTruthy();
    // Dispatch is release-held server-side, so an unpaused row must not
    // claim live sending.
    expect(screen.getByText("Not paused")).toBeTruthy();
    expect(screen.queryByText("Sending")).toBeNull();
    expect(
      screen.getByLabelText(
        "+1 415 555 0100. Not paused. Registration approved.",
      ),
    ).toBeTruthy();

    await fireEvent(
      screen.getByLabelText("Sending from +1 415 555 0100"),
      "valueChange",
      false,
    );
    await waitFor(() =>
      expect(mockPaused.mutateAsync).toHaveBeenCalledWith({
        senderId: "snd_1",
        paused: true,
      }),
    );
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "success",
          message: expect.stringMatching(
            /\+1 415 555 0100 paused\. Nothing sends/u,
          ),
        }),
      ),
    );
  });

  it("shows a viewer the sender section's denial and no switch", async () => {
    reset();
    mockSmsAccess.current = {
      ...mockSmsAccess.current,
      roleAllowed: false,
      canRequest: false,
      denialReason: "SMS Inbox is restricted to workspace owners and admins.",
    };
    await renderPanel(false);
    await fireEvent.press(screen.getByLabelText(/SMS sending policy/));

    expect(screen.getByText("Senders")).toBeTruthy();
    // The denial is stated, never the sender list a 403 would hide.
    expect(screen.queryByText("+1 415 555 0100")).toBeNull();
    expect(screen.queryByLabelText(/^Sending from/u)).toBeNull();
    expect(mockPaused.mutateAsync).not.toHaveBeenCalled();
  });
});
