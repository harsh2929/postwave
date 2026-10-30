import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { SmsReplyResponse } from "@/lib/smsConversation";

const PHONE = "+15552345678";
const TENANT = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";

function query(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => undefined),
    refreshFirstPage: jest.fn(async () => undefined),
    ...over,
  };
}

function message(over: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    tenantId: TENANT,
    senderProfileId: "sender-1",
    phoneE164: PHONE,
    provider: "twilio",
    direction: "inbound",
    body: "Is my order shipping today?",
    segments: 1,
    status: "received",
    createdAt: "2026-08-17T09:12:00.000Z",
    ...over,
  };
}

function threadData(rows: unknown[] = [message()]) {
  return {
    pages: [
      {
        messages: rows,
        snapshotAt: "2026-08-17T09:15:00.000Z",
      },
    ],
    pageParams: [undefined],
  };
}

function context(over: Record<string, unknown> = {}) {
  return {
    phoneE164: PHONE,
    consentStatus: "opted_in",
    subscribedLists: 1,
    totalMessages: 1,
    suppressed: false,
    suppressionReversible: false,
    hasInboundThread: true,
    consentMixed: false,
    identityAmbiguous: false,
    consentEvidenceSufficient: true,
    replyDispatchAvailable: true,
    eligibleLists: [{ id: "list-1", name: "Updates", description: "Orders" }],
    ...over,
  };
}

const mockReply = jest.fn<() => Promise<SmsReplyResponse>>(async () => ({
  disposition: "persisted",
  message: {
    id: "out",
    tenantId: TENANT,
    senderProfileId: "sender-1",
    provider: "twilio",
    providerMessageId: "SM1",
    direction: "outbound",
    segments: 1,
    status: "accepted",
    costMicros: 7900,
    createdAt: "2026-08-17T09:15:00.000Z",
  },
  providerReceipt: {
    provider: "twilio",
    providerMessageId: "SM1",
    status: "accepted",
  },
}));
const mockMarkRead = jest.fn();
const mockTriage = jest.fn();
const mockScreenViewed = jest.fn();
let mockHeldIntent: Record<string, unknown> | null = null;
const mockIntentSignature = jest.fn(
  async (input: Record<string, string>) =>
    `hash:${JSON.stringify([input.senderProfileId, input.listId, input.body?.trim() ?? ""])}`,
);
const mockInspectIntent = jest.fn(async (scope: Record<string, string>) => {
  if (!mockHeldIntent) return { status: "none" };
  if (mockHeldIntent.identityFingerprint !== scope.identityFingerprint) {
    return { status: "other_identity" };
  }
  return mockHeldIntent.phoneE164 === scope.phoneE164
    ? { status: "current", record: mockHeldIntent }
    : { status: "other_thread", state: mockHeldIntent.state };
});
const mockPrepareIntent = jest.fn(async (input: Record<string, unknown>) => {
  const scope = input.scope as Record<string, string>;
  const signatureHash = await mockIntentSignature(
    input as Record<string, string>,
  );
  if (mockHeldIntent) {
    throw new Error("unresolved reply is held");
  }
  mockHeldIntent = {
    version: 1,
    identityFingerprint: scope.identityFingerprint,
    phoneE164: scope.phoneE164,
    identityHash: "a".repeat(64),
    threadHash: "b".repeat(64),
    signatureHash,
    idempotencyKey: "mobile-sms-reply-stable-test-key",
    state: "pending",
    createdAt: "2026-08-21T09:00:00Z",
  };
  return mockHeldIntent;
});
const mockMarkIntentReconciliation = jest.fn(async () => {
  if (!mockHeldIntent) throw new Error("missing held intent");
  mockHeldIntent = { ...mockHeldIntent, state: "reconciliation_required" };
  return mockHeldIntent;
});
const mockCompleteIntent = jest.fn(async () => {
  mockHeldIntent = null;
});
const mockState: {
  access: Record<string, unknown>;
  thread: Record<string, unknown>;
  context: Record<string, unknown>;
  senders: Record<string, unknown>;
} = {
  access: {},
  thread: {},
  context: {},
  senders: {},
};

