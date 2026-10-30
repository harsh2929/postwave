import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import type { HelpdeskNoteIntentInspection } from "@/lib/helpdeskNoteIntentStore";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const VERSION = "2026-08-24T10:00:00.123456789Z";

function query(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isError: false,
    isFetchNextPageError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => undefined),
    refreshFirstPage: jest.fn(async () => undefined),
    refreshLatest: jest.fn(async () => undefined),
    ...over,
  };
}

function conversation() {
  return {
    id: CONVERSATION_ID,
    tenantId: TENANT,
    version: VERSION,
    channelType: "web_chat",
    sourceType: "web_chat",
    requesterName: "Ada Lovelace",
    requesterEmail: "ada@example.com",
    requesterPhone: null,
    subject: "Where is my order?",
    status: "open",
    priority: "normal",
    assignmentState: "unassigned",
    assignedToUserId: null,
    tags: [],
    lastMessageAt: "2026-08-24T09:00:00Z",
    updatedAt: VERSION,
  };
}

function conversationPage() {
  return {
    items: [conversation()],
    page: {
      hasMore: false,
      nextCursor: null,
      asOf: "2026-08-24T10:01:00Z",
      consistency: "mutable_window",
      mayReorder: true,
    },
  };
}

function messagePage() {
  return {
    items: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        tenantId: TENANT,
        conversationId: CONVERSATION_ID,
        direction: "inbound",
        recordKind: "inbound_record",
        deliveryStatus: "received",
        senderType: "customer",
        sender: null,
        body: "Where is my order?",
        bodyOmittedReason: null,
        attachmentCount: 0,
        projectionTruncated: false,
        at: "2026-08-24T09:00:00Z",
      },
    ],
    page: {
      hasMore: false,
      nextCursor: null,
      asOf: "2026-08-24T10:01:00Z",
      consistency: "created_at_window",
      mayReorder: true,
    },
    order: "desc",
  };
}

const mockState: Record<string, Record<string, unknown>> = {
  access: {},
  catalog: {},
  conversations: {},
  conversation: {},
  thread: {},
  note: {},
  status: {},
  assignment: {},
};

const mockInspectIntent = jest.fn(
  async (_input: unknown): Promise<HelpdeskNoteIntentInspection> => ({
    status: "none",
  }),
);
const mockPrepareIntent = jest.fn(async (_input: unknown) => ({
  idempotencyKey: "mobile-helpdesk-note-test-key",
}));
const mockCompleteIntent = jest.fn(
  async (_scope: unknown, _idempotencyKey: unknown) => undefined,
);
const mockOutcomeAmbiguous = jest.fn((_error: unknown) => true);
const mockVersionedOutcomeAmbiguous = jest.fn((_error: unknown) => false);
const mockConfirm = jest.fn(async (_options: unknown) => true);
const mockToast = jest.fn((_options: unknown) => undefined);

jest.mock("@/api/serviceSuite", () => ({
  helpdeskInternalNoteOutcomeIsAmbiguous: (...args: unknown[]) =>
    mockOutcomeAmbiguous(...(args as [unknown])),
  helpdeskVersionedMutationOutcomeIsAmbiguous: (...args: unknown[]) =>
    mockVersionedOutcomeAmbiguous(...(args as [unknown])),
}));
jest.mock("@/hooks/useHelpdesk", () => ({
  useHelpdeskAccess: () => mockState.access,
  useHelpdeskCatalog: () => mockState.catalog,
  useHelpdeskConversations: () => mockState.conversations,
  useHelpdeskConversation: () => mockState.conversation,
  useHelpdeskThread: () => mockState.thread,
  useHelpdeskInternalNote: () => mockState.note,
  useHelpdeskStatusChange: () => mockState.status,
  useHelpdeskAssignment: () => mockState.assignment,
}));
jest.mock("@/lib/helpdeskNoteIntentStore", () => ({
  HELPDESK_NOTE_INTENT_GLOBAL_CAPACITY: 16,
  HELPDESK_NOTE_INTENT_PRINCIPAL_CAPACITY: 4,
  inspectHelpdeskNoteIntent: (...args: unknown[]) =>
    mockInspectIntent(...(args as [unknown])),
  prepareHelpdeskNoteIntent: (...args: unknown[]) =>
    mockPrepareIntent(...(args as [unknown])),
  completeHelpdeskNoteIntent: (...args: unknown[]) =>
    mockCompleteIntent(...(args as [unknown, unknown])),
}));
jest.mock("@/hooks/useActivityCursor", () => ({
  useRecordLastViewed: jest.fn(),
}));
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => mockConfirm,
}));
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));

