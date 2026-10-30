// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  listConversations: vi.fn(),
  listMessages: vi.fn(),
  getContext: vi.fn(),
  markRead: vi.fn(),
  navigate: vi.fn(),
  reply: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => ({
    user: "11111111-1111-4111-8111-111111111111",
    tenant: "22222222-2222-4222-8222-222222222222",
    effectiveRole: mocks.canAdmin ? "admin" : "editor",
  }),
}));

vi.mock("../../lib/desktop-router", () => {
  const route = { section: "smsInbox" } as const;
  return {
    desktopRouteIdentityScope: () => "opaque-identity",
    navigateDesktopRoute: mocks.navigate,
    useDesktopRoute: () => route,
    useDesktopRouteSnapshot: () => ({
      route,
      revision: 1,
      source: "navigation",
    }),
  };
});

vi.mock("../../lib/context-epoch", () => ({
  onContextEpochObserved: () => () => undefined,
  readContextEpoch: () => "epoch-1",
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listSMSConversations: mocks.listConversations,
    searchSMSConversations: vi.fn(),
    listSMSConversationMessages: mocks.listMessages,
    getSMSConversationContext: mocks.getContext,
    markSMSConversationRead: mocks.markRead,
    replySMSConversation: mocks.reply,
    listSMSSenders: vi.fn(),
  },
  getApiKey: () => "",
  getApiUrl: () => "https://api.example.invalid",
}));

vi.mock("../../components/sms/broadcasts/BroadcastsPanel", () => ({
  BroadcastsPanel: () => <div>Broadcasts</div>,
}));
vi.mock("../../components/sms/ConversationTagsNotes", () => ({
  ConversationTagsNotes: () => null,
}));
vi.mock("../../components/sms/ActivityFeed", () => ({
  ActivityFeed: () => null,
}));
vi.mock("../../components/sms/QuickReplyPicker", () => ({
  QuickReplyPicker: () => null,
}));
vi.mock("../../components/sms/ReplyComposer", () => ({
  ReplyComposer: () => <div>Reply controls</div>,
}));
vi.mock("../../components/sms/ThreadHeader", () => ({
  ThreadHeader: ({ phone }: { phone: string }) => <h3>{phone}</h3>,
}));
vi.mock("../../components/sms/MessageBubble", () => ({
  MessageBubble: ({ message }: { message: { body: string } }) => (
    <p>{message.body}</p>
  ),
}));
vi.mock("../../lib/file-transfer", () => ({ saveFile: vi.fn() }));
vi.mock("../../lib/native-api-fetch", () => ({ nativeAwareFetch: vi.fn() }));

import { SMSInbox } from "../../pages/SMSInbox";
import { InboxFilters } from "../../components/sms/InboxFilters";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function setVisibility(value: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function listResponse(phone?: string) {
  return {
    data: {
      tenantId: "22222222-2222-4222-8222-222222222222",
      conversations: phone
        ? [
            {
              phoneE164: phone,
              lastMessagePreview: "Synthetic inbox preview",
              lastMessageAt: "2026-08-21T10:00:00Z",
              lastDirection: "inbound",
              messageCount: 2,
              unreadCount: 1,
              oldestUnreadAt: "2026-08-21T09:59:00Z",
              identityAmbiguous: false,
            },
          ]
        : [],
      nextCursor: undefined,
      snapshotAt: "2026-08-21T10:00:00Z",
      unreadTotal: phone ? 1 : 0,
      unknownTotal: phone ? 1 : 0,
      totalConversations: phone ? 1 : 0,
      activeTotal: phone ? 1 : 0,
      snoozedTotal: 0,
      archivedTotal: 0,
    },
  };
}

function renderInbox(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<SMSInbox />));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = true;
  setVisibility("visible");
  mocks.listConversations.mockResolvedValue(listResponse());
  mocks.listMessages.mockResolvedValue({
    data: {
      tenantId: "22222222-2222-4222-8222-222222222222",
      messages: [],
      snapshotAt: "2026-08-21T10:00:00Z",
    },
  });
  mocks.getContext.mockResolvedValue({ error: { message: "not needed" } });
  mocks.markRead.mockResolvedValue({ data: { ok: true, applied: 0 } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  setVisibility("visible");
});