jest.mock("@/hooks/useSmsInbox", () => ({
  useSmsInboxAccess: () => mockState.access,
  useSmsThread: () => mockState.thread,
  useSmsConversationContext: () => mockState.context,
  useSmsSenders: () => mockState.senders,
  useSmsReply: () => ({ isPending: false, mutateAsync: mockReply }),
  useMarkConversationRead: () => ({ mutate: mockMarkRead }),
}));
// The header's Triage control; its option set is covered by
// smsTriageOptions.test.ts and sms-triage.native.test.tsx.
jest.mock("@/hooks/useSmsInboxTriage", () => ({
  useSmsConversationTriage: () => ({ mutate: mockTriage, isPending: false }),
}));
jest.mock("@/hooks/useScreenViewed", () => ({
  useScreenViewed: (name: string) => mockScreenViewed(name),
}));
jest.mock("@/lib/smsReplyIntentStore", () => ({
  smsReplyIntentSignature: (...args: unknown[]) =>
    mockIntentSignature(...(args as [Record<string, string>])),
  inspectSmsReplyIntent: (...args: unknown[]) =>
    mockInspectIntent(...(args as [Record<string, string>])),
  prepareSmsReplyIntent: (...args: unknown[]) =>
    mockPrepareIntent(...(args as [Record<string, unknown>])),
  markSmsReplyIntentReconciliation: () => mockMarkIntentReconciliation(),
  completeSmsReplyIntent: () => mockCompleteIntent(),
}));
jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
}));
// Thread metadata (tags/note/activity) and the quick-reply library are
// covered by their own suites (sms-thread-meta, sms-quick-replies); here they
// stay inert so this suite keeps pinning the thread render contract alone.
jest.mock("@/hooks/useSmsConversationMeta", () => ({
  useSmsConversationTags: () => ({
    data: undefined,
    isError: false,
    isLoading: false,
  }),
  useSmsConversationActivity: () => ({
    data: undefined,
    isError: false,
    isLoading: false,
  }),
  useSmsTagMutations: () => ({ mutate: jest.fn(), isPending: false }),
  useSmsNotesSave: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/hooks/useSmsQuickReplies", () => ({
  useSmsQuickReplies: () => ({
    data: undefined,
    isError: false,
    isLoading: false,
  }),
  useSmsQuickReplyWrites: () => ({ mutate: jest.fn(), isPending: false }),
  useSmsQuickReplyUse: () => ({ mutate: jest.fn(), isPending: false }),
}));

import SmsThread from "../app/(tabs)/sms/[phone]";

const expoRouter = require("./mocks/expoRouter.cjs") as {
  __setSearchParamsForTests: (params: Record<string, string>) => void;
};

function openThread(phone = "%2B15552345678") {
  expoRouter.__setSearchParamsForTests(phone ? { phone } : {});
}

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

function reset() {
  mockHeldIntent = null;
  mockState.access = {
    identity: { fingerprint: "identity-1" },
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
  };
  mockState.thread = query({ data: threadData() });
  mockState.context = query({ data: context() });
  mockState.senders = query({
    data: [
      {
        id: "sender-1",
        tenantId: TENANT,
        provider: "twilio",
        country: "US",
        senderType: "10dlc",
        phoneNumber: "+15557654321",
        registrationStatus: "approved",
        paused: false,
      },
    ],
  });
  mockReply.mockReset();
  mockReply.mockResolvedValue({
    disposition: "persisted",
    message: {
      id: "out",
      tenantId: TENANT,
      senderProfileId: "sender-1",
      provider: "twilio",
      providerMessageId: "SM1",
      direction: "outbound",
      segments: 1,
      status: "accepted",
      costMicros: 7900,
      createdAt: "2026-08-17T09:15:00.000Z",
    },
    providerReceipt: {
      provider: "twilio",
      providerMessageId: "SM1",
      status: "accepted",
    },
  });
  mockMarkRead.mockReset();
  mockScreenViewed.mockReset();
  mockIntentSignature.mockClear();
  mockInspectIntent.mockClear();
  mockPrepareIntent.mockClear();
  mockMarkIntentReconciliation.mockClear();
  mockCompleteIntent.mockClear();
  openThread();
}