// These imports intentionally follow the Jest mock declarations so the screen
// modules can never capture real transport hooks in this zero-request suite.
// eslint-disable-next-line import/first
import HelpdeskThread from "../app/(tabs)/helpdesk/[id]";
// eslint-disable-next-line import/first
import HelpdeskQueue from "../app/(tabs)/helpdesk/index";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const expoRouter = require("expo-router") as {
  __setSearchParamsForTests: (value: Record<string, unknown> | null) => void;
};

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

beforeEach(() => {
  mockInspectIntent.mockClear();
  mockPrepareIntent.mockClear();
  mockCompleteIntent.mockClear();
  mockOutcomeAmbiguous.mockReset();
  mockOutcomeAmbiguous.mockReturnValue(true);
  mockVersionedOutcomeAmbiguous.mockReset();
  mockVersionedOutcomeAmbiguous.mockReturnValue(false);
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  mockToast.mockClear();
  mockState.access = {
    identity: {
      baseUrl: "https://api.postwave.test",
      tenantId: TENANT,
      userId: USER,
      effectiveRole: "admin",
      mode: "session",
      contextEpoch: "epoch-1",
      fingerprint: "admin-scope",
      noteRecoveryPrincipal: "stable-session-recovery-principal",
    },
    roleAllowed: true,
    sessionReady: true,
    online: true,
    canRequest: true,
    denialReason: null,
  };
  mockState.catalog = query({
    data: { statuses: ["open", "resolved", "spam"] },
  });
  mockState.conversations = query({
    data: { pages: [conversationPage()], pageParams: [undefined] },
  });
  mockState.conversation = query({
    data: { conversation: conversation(), etag: `"${VERSION}"` },
  });
  mockState.thread = query({
    data: { pages: [messagePage()], pageParams: [undefined] },
  });
  mockState.note = {
    isPending: false,
    mutateAsync: jest.fn(async () => ({ note: {}, replayed: false })),
  };
  mockState.status = {
    isPending: false,
    variables: undefined,
    mutateAsync: jest.fn(async () => undefined),
  };
  mockState.assignment = {
    isPending: false,
    mutateAsync: jest.fn(async () => undefined),
  };
});

afterEach(() => {
  expoRouter.__setSearchParamsForTests(null);
});

describe("Helpdesk queue boundary", () => {
  it("renders only loaded bounded records and explicit incompleteness copy", async () => {
    await render(<HelpdeskQueue />, { wrapper });
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText(/bounded rows recorded/iu)).toBeTruthy();
    expect(screen.getByText(/1 active conversation loaded/iu)).toBeTruthy();
  });

  it("shows the exact-admin gate without rendering tenant content", async () => {
    mockState.access = {
      ...mockState.access,
      identity: null,
      roleAllowed: false,
      sessionReady: false,
      canRequest: false,
      denialReason:
        "Helpdesk records are restricted to workspace owners and admins.",
    };
    await render(<HelpdeskQueue />, { wrapper });
    expect(screen.getByText(/Owner or admin session required/iu)).toBeTruthy();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
  });

  it("never turns a fetch failure into an empty queue claim", async () => {
    mockState.conversations = query({
      data: undefined,
      error: new Error("upstream unavailable"),
      isError: true,
      isSuccess: false,
    });
    await render(<HelpdeskQueue />, { wrapper });
    expect(screen.queryByText(/No recorded conversations/iu)).toBeNull();
  });

  it("keeps queue rows visible while naming and retrying an unverified catalog", async () => {
    const retryCatalog = jest.fn(async () => undefined);
    mockState.catalog = query({
      data: undefined,
      error: Object.assign(new Error("bad catalog"), { status: 500 }),
      isError: true,
      isSuccess: false,
      refetch: retryCatalog,
    });
    await render(<HelpdeskQueue />, { wrapper });
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(
      screen.getByText(/status catalog could not be verified/iu),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/Show Open/iu)).toBeNull();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(retryCatalog).toHaveBeenCalledTimes(1);
  });
});