describe("SMS Inbox confidential controller", () => {
  it("mounts an exact-role boundary before any protected request", async () => {
    mocks.canAdmin = false;
    renderInbox();
    await settle();

    expect(document.body.textContent).toContain(
      "Your current role cannot open SMS conversations",
    );
    expect(mocks.listConversations).not.toHaveBeenCalled();
    expect(mocks.listMessages).not.toHaveBeenCalled();
    expect(mocks.getContext).not.toHaveBeenCalled();
  });

  it("pauses hidden reads, refreshes once on visibility, and aborts on hide", async () => {
    setVisibility("hidden");
    let resolve!: (value: ReturnType<typeof listResponse>) => void;
    mocks.listConversations.mockReturnValue(
      new Promise<ReturnType<typeof listResponse>>((done) => {
        resolve = done;
      }),
    );
    renderInbox();
    await settle();
    expect(mocks.listConversations).not.toHaveBeenCalled();

    act(() => setVisibility("visible"));
    await settle();
    expect(mocks.listConversations).toHaveBeenCalledTimes(1);
    const signal = mocks.listConversations.mock.calls[0]?.[0]?.signal as
      | AbortSignal
      | undefined;
    expect(signal?.aborted).toBe(false);

    act(() => setVisibility("hidden"));
    expect(signal?.aborted).toBe(true);
    resolve(listResponse());
    await settle();
    expect(mocks.listConversations).toHaveBeenCalledTimes(1);
  });

  it("describes the page boundary without claiming a repeatable snapshot", async () => {
    mocks.listConversations.mockResolvedValue(listResponse("+12025550118"));
    renderInbox();
    await settle();

    expect(document.body.textContent).toContain("message-created cutoff");
    expect(document.body.textContent).toContain("late commits");
    expect(document.body.textContent).not.toMatch(/verified[^.]*snapshot/iu);
    expect(document.body.textContent).not.toMatch(/complete[^.]*snapshot/iu);

    act(() => {
      root?.render(
        <InboxFilters
          filter="all"
          sort="oldest_unread"
          totals={{ total: 1, unread: 1, unknown: 0 }}
          onFilterChange={vi.fn()}
          onSortChange={vi.fn()}
        />,
      );
    });
    expect(document.body.textContent).toContain(
      "earliest unread inbound record at the loaded message-created cutoff",
    );
    expect(document.body.textContent).toContain(
      "later receipts and late commits can change the order",
    );
  });

  it("marks read only after a decoded first page and only for loaded inbound ids", async () => {
    const phone = "+12025550118";
    mocks.listConversations.mockResolvedValue(listResponse(phone));
    let resolveMessages!: (value: unknown) => void;
    mocks.listMessages.mockReturnValue(
      new Promise((done) => {
        resolveMessages = done;
      }),
    );
    mocks.getContext.mockResolvedValue({
      data: {
        tenantId: "22222222-2222-4222-8222-222222222222",
        phoneE164: phone,
        consentStatus: "none",
        subscribedLists: 0,
        totalMessages: 2,
        consentMixed: false,
        identityAmbiguous: false,
        consentEvidenceSufficient: false,
        suppressed: false,
        suppressionReversible: false,
        hasInboundThread: true,
        eligibleLists: [],
        replyDispatchAvailable: false,
        replyDispatchUnavailableReason: "sms_reply_dispatch_release_held",
      },
    });
    mocks.markRead.mockResolvedValue({ data: { ok: true, applied: 1 } });
    renderInbox();
    await settle();

    const open = document.querySelector<HTMLButtonElement>(
      ".sms-inbox-row-open",
    );
    expect(open).not.toBeNull();
    act(() => open?.click());
    await settle();
    expect(mocks.markRead).not.toHaveBeenCalled();

    resolveMessages({
      data: {
        tenantId: "22222222-2222-4222-8222-222222222222",
        messages: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            tenant_id: "22222222-2222-4222-8222-222222222222",
            phone_e164: phone,
            provider: "twilio",
            direction: "inbound",
            body: "Synthetic inbound",
            segments: 1,
            status: "received",
            cost_micros: 0,
            created_at: "2026-08-21T09:59:00Z",
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            tenant_id: "22222222-2222-4222-8222-222222222222",
            phone_e164: phone,
            provider: "twilio",
            direction: "outbound",
            body: "Synthetic outbound",
            segments: 1,
            status: "sent",
            cost_micros: 1,
            created_at: "2026-08-21T09:58:00Z",
          },
        ],
        snapshotAt: "2026-08-21T10:00:00Z",
      },
    });
    await settle();

    expect(mocks.markRead).toHaveBeenCalledTimes(1);
    expect(mocks.markRead.mock.calls[0]?.[0]).toBe(phone);
    expect(mocks.markRead.mock.calls[0]?.[1]).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(mocks.markRead.mock.calls[0]?.[2]?.signal).toBeInstanceOf(
      AbortSignal,
    );
  });
});