afterEach(() => {
  jest.restoreAllMocks();
  reset();
  expoRouter.__setSearchParamsForTests({});
});

async function renderThread() {
  return render(<SmsThread />, { wrapper });
}

async function typeReply(text: string) {
  fireEvent.changeText(screen.getByLabelText("Reply message"), text);
  await waitFor(() =>
    expect(screen.getByLabelText("Reply message").props.value).toBe(text),
  );
}

describe("SMS thread render contract", () => {
  it("renders a decoded private route but sends only a static telemetry name", async () => {
    reset();
    await renderThread();
    expect(screen.getByText(PHONE)).toBeTruthy();
    expect(screen.getByText(/Is my order shipping today/u)).toBeTruthy();
    expect(mockScreenViewed).toHaveBeenCalledWith("sms-thread");
    expect(mockScreenViewed).not.toHaveBeenCalledWith(
      expect.stringContaining(PHONE),
    );
  });

  it("keeps hostile text separate from direction/time/status semantics", async () => {
    reset();
    mockState.thread = query({
      data: threadData([
        message({
          id: "33333333-3333-4333-8333-333333333333",
          direction: "outbound",
          body: "It ships today",
          status: "undelivered",
          errorMessage: "Unreachable handset",
          createdAt: "2026-08-17T09:14:00.000Z",
        }),
        message({ body: "مرحبا\u202Eabc🚚" }),
      ]),
    });
    await renderThread();
    const body = screen.getByText(/مرحبا/u);
    expect(body.props.accessibilityLabel).toBeUndefined();
    expect(String(body.props.children)).not.toContain("Inbound message at");
    expect(String(body.props.children)).not.toContain("\u202E");
    expect(screen.getByText(/Failed —/u)).toBeTruthy();
  });

  it("renders a legacy oversize omission as unavailable, never empty content", async () => {
    reset();
    mockState.thread = query({
      data: threadData([
        message({
          body: "",
          bodyOmittedReason: "body_exceeds_inbox_limit",
        }),
      ]),
    });
    await renderThread();
    expect(
      screen.getByText(
        /Message text unavailable because it exceeds the safe inbox display limit/u,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("(no text)")).toBeNull();
  });

  it("labels unavailable legacy content without claiming it was oversized", async () => {
    reset();
    mockState.thread = query({
      data: threadData([
        message({
          body: "",
          bodyOmittedReason: "legacy_body_unavailable",
        }),
      ]),
    });
    await renderThread();
    expect(
      screen.getByText(/Legacy message content unavailable/u),
    ).toBeTruthy();
    expect(
      screen.queryByText(/exceeds the safe inbox display limit/u),
    ).toBeNull();
  });

  it("never turns a failed load into an empty customer conversation", async () => {
    reset();
    mockState.thread = query({
      data: undefined,
      isError: true,
      isSuccess: false,
      error: new Error("upstream unavailable"),
    });
    await renderThread();
    expect(
      screen.queryByText(/No messages returned for this response cutoff/u),
    ).toBeNull();
    expect(screen.getByText(/Something went wrong loading this/u)).toBeTruthy();
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it("marks only displayed inbound UUIDs after the first page succeeds", async () => {
    reset();
    mockState.thread = query({
      data: threadData([
        message({
          id: "33333333-3333-4333-8333-333333333333",
          direction: "outbound",
          createdAt: "2026-08-17T09:13:00.000Z",
        }),
        message(),
      ]),
    });
    await renderThread();
    await waitFor(() =>
      expect(mockMarkRead).toHaveBeenCalledWith(
        { phoneE164: PHONE, messageIds: [MESSAGE_ID] },
        expect.objectContaining({ onError: expect.any(Function) }),
      ),
    );
  });

  it("offline, labels cached data stale and refuses a reply", async () => {
    reset();
    mockState.access = {
      ...mockState.access,
      canRequest: false,
      online: false,
    };
    await renderThread();
    expect(screen.getByText(/^Offline · showing/u)).toBeTruthy();
    expect(screen.getByLabelText("Reply message").props.editable).toBe(false);
    expect(
      screen.getByText(/Offline — replies need a connection/u),
    ).toBeTruthy();
  });

  it("offers triage from the thread and states it cannot see the lifecycle", async () => {
    // The lifecycle stamps live on the conversation LIST row; GET .../context
    // does not carry them. The sheet must say so rather than guess a toggle.
    reset();
    await renderThread();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Triage this conversation"));
    });
    expect(
      screen.getByText(/current snooze and archive state isn't loaded/i),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Archive"));
    });
    expect(mockTriage).toHaveBeenCalledWith(
      { action: "archive", phoneE164: PHONE },
      expect.anything(),
    );
  });

  it("offers no triage control when the session cannot request", async () => {
    reset();
    mockState.access = {
      identity: { fingerprint: "identity-1" },
      roleAllowed: true,
      canRequest: false,
      online: false,
      sessionReady: true,
      denialReason: null,
    };
    await renderThread();
    expect(screen.queryByLabelText("Triage this conversation")).toBeNull();
  });

  it("renders a no-request boundary for a viewer", async () => {
    reset();
    mockState.access = {
      identity: null,
      roleAllowed: false,
      canRequest: false,
      online: true,
      sessionReady: true,
      denialReason: "SMS Inbox is restricted to workspace owners and admins.",
    };
    await renderThread();
    expect(screen.getByText("SMS conversation is restricted")).toBeTruthy();
    expect(screen.queryByLabelText("Reply message")).toBeNull();
  });

  it("shows another identity only as a zero-detail global hold", async () => {
    reset();
    mockHeldIntent = {
      identityFingerprint: "private-old-tenant",
      phoneE164: "+15559876543",
      signatureHash: "private-draft-signature",
      idempotencyKey: "private-held-key",
      state: "pending",
      createdAt: "2024-01-01T00:00:00Z",
    };
    await renderThread();
    await waitFor(() =>
      expect(
        screen.getByText(/A different workspace identity has an unresolved/u),
      ).toBeTruthy(),
    );

    expect(screen.queryByText("private-old-tenant")).toBeNull();
    expect(screen.queryByText("+15559876543")).toBeNull();
    expect(screen.queryByText("private-draft-signature")).toBeNull();
    expect(screen.queryByText("private-held-key")).toBeNull();
    expect(screen.getByLabelText("Reply message").props.editable).toBe(false);
    fireEvent.press(screen.getByLabelText("Send reply"));
    expect(mockPrepareIntent).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });

  it("an invalid, non-NXX, or unsupported-country link cannot request or send", async () => {
    reset();
    openThread("");
    await renderThread();
    expect(screen.getByText("Invalid conversation link")).toBeTruthy();
    expect(screen.queryByLabelText("Reply message")).toBeNull();

    reset();
    openThread("%2B442071838750");
    await renderThread();
    expect(screen.getByText("Invalid conversation link")).toBeTruthy();
    expect(screen.queryByLabelText("Reply message")).toBeNull();

    reset();
    openThread("%2B15551234567");
    await renderThread();
    expect(screen.getByText("Invalid conversation link")).toBeTruthy();
    expect(screen.queryByLabelText("Reply message")).toBeNull();
  });

  it("locks the composer when suppression or consent cannot be proven", async () => {
    reset();
    mockState.context = query({
      data: context({ suppressed: true, suppressionReason: "stop_keyword" }),
    });
    await renderThread();
    expect(screen.getByText(/Suppressed/u)).toBeTruthy();
    expect(screen.getByLabelText("Reply message").props.editable).toBe(false);

    reset();
    mockState.context = query({
      isError: true,
      data: undefined,
      error: new Error("failed"),
    });
    await renderThread();
    expect(screen.getByText(/Consent status unavailable/u)).toBeTruthy();
  });

  it("requires an explicit sender and consent list when either is ambiguous", async () => {
    reset();
    mockState.senders = query({
      data: [
        ...((mockState.senders.data as unknown[]) ?? []),
        {
          id: "sender-2",
          tenantId: TENANT,
          provider: "telnyx",
          country: "US",
          senderType: "10dlc",
          phoneNumber: "+15559876543",
          registrationStatus: "approved",
          paused: false,
        },
      ],
    });
    mockState.context = query({
      data: context({
        eligibleLists: [
          { id: "list-1", name: "Updates", description: "Orders" },
          { id: "list-2", name: "Support", description: "Replies" },
        ],
      }),
    });
    // No inbound sender id means neither ambiguous choice may default.
    mockState.thread = query({
      data: threadData([message({ senderProfileId: undefined })]),
    });
    await renderThread();
    expect(screen.getByText(/Choose the sender/u)).toBeTruthy();
    expect(
      screen.getByLabelText("Send reply").props.accessibilityState.disabled,
    ).toBe(true);
  });

  it("sends sender + eligible list and reports the exact provider receipt", async () => {
    reset();
    await renderThread();
    await typeReply("It ships this afternoon.");
    await waitFor(() =>
      expect(
        screen.getByLabelText("Send reply").props.accessibilityState.disabled,
      ).toBe(false),
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Send reply"));
    });
    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "It ships this afternoon.",
        senderProfileId: "sender-1",
        listId: "list-1",
        idempotencyKey: expect.stringMatching(/^mobile-sms-reply-/u),
      }),
    );
    expect(screen.getByLabelText("Reply message").props.value).toBe("");
  });

  it("holds an unconfirmed reply without a second network attempt", async () => {
    reset();
    mockReply.mockRejectedValueOnce(new Error("network lost"));
    await renderThread();
    await typeReply("Please try the side door.");
    await waitFor(() =>
      expect(
        screen.getByLabelText("Send reply").props.accessibilityState.disabled,
      ).toBe(false),
    );
    await act(async () => fireEvent.press(screen.getByLabelText("Send reply")));
    await waitFor(() =>
      expect(screen.getByText(/Delivery outcome is unresolved/u)).toBeTruthy(),
    );
    expect(
      screen.getByLabelText("Send reply").props.accessibilityState.disabled,
    ).toBe(true);
    fireEvent.press(screen.getByLabelText("Send reply"));
    expect(mockReply).toHaveBeenCalledTimes(1);
    expect(mockHeldIntent).toMatchObject({ state: "pending" });
  });

  it("retires a definitive release-held key because provider dispatch never began", async () => {
    reset();
    mockReply.mockRejectedValueOnce(
      Object.assign(new Error("dispatch release-held"), {
        code: "sms_reply_dispatch_release_held",
        status: 503,
      }),
    );
    await renderThread();
    await typeReply("Keep this draft for later.");
    await act(async () => fireEvent.press(screen.getByLabelText("Send reply")));

    await waitFor(() => expect(mockCompleteIntent).toHaveBeenCalledTimes(1));
    expect(mockHeldIntent).toBeNull();
    expect(screen.getByLabelText("Reply message").props.value).toBe(
      "Keep this draft for later.",
    );
    expect(
      screen.getByLabelText("Send reply").props.accessibilityState.disabled,
    ).toBe(false);
  });

  it("keeps the durable key for idempotency completion failure", async () => {
    reset();
    mockReply.mockRejectedValueOnce(
      Object.assign(new Error("completion failed"), {
        code: "idempotency_complete_failed",
        status: 500,
      }),
    );
    await renderThread();
    await typeReply("Do not duplicate this reply.");
    await act(async () => fireEvent.press(screen.getByLabelText("Send reply")));

    await waitFor(() =>
      expect(screen.getByText(/Delivery outcome is unresolved/u)).toBeTruthy(),
    );
    expect(mockCompleteIntent).not.toHaveBeenCalled();
    expect(mockHeldIntent).toMatchObject({ state: "pending" });
    expect(mockReply).toHaveBeenCalledTimes(1);
  });

  it("retains and locks the draft after provider acceptance needs reconciliation", async () => {
    reset();
    mockReply.mockResolvedValueOnce({
      disposition: "reconciliation_required",
      code: "reply_reconciliation_required",
      intentMessageId: "intent-message-1",
      providerReceipt: {
        provider: "twilio",
        providerMessageId: "SM-reconcile",
        status: "accepted",
      },
    });
    await renderThread();
    await typeReply("Keep this exact draft.");
    await act(async () => fireEvent.press(screen.getByLabelText("Send reply")));
    await waitFor(() =>
      expect(
        screen.getByText(/dispatch is reconciling.*Do not retry/u),
      ).toBeTruthy(),
    );
    expect(screen.getByLabelText("Reply message").props.value).toBe(
      "Keep this exact draft.",
    );
    expect(
      screen.getByLabelText("Send reply").props.accessibilityState.disabled,
    ).toBe(true);
    fireEvent.press(screen.getByLabelText("Send reply"));
    expect(mockReply).toHaveBeenCalledTimes(1);
  });

  it("makes dispatch readiness a zero-mutation structural hold", async () => {
    reset();
    mockState.context = query({
      data: context({
        replyDispatchAvailable: false,
        replyDispatchUnavailableReason: "sms_reply_dispatch_release_held",
      }),
    });
    await renderThread();
    expect(screen.getByText(/release-held/u)).toBeTruthy();
    expect(screen.getByLabelText("Reply message").props.editable).toBe(false);
    fireEvent.press(screen.getByLabelText("Send reply"));
    expect(mockPrepareIntent).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });

  it("retains the durable key after unmount/reload without replaying it", async () => {
    reset();
    mockReply.mockRejectedValueOnce(new Error("response lost"));
    const firstView = await renderThread();
    await typeReply("Persist this unresolved reply.");
    await act(async () => fireEvent.press(screen.getByLabelText("Send reply")));
    const firstKey = (
      mockReply.mock.calls as unknown as Array<[{ idempotencyKey: string }]>
    )[0]?.[0].idempotencyKey;
    expect(mockHeldIntent).not.toBeNull();
    firstView.rerender(<SmsThread key="reloaded-screen" />);
    await waitFor(() =>
      expect(screen.getByText(/Delivery outcome is unresolved/u)).toBeTruthy(),
    );
    expect(mockReply).toHaveBeenCalledTimes(1);
    expect(mockHeldIntent).toMatchObject({
      idempotencyKey: firstKey,
      state: "pending",
    });
    expect(screen.queryByText(/Discard/u)).toBeNull();
  });

  it("does not clear a reconciliation hold when its reserved row appears", async () => {
    reset();
    mockReply.mockResolvedValueOnce({
      disposition: "reconciliation_required",
      code: "reply_reconciliation_required",
      intentMessageId: "intent-message-1",
      providerReceipt: { provider: "twilio", status: "unknown" },
    });
    const view = await renderThread();
    await typeReply("Do not infer this persisted.");
    await act(async () => fireEvent.press(screen.getByLabelText("Send reply")));
    mockState.thread = query({
      data: threadData([
        message({
          id: "44444444-4444-4444-8444-444444444444",
          direction: "outbound",
          status: "reserved",
        }),
      ]),
    });
    view.rerender(<SmsThread />);
    await waitFor(() =>
      expect(
        screen.getByText(/dispatch is reconciling.*Do not retry/u),
      ).toBeTruthy(),
    );
    fireEvent.press(screen.getByLabelText("Send reply"));
    expect(mockReply).toHaveBeenCalledTimes(1);
    expect(mockHeldIntent).toMatchObject({ state: "reconciliation_required" });
  });

  it("durably locks a 202 receipt even when the screen unmounts in flight", async () => {
    reset();
    let resolveReply: ((value: SmsReplyResponse) => void) | undefined;
    mockReply.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReply = resolve;
      }),
    );
    const view = await renderThread();
    await typeReply("Hold this uncertain dispatch.");
    await act(async () => fireEvent.press(screen.getByLabelText("Send reply")));
    await act(async () => view.unmount());

    await act(async () =>
      resolveReply?.({
        disposition: "reconciliation_required",
        code: "reply_reconciliation_required",
        intentMessageId: "intent-message-after-unmount",
        providerReceipt: { provider: "twilio", status: "unknown" },
      }),
    );

    await waitFor(() =>
      expect(mockMarkIntentReconciliation).toHaveBeenCalledTimes(1),
    );
    expect(mockHeldIntent).toMatchObject({ state: "reconciliation_required" });
  });
});