describe("Helpdesk thread truth", () => {
  it("renders receipt evidence and an internal-note-only composer", async () => {
    await render(<HelpdeskThread />, { wrapper });
    await waitFor(() =>
      expect(mockInspectIntent).toHaveBeenCalledWith({
        recoveryPrincipal: "stable-session-recovery-principal",
        conversationId: CONVERSATION_ID,
      }),
    );
    expect(screen.getByText(/Inbound record · received/iu)).toBeTruthy();
    expect(screen.getByLabelText("Internal note")).toBeTruthy();
    expect(screen.getByText(/Outbound replies are unavailable/iu)).toBeTruthy();
    expect(screen.queryByText(/Reply sent/iu)).toBeNull();
  });

  it("makes the loaded-history polling pause explicit and restartable", async () => {
    const refreshLatest = jest.fn(async () => undefined);
    mockState.thread = query({
      data: {
        pages: [messagePage(), { ...messagePage(), items: [] }],
        pageParams: [undefined, "v1.older"],
      },
      refreshLatest,
    });
    await render(<HelpdeskThread />, { wrapper });
    expect(
      screen.getByText(/automatic latest-window refresh is paused/iu),
    ).toBeTruthy();
    fireEvent.press(
      screen.getByLabelText("Restart from the latest message window"),
    );
    expect(refreshLatest).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid deep link with explicit zero-request copy", async () => {
    expoRouter.__setSearchParamsForTests({ id: "../../other-tenant" });
    await render(<HelpdeskThread />, { wrapper });
    expect(screen.getByText(/invalid conversation identifier/iu)).toBeTruthy();
    expect(screen.getByText(/No request was sent/iu)).toBeTruthy();
    expect(screen.queryByText("Where is my order?")).toBeNull();
  });

  it("keeps message rows visible but holds status changes when the catalog is unverified", async () => {
    const retryCatalog = jest.fn(async () => undefined);
    mockState.catalog = query({
      data: undefined,
      error: new Error("malformed catalog"),
      isError: true,
      isSuccess: false,
      refetch: retryCatalog,
    });
    await render(<HelpdeskThread />, { wrapper });
    expect(screen.getByText(/Inbound record · received/iu)).toBeTruthy();
    expect(screen.getByText(/status changes are held/iu)).toBeTruthy();
    expect(screen.queryByLabelText(/Record Resolved/iu)).toBeNull();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(retryCatalog).toHaveBeenCalledTimes(1);
  });

  it("cancels a consequential status transition without issuing a mutation", async () => {
    mockConfirm.mockResolvedValueOnce(false);
    await render(<HelpdeskThread />, { wrapper });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Record Resolved"));
      await Promise.resolve();
    });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Change recorded status from Open to Resolved?",
        message: expect.stringContaining(
          `Conversation ${CONVERSATION_ID}. Recorded status: Open → Resolved.`,
        ),
        destructive: true,
      }),
    );
    expect(mockState.status!.mutateAsync).not.toHaveBeenCalled();
  });

  it("single-flights a consequential status confirmation and mutation", async () => {
    let settleConfirm: ((confirmed: boolean) => void) | undefined;
    mockConfirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleConfirm = resolve;
        }),
    );
    await render(<HelpdeskThread />, { wrapper });
    const action = screen.getByLabelText("Record Spam");
    await act(async () => {
      fireEvent.press(action);
      fireEvent.press(action);
    });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      settleConfirm?.(true);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockState.status!.mutateAsync).toHaveBeenCalledTimes(1),
    );
  });

  it("cancels and single-flights unassign with explicit assignment provenance", async () => {
    let settleConfirm: ((confirmed: boolean) => void) | undefined;
    mockConfirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleConfirm = resolve;
        }),
    );
    mockState.conversation = query({
      data: {
        conversation: {
          ...conversation(),
          assignmentState: "tenant_active_user",
          assignedToUserId: USER,
        },
        etag: `"${VERSION}"`,
      },
    });
    await render(<HelpdeskThread />, { wrapper });
    const action = screen.getByLabelText("Unassign");
    await act(async () => {
      fireEvent.press(action);
      fireEvent.press(action);
    });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          `Conversation ${CONVERSATION_ID}. Recorded assignment: your verified workspace identity → unassigned.`,
        ),
        destructive: true,
      }),
    );
    await act(async () => {
      settleConfirm?.(false);
      await Promise.resolve();
    });
    expect(mockState.assignment!.mutateAsync).not.toHaveBeenCalled();
  });

  it("reports a status timeout as unconfirmed while the stale revision refreshes", async () => {
    mockVersionedOutcomeAmbiguous.mockReturnValue(true);
    mockState.status = {
      isPending: false,
      variables: undefined,
      mutateAsync: jest.fn(async () => {
        throw Object.assign(new Error("timeout"), { status: 0 });
      }),
    };
    await render(<HelpdeskThread />, { wrapper });
    fireEvent.press(screen.getByLabelText("Record Resolved"));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        kind: "error",
        message: expect.stringMatching(
          /status-change outcome is unconfirmed/iu,
        ),
      }),
    );
  });

  it("reports an unassign success-decoder failure as unconfirmed", async () => {
    mockVersionedOutcomeAmbiguous.mockReturnValue(true);
    mockState.conversation = query({
      data: {
        conversation: {
          ...conversation(),
          assignmentState: "tenant_active_user",
          assignedToUserId: USER,
        },
        etag: `"${VERSION}"`,
      },
    });
    mockState.assignment = {
      isPending: false,
      mutateAsync: jest.fn(async () => {
        throw new Error("strict replacement response was malformed");
      }),
    };
    await render(<HelpdeskThread />, { wrapper });
    fireEvent.press(screen.getByLabelText("Unassign"));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        kind: "error",
        message: expect.stringMatching(/assignment outcome is unconfirmed/iu),
      }),
    );
  });

  it("shows the active account recovery hold without claiming the device is full", async () => {
    mockInspectIntent.mockResolvedValueOnce({
      status: "principal_capacity_reached",
      capacity: 4,
    });
    await render(<HelpdeskThread />, { wrapper });
    expect(
      await screen.findByText(/account's bounded recovery allocation is full/iu),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /account already holds 4 unresolved internal-note recovery keys/iu,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/device's bounded recovery ledger is full/iu)).toBeNull();
    expect(screen.queryByLabelText("Internal note")).toBeNull();
  });

  it("shows a distinct global device recovery hold", async () => {
    mockInspectIntent.mockResolvedValueOnce({
      status: "device_capacity_reached",
      capacity: 16,
    });
    await render(<HelpdeskThread />, { wrapper });
    expect(
      await screen.findByText(/device's bounded recovery ledger is full/iu),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /device already holds 16 unresolved internal-note recovery keys across signed-in accounts/iu,
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Internal note")).toBeNull();
  });

  it("does not render a retired principal's delayed recovery inspection", async () => {
    let resolveRetired!: (value: HelpdeskNoteIntentInspection) => void;
    mockInspectIntent
      .mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            resolveRetired = resolve;
          }),
      )
      .mockResolvedValueOnce({ status: "none" });
    const rendered = await render(<HelpdeskThread />, { wrapper });
    await waitFor(() => expect(mockInspectIntent).toHaveBeenCalledTimes(1));

    mockState.access = {
      ...mockState.access,
      identity: {
        ...(mockState.access?.identity as Record<string, unknown>),
        fingerprint: "replacement-scope",
        noteRecoveryPrincipal: "replacement-session-recovery-principal",
      },
    };
    await act(async () => rendered.rerender(<HelpdeskThread />));
    await waitFor(() => expect(mockInspectIntent).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveRetired({
        status: "current",
        record: {
          identityHash: "a".repeat(64),
          conversationHash: "b".repeat(64),
          bodyHash: "c".repeat(64),
          idempotencyKey: "retired-principal-key",
          createdAt: "2026-08-25T10:00:00.000Z",
        },
      });
      await Promise.resolve();
    });

    expect(
      screen.queryByText(/earlier internal-note request is unresolved/iu),
    ).toBeNull();
  });

  it.each([
    ["server failure", Object.assign(new Error("server"), { status: 500 })],
    ["malformed resource", new Error("conversation contract invalid")],
    ["cross-tenant resource", new Error("tenant boundary")],
  ])(
    "shows bounded messages with an explicit metadata hold after %s",
    async (_label, error) => {
      const retryConversation = jest.fn(async () => undefined);
      mockState.conversation = query({
        data: undefined,
        error,
        isError: true,
        isSuccess: false,
        refetch: retryConversation,
      });
      await render(<HelpdeskThread />, { wrapper });
      expect(screen.getByText(/Inbound record · received/iu)).toBeTruthy();
      expect(
        screen.getByText(/current revision could not be verified/iu),
      ).toBeTruthy();
      expect(
        screen.getByText(/must be verified before recording a note/iu),
      ).toBeTruthy();
      fireEvent.press(screen.getByLabelText("Retry"));
      expect(retryConversation).toHaveBeenCalledTimes(1);
    },
  );

  it("retires a durable key only after an authoritative pre-effect rejection", async () => {
    mockOutcomeAmbiguous.mockReturnValue(false);
    mockState.note = {
      isPending: false,
      mutateAsync: jest.fn(async () => {
        throw Object.assign(new Error("invalid"), {
          status: 400,
          code: "internal_note_invalid",
        });
      }),
    };
    await render(<HelpdeskThread />, { wrapper });
    await waitFor(() => expect(mockInspectIntent).toHaveBeenCalled());
    fireEvent.changeText(
      screen.getByLabelText("Internal note"),
      "Private note",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Internal note").props.value).toBe(
        "Private note",
      ),
    );
    fireEvent.press(screen.getByLabelText("Record internal note"));
    await waitFor(() => expect(mockCompleteIntent).toHaveBeenCalledTimes(1));
  });

  it("keeps and reuses the exact key after an ambiguous outcome", async () => {
    const mutateAsync = jest.fn(
      async (_input: { body: string; idempotencyKey: string }) => {
        throw Object.assign(new Error("network"), {
          status: 0,
          code: "network_error",
        });
      },
    );
    mockOutcomeAmbiguous.mockReturnValue(true);
    mockState.note = { isPending: false, mutateAsync };
    await render(<HelpdeskThread />, { wrapper });
    await waitFor(() => expect(mockInspectIntent).toHaveBeenCalled());
    fireEvent.changeText(
      screen.getByLabelText("Internal note"),
      "Private note",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Internal note").props.value).toBe(
        "Private note",
      ),
    );
    fireEvent.press(screen.getByLabelText("Record internal note"));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByLabelText("Record internal note"));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mockCompleteIntent).not.toHaveBeenCalled();
    expect(mutateAsync.mock.calls[0]?.[0]).toEqual(
      mutateAsync.mock.calls[1]?.[0],
    );
  });
});
