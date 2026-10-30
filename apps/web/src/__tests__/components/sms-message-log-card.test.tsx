// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

import type { MeResponse } from "@/lib/auth-api";
import { qk } from "@/lib/query-keys";
import type { SmsMessagesResponse } from "@/lib/sms-inbox-contract";

const mocks = vi.hoisted(() => ({
  contextEpoch: null as string | null,
  contextListener: null as ((epoch: string) => void) | null,
  conversations: vi.fn(),
  activity: vi.fn(),
  addTag: vi.fn(),
  archive: vi.fn(),
  assign: vi.fn(),
  bulk: vi.fn(),
  markRead: vi.fn(),
  messages: vi.fn(),
  removeTag: vi.fn(),
  snooze: vi.fn(),
  tags: vi.fn(),
  unarchive: vi.fn(),
  unsnooze: vi.fn(),
  whoami: vi.fn(),
  // Thread mounts: consent context (panel + composer + retry), approved
  // senders, saved replies, the reply/retry send, and the clipboard write.
  context: vi.fn(),
  senders: vi.fn(),
  quickReplies: vi.fn(),
  quickReplyUse: vi.fn(),
  reply: vi.fn(),
  copy: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  online: "online" as "online" | "connecting" | "offline",
}));

vi.mock("@/lib/use-online", () => ({ useOnline: () => mocks.online }));
vi.mock("@/lib/context-epoch", () => ({
  readContextEpoch: () => mocks.contextEpoch,
  onContextEpochObserved: (listener: (epoch: string) => void) => {
    mocks.contextListener = listener;
    return () => {
      if (mocks.contextListener === listener) mocks.contextListener = null;
    };
  },
}));
vi.mock("@/lib/sms-api", async (importOriginal) => ({
  // The conversation-controls panel mounts the notes editor, which validates
  // with the real (pure) notes rule. Notes writes are not exercised here —
  // __tests__/pages/sms-inbox-state-panel-mounts.test.tsx covers them — so
  // the write refuses rather than pretending to succeed.
  smsConversationNotesProblem: (
    await importOriginal<typeof import("@/lib/sms-api")>()
  ).smsConversationNotesProblem,
  setSmsConversationNotes: () =>
    Promise.reject(new Error("notes writes are not exercised by this suite")),
  addSmsConversationTag: (input: unknown) => mocks.addTag(input),
  archiveSmsConversation: (input: unknown) => mocks.archive(input),
  assignSmsConversation: (input: unknown) => mocks.assign(input),
  bulkMutateSmsConversations: (input: unknown) => mocks.bulk(input),
  getSmsConversationActivity: (input: unknown) => mocks.activity(input),
  listSmsConversations: (input: unknown) => mocks.conversations(input),
  listSmsConversationMessages: (...input: unknown[]) =>
    mocks.messages(...input),
  listSmsConversationTags: (input: unknown) => mocks.tags(input),
  markSmsConversationRead: (...input: unknown[]) => mocks.markRead(...input),
  removeSmsConversationTag: (input: unknown) => mocks.removeTag(input),
  snoozeSmsConversation: (input: unknown) => mocks.snooze(input),
  unarchiveSmsConversation: (input: unknown) => mocks.unarchive(input),
  unsnoozeSmsConversation: (input: unknown) => mocks.unsnooze(input),
  getSmsConversationContext: (input: unknown) => mocks.context(input),
  listSmsSenders: () => mocks.senders(),
  listSmsQuickReplies: (input: unknown) => mocks.quickReplies(input),
  recordSmsQuickReplyUse: (id: unknown) => mocks.quickReplyUse(id),
  replySmsConversation: (input: unknown) => mocks.reply(input),
}));
vi.mock("@/lib/clipboard", () => ({
  isClipboardAvailable: () => true,
  copyToClipboard: (text: string) => mocks.copy(text),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
// The reply composer is a next/dynamic boundary in the card; resolve it
// synchronously here so the thread renders the composer in the same tick.
vi.mock("next/dynamic", async () => {
  const { ReplyComposer } = await import("@/components/sms/ReplyComposer");
  return { default: () => ReplyComposer };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: () => mocks.whoami() };
});
vi.mock("@/components/relative-time", () => ({
  RelativeTime: ({ iso }: { iso: string }) => <time>{iso}</time>,
}));

import {
  SMS_INBOX_POLL_MS,
  SmsInboxTab,
  shouldPauseSmsInboxPoll,
  shouldPollSmsInbox,
  smsInboxPollTargets,
} from "@/app/(dashboard)/app/sms/sms-message-log-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const PHONE = "+15552345678";
const SNAPSHOT = "2026-08-21T10:00:00Z";
const LIST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SENDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const HOLD =
  "Live SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider request can be started.";
const roots: Root[] = [];

function contextPayload(available: boolean) {
  return {
    tenantId: TENANT,
    phoneE164: PHONE,
    subscriberEmail: "sub@example.test",
    consentStatus: "opted_in",
    consentMixed: false,
    identityAmbiguous: false,
    consentEvidenceSufficient: true,
    subscribedLists: 1,
    totalMessages: 1,
    suppressed: false,
    suppressionReversible: false,
    hasInboundThread: true,
    eligibleLists: [
      {
        id: LIST,
        name: "VIP texts",
        description: "",
        consentSource: "form",
        consentAt: "2026-08-01T00:00:00Z",
      },
    ],
    replyDispatchAvailable: available,
    ...(available
      ? {}
      : { replyDispatchUnavailableReason: "sms_reply_dispatch_release_held" }),
  };
}

const APPROVED_SENDERS = {
  items: [
    {
      id: SENDER,
      provider: "twilio",
      country: "US",
      sender_type: "10dlc",
      phone_number: "+14155550100",
      registration_status: "approved",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    },
  ],
};

function persistedOutcome() {
  return {
    disposition: "persisted",
    message: {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      tenant_id: TENANT,
      sender_profile_id: SENDER,
      provider: "twilio",
      provider_message_id: "SM-receipt-1",
      direction: "outbound",
      segments: 1,
      status: "queued",
      cost_micros: 0,
      created_at: "2026-08-21T10:02:00Z",
    },
    providerReceipt: {
      provider: "twilio",
      status: "queued",
      providerMessageId: "SM-receipt-1",
    },
  };
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function selectValue(element: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!
      .set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function serializedQueryKeys(client: QueryClient): string {
  return JSON.stringify(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey),
  );
}

function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
    ...over,
  };
}

function conversationPage() {
  return {
    tenantId: TENANT,
    query: { filter: "all", sort: "recent", status: "active" } as const,
    conversations: [
      {
        phoneE164: PHONE,
        identityAmbiguous: false,
        lastMessagePreview: "مرحبا\u202E spoof Delivered 🚚",
        lastMessageAt: "2026-08-21T09:00:00Z",
        lastDirection: "inbound" as const,
        messageCount: 1,
        unreadCount: 1,
        oldestUnreadAt: "2026-08-21T08:55:00Z",
        stateUpdatedAt: "2026-08-21T08:50:00Z",
      },
    ],
    snapshotAt: SNAPSHOT,
    unreadTotal: 1,
    unknownTotal: 1,
    totalConversations: 1,
    activeTotal: 1,
    snoozedTotal: 0,
    archivedTotal: 0,
  };
}

function messagePage(): SmsMessagesResponse {
  return {
    tenantId: TENANT,
    messages: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        tenant_id: TENANT,
        phone_e164: PHONE,
        provider: "twilio",
        direction: "outbound" as const,
        body: "private body\u202E Delivered 🚚",
        segments: 1,
        status: "sent",
        cost_micros: 7900,
        created_at: "2026-08-21T09:00:00Z",
      },
    ],
    snapshotAt: SNAPSHOT,
  };
}

async function setup(identity: MeResponse, active = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(qk.authMe(), identity);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const element = (nextMe = identity, nextActive = active): ReactNode => (
    <QueryClientProvider client={client}>
      <SmsInboxTab
        active={nextActive}
        baseKey={[
          "sms",
          nextMe.tenant_id,
          nextMe.effective_role ?? nextMe.role,
        ]}
        me={nextMe}
      />
    </QueryClientProvider>
  );
  await act(async () => root.render(element()));
  return { client, container, element, root };
}

async function eventually(assertion: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (caught) {
      error = caught;
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw error;
}

function button(
  container: HTMLElement,
  label: RegExp,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((node) =>
    label.test(node.getAttribute("aria-label") ?? node.textContent ?? ""),
  );
}

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  mocks.contextEpoch = null;
  mocks.contextListener = null;
  mocks.online = "online";
  mocks.conversations.mockReset();
  mocks.activity.mockReset();
  mocks.addTag.mockReset();
  mocks.archive.mockReset();
  mocks.assign.mockReset();
  mocks.bulk.mockReset();
  mocks.messages.mockReset();
  mocks.markRead.mockReset();
  mocks.removeTag.mockReset();
  mocks.snooze.mockReset();
  mocks.tags.mockReset();
  mocks.unarchive.mockReset();
  mocks.unsnooze.mockReset();
  mocks.whoami.mockReset();
  mocks.context.mockReset();
  mocks.senders.mockReset();
  mocks.quickReplies.mockReset();
  mocks.quickReplyUse.mockReset();
  mocks.reply.mockReset();
  mocks.copy.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  // Default thread context: the server holds live reply dispatch.
  mocks.context.mockResolvedValue(contextPayload(false));
  mocks.senders.mockResolvedValue(APPROVED_SENDERS);
  mocks.quickReplies.mockResolvedValue([]);
  mocks.quickReplyUse.mockResolvedValue({ ok: true });
  mocks.reply.mockResolvedValue(persistedOutcome());
  mocks.copy.mockResolvedValue("copied");
  window.localStorage.clear();
  mocks.conversations.mockResolvedValue(conversationPage());
  mocks.messages.mockResolvedValue(messagePage());
  mocks.markRead.mockResolvedValue({ ok: true, applied: 1 });
  mocks.tags.mockResolvedValue({
    tenantId: TENANT,
    phoneE164: PHONE,
    tags: [],
    snapshotAt: SNAPSHOT,
    truncated: false,
  });
  mocks.activity.mockResolvedValue({
    tenantId: TENANT,
    phoneE164: PHONE,
    events: [],
    snapshotAt: SNAPSHOT,
    truncated: false,
    sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"],
    historyComplete: false,
  });
  mocks.whoami.mockImplementation(() => Promise.resolve(me()));
  mocks.archive.mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    phoneE164: PHONE,
    action: "archive",
    archivedAt: "2026-08-21T10:01:00Z",
    stateUpdatedAt: "2026-08-21T10:01:01Z",
  });
  mocks.assign.mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    phoneE164: PHONE,
    action: "assign",
    assigneeUserId: USER,
    stateUpdatedAt: "2026-08-21T10:01:01Z",
  });
  mocks.bulk.mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    action: "archive",
    applied: 1,
    receipts: [],
  });
  window.history.replaceState(null, "", "/app/sms?tab=inbox");
});

afterEach(async () => {
  setOnlineStatusForTest("connecting");
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("web SMS inbox access and privacy boundary", () => {
  it("makes zero inbox requests off-tab or for an effective viewer", async () => {
    const offTab = await setup(me(), false);
    expect(offTab.container.innerHTML).toBe("");
    expect(mocks.conversations).not.toHaveBeenCalled();

    const viewer = me({
      role: "owner",
      effective_role: "viewer",
      viewer_mode: true,
    });
    const denied = await setup(viewer, true);
    expect(denied.container.textContent).toContain("SMS Inbox is restricted");
    expect(mocks.conversations).not.toHaveBeenCalled();
    expect(mocks.messages).not.toHaveBeenCalled();
  });

  it("keeps hostile content isolated and phone/body out of route and query keys", async () => {
    const { client, container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    const open = button(container, /Open conversation/u)!;
    expect(open.getAttribute("aria-label")).not.toContain("spoof Delivered");
    expect(container.textContent).not.toContain("\u202E");
    await act(async () => open.click());
    await eventually(() =>
      expect(container.textContent).toContain("Sent — delivery not confirmed"),
    );
    expect(container.textContent).not.toMatch(/· Delivered(?:\s|$)/u);
    expect(window.location.href).toContain("/app/sms?tab=inbox");
    expect(window.location.href).not.toContain(encodeURIComponent(PHONE));
    const serializedKeys = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    );
    expect(serializedKeys).not.toContain(PHONE);
    expect(serializedKeys).not.toContain("private body");
    for (const node of container.querySelectorAll("[aria-label]")) {
      expect(node.getAttribute("aria-label")).not.toContain("private body");
    }
  });

  it("returns keyboard focus to the conversation that opened a thread", async () => {
    const { client, container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );

    await act(async () => button(container, /Open conversation/u)!.click());
    await eventually(() => expect(button(container, /\bBack\b/u)).toBeDefined());
    await eventually(() =>
      expect(
        client
          .getQueryCache()
          .getAll()
          .some((query) => query.queryKey.includes("active-thread")),
      ).toBe(true),
    );
    await act(async () => button(container, /\bBack\b/u)!.click());
    await eventually(() =>
      expect(document.activeElement).toBe(
        button(container, /Open conversation/u),
      ),
    );
    const closedThreadQueries = client
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey.includes("active-thread"));
    // The disabled useInfiniteQuery observer may recreate its opaque root key,
    // but no prior message payload or nested tag/activity inventory survives.
    expect(closedThreadQueries.every((query) => query.state.data === undefined)).toBe(
      true,
    );
    expect(
      closedThreadQueries.some((query) => {
        const root = query.queryKey.indexOf("active-thread");
        return root >= 0 && root < query.queryKey.length - 1;
      }),
    ).toBe(false);
  });

  it("renders the full valid body bound and labels snapshotAt only as a response cutoff", async () => {
    const page = messagePage();
    page.messages[0]!.body = "x".repeat(4_800);
    mocks.messages.mockResolvedValueOnce(page);
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    expect(container.textContent).toContain("response cutoff");
    expect(container.textContent).toContain(
      "no continuation cursor returned; newer writes may still exist",
    );
    expect(container.textContent).not.toContain("verified snapshot");
    await act(async () => button(container, /Open conversation/u)!.click());
    await eventually(() =>
      expect(container.textContent).toContain("x".repeat(4_800)),
    );
    expect(container.textContent).not.toContain(`${"x".repeat(2_000)}…`);
  });

  it("polls only the mounted admin inbox and exposes a manual verified refresh", async () => {
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Refresh inbox/u)?.disabled).toBe(false),
    );

    expect(SMS_INBOX_POLL_MS).toBe(10_000);
    expect(shouldPollSmsInbox("online", true)).toBe(true);
    expect(smsInboxPollTargets(true, "conversations", "active-thread")).toEqual(
      ["conversations", "active-thread"],
    );
    expect(container.textContent).toContain("auto-refresh every 10 seconds");
    expect(container.textContent).toContain("last verified refresh");
    expect(mocks.conversations).toHaveBeenCalledTimes(1);

    await act(async () => button(container, /Refresh inbox/u)!.click());
    await eventually(() =>
      expect(mocks.conversations).toHaveBeenCalledTimes(2),
    );
  });

  it("does not poll or request while offline", async () => {
    mocks.online = "offline";
    const { container } = await setup(me());

    expect(mocks.conversations).not.toHaveBeenCalled();
    expect(shouldPollSmsInbox("offline", true)).toBe(false);
    expect(container.textContent).toContain(
      "Offline — no verified inbox page is available",
    );
  });

  it("pauses polling while the document is hidden", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    try {
      const { container } = await setup(me());
      expect(shouldPollSmsInbox("online", false)).toBe(false);
      expect(container.textContent).toContain("auto-refresh paused");

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      await act(async () =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await eventually(() =>
        expect(container.textContent).toContain(
          "auto-refresh every 10 seconds",
        ),
      );
    } finally {
      delete (document as unknown as { visibilityState?: string })
        .visibilityState;
    }
  });

  it("retires old cursor pages before a manual page-one refresh", async () => {
    const first = { ...conversationPage(), nextCursor: "opaque-cursor" };
    const second = {
      ...conversationPage(),
      conversations: [
        {
          ...conversationPage().conversations[0]!,
          phoneE164: "+15552345679",
          lastMessageAt: "2026-08-21T08:00:00Z",
          oldestUnreadAt: "2026-08-21T07:55:00Z",
        },
      ],
    };
    mocks.conversations.mockImplementation((input: { cursor?: string }) =>
      Promise.resolve(input.cursor ? second : first),
    );
    const { client, container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Load more conversations/u)).toBeDefined(),
    );
    await act(async () =>
      button(container, /Load more conversations/u)!.click(),
    );
    await eventually(() =>
      expect(mocks.conversations).toHaveBeenCalledTimes(2),
    );
    expect(
      client
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey.includes("conversations"))?.state.data,
    ).toMatchObject({ pages: [expect.anything(), expect.anything()] });

    await act(async () => button(container, /Refresh inbox/u)!.click());
    await eventually(() =>
      expect(mocks.conversations).toHaveBeenCalledTimes(3),
    );
    expect(mocks.conversations.mock.calls[2]?.[0]).not.toHaveProperty("cursor");
    expect(
      client
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey.includes("conversations"))?.state.data,
    ).toMatchObject({ pages: [expect.anything()] });
  });

  it("pauses automatic refresh without losing or cross-merging two loaded pages", async () => {
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      poll = callback as () => void;
      return 41 as unknown as ReturnType<typeof window.setInterval>;
    });
    const first = { ...conversationPage(), nextCursor: "opaque-cursor" };
    const second = {
      ...conversationPage(),
      conversations: [
        {
          ...conversationPage().conversations[0]!,
          phoneE164: "+15552345679",
          lastMessageAt: "2026-08-21T08:00:00Z",
          oldestUnreadAt: "2026-08-21T07:55:00Z",
        },
      ],
    };
    mocks.conversations.mockImplementation((input: { cursor?: string }) =>
      Promise.resolve(input.cursor ? second : first),
    );
    const { client, container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Load more conversations/u)).toBeDefined(),
    );
    await act(async () =>
      button(container, /Load more conversations/u)!.click(),
    );
    await eventually(() =>
      expect(mocks.conversations).toHaveBeenCalledTimes(2),
    );
    const query = client
      .getQueryCache()
      .getAll()
      .find((entry) => entry.queryKey.includes("conversations"));
    const before = query?.state.data;
    expect(shouldPauseSmsInboxPoll(before)).toBe(true);

    await act(async () => poll?.());

    expect(mocks.conversations).toHaveBeenCalledTimes(2);
    expect(query?.state.data).toBe(before);
    expect(query?.state.data).toMatchObject({
      pages: [expect.anything(), expect.anything()],
    });
    expect(container.textContent).toContain("Loaded history preserved");
    expect(container.textContent).toContain("auto-refresh paused");
  });

  it("keeps verified rows visible and labels a failed background refresh stale", async () => {
    mocks.conversations
      .mockResolvedValueOnce(conversationPage())
      .mockRejectedValueOnce(new Error("refresh failed"));
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Refresh inbox/u)?.disabled).toBe(false),
    );
    await act(async () => button(container, /Refresh inbox/u)!.click());
    await eventually(() =>
      expect(container.textContent).toContain(
        "Refresh failed; showing the last verified page set",
      ),
    );
    expect(button(container, /Open conversation/u)).toBeDefined();
  });

  it("labels an oversize legacy omission instead of rendering empty content", async () => {
    const omitted = messagePage();
    omitted.messages[0]!.body = "";
    Object.assign(omitted.messages[0]!, {
      body_omitted_reason: "body_exceeds_inbox_limit",
    });
    mocks.messages.mockResolvedValueOnce(omitted);
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    await eventually(() =>
      expect(container.textContent).toContain(
        "Message text unavailable because it exceeds the safe inbox display limit",
      ),
    );
    expect(container.textContent).not.toContain("(no text)");
  });

  it("labels unavailable legacy content without claiming an oversize body", async () => {
    const omitted = messagePage();
    omitted.messages[0]!.body = "";
    Object.assign(omitted.messages[0]!, {
      body_omitted_reason: "legacy_body_unavailable",
    });
    mocks.messages.mockResolvedValueOnce(omitted);
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    await eventually(() =>
      expect(container.textContent).toContain(
        "Legacy message content unavailable",
      ),
    );
    expect(container.textContent).not.toContain(
      "exceeds the safe inbox display limit",
    );
  });

  it("aborts and removes the protected cache on tab exit", async () => {
    let signal: AbortSignal | undefined;
    mocks.conversations.mockImplementation((input: unknown) => {
      signal = (input as { signal: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
    const identity = me();
    const { client, element, root } = await setup(identity);
    await eventually(() => expect(signal).toBeDefined());
    await act(async () => root.render(element(identity, false)));
    await eventually(() => expect(signal?.aborted).toBe(true));
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey.includes("inbox-v2")),
    ).toHaveLength(0);
  });

  it("clears protected state on demotion and aborts on context movement", async () => {
    let firstSignal: AbortSignal | undefined;
    mocks.conversations.mockImplementationOnce((input: unknown) => {
      firstSignal = (input as { signal: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        firstSignal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
    const admin = me();
    const { client, container, element, root } = await setup(admin);
    await eventually(() => expect(firstSignal).toBeDefined());
    await act(async () => {
      mocks.contextEpoch = "epoch-2";
      mocks.contextListener?.("epoch-2");
    });
    await eventually(() => expect(firstSignal?.aborted).toBe(true));

    const viewer = me({ effective_role: "viewer", viewer_mode: true });
    client.setQueryData(qk.authMe(), viewer);
    await act(async () => root.render(element(viewer, true)));
    expect(container.textContent).toContain("SMS Inbox is restricted");
    await eventually(() =>
      expect(
        client
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey.includes("inbox-v2")),
      ).toHaveLength(0),
    );
  });

  it("marks only displayed inbound UUIDs after the first page settles", async () => {
    let resolveMessages:
      | ((value: ReturnType<typeof messagePage>) => void)
      | null = null;
    mocks.messages.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMessages = resolve;
      }),
    );
    const inbound = messagePage();
    inbound.messages[0]!.direction = "inbound";
    inbound.messages[0]!.status = "received";
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    expect(mocks.markRead).not.toHaveBeenCalled();

    await act(async () => resolveMessages?.(inbound));
    await eventually(() =>
      expect(container.textContent).toContain("private body"),
    );
    await eventually(() => expect(mocks.markRead).toHaveBeenCalledTimes(1));
    expect(mocks.markRead).toHaveBeenCalledWith(
      PHONE,
      ["33333333-3333-4333-8333-333333333333"],
      { signal: expect.any(AbortSignal) },
    );
    expect(JSON.stringify(mocks.markRead.mock.calls[0])).not.toContain(
      SNAPSHOT,
    );
  });

  it("reauthorizes around an exact-version archive and requires confirmation", async () => {
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    await eventually(() => expect(button(container, /Archive/u)).toBeDefined());

    await act(async () => button(container, /Archive/u)!.click());
    await eventually(() =>
      expect(button(document.body, /^Archive conversation$/u)).toBeDefined(),
    );
    await act(async () =>
      button(document.body, /^Archive conversation$/u)!.click(),
    );
    await eventually(() => expect(mocks.archive).toHaveBeenCalledTimes(1));

    expect(mocks.archive).toHaveBeenCalledWith({
      tenantId: TENANT,
      phoneE164: PHONE,
      expectedUpdatedAt: "2026-08-21T08:50:00Z",
    });
    expect(mocks.whoami).toHaveBeenCalledTimes(2);
  });

  it("assigns only to the freshly reauthorized current operator", async () => {
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    await eventually(() =>
      expect(button(container, /^Assign to me$/u)).toBeDefined(),
    );
    await act(async () => button(container, /^Assign to me$/u)!.click());
    await eventually(() => expect(mocks.assign).toHaveBeenCalledTimes(1));

    expect(mocks.assign).toHaveBeenCalledWith({
      tenantId: TENANT,
      phoneE164: PHONE,
      expectedUpdatedAt: "2026-08-21T08:50:00Z",
      assigneeUserId: USER,
    });
    expect(container.textContent).toContain("Assigned to you");
  });

  it("locks every tag write when the loaded inventory is truncated", async () => {
    mocks.tags.mockResolvedValueOnce({
      tenantId: TENANT,
      phoneE164: PHONE,
      tags: [{ tag: "priority", createdAt: "2026-08-21T08:00:00Z" }],
      snapshotAt: SNAPSHOT,
      truncated: true,
    });
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    await eventually(() =>
      expect(button(container, /^Remove tag priority$/u)?.disabled).toBe(true),
    );
    expect(
      container.querySelector<HTMLInputElement>("#sms-conversation-tag")
        ?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain("writes are locked");
  });

  it("bulk-archives only a selected single-bucket current inventory", async () => {
    const { container } = await setup(me());
    await eventually(() =>
      expect(
        container.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      ).not.toBeNull(),
    );
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => checkbox.click());
    await eventually(() =>
      expect(container.textContent).toContain("1 selected"),
    );
    const archiveTriggers = Array.from(container.querySelectorAll("button")).filter(
      (node) => node.textContent?.trim() === "Archive",
    );
    await act(async () => archiveTriggers.at(-1)?.click());
    await eventually(() =>
      expect(button(document.body, /^Apply to selection$/u)).toBeDefined(),
    );
    await act(async () =>
      button(document.body, /^Apply to selection$/u)!.click(),
    );
    await eventually(() => expect(mocks.bulk).toHaveBeenCalledTimes(1));

    expect(mocks.bulk).toHaveBeenCalledWith({
      tenantId: TENANT,
      action: "archive",
      conversations: [
        {
          phoneE164: PHONE,
          expectedUpdatedAt: "2026-08-21T08:50:00Z",
        },
      ],
    });
  });

  it("wires every lifecycle bucket to a distinct server query identity", async () => {
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /^Active/u)?.disabled).toBe(false),
    );
    for (const [label, expectedStatus] of [
      ["Snoozed", "snoozed"],
      ["Archived", "archived"],
      ["All", "any"],
      ["Active", "active"],
    ] as const) {
      const labelPattern = new RegExp(`^${label}`, "u");
      await eventually(() =>
        expect(button(container, labelPattern)?.disabled).toBe(false),
      );
      await act(async () => button(container, labelPattern)!.click());
      await eventually(() =>
        expect(mocks.conversations.mock.calls.at(-1)?.[0]).toMatchObject({
          status: expectedStatus,
        }),
      );
    }
  });
});

describe("web SMS inbox thread mounts (filters, context, composer, copy, retry)", () => {
  it("sends filter and sort as server query identity and relabels the count line", async () => {
    const { client, container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    expect(mocks.conversations).toHaveBeenCalledTimes(1);
    expect(mocks.conversations.mock.calls[0]?.[0]).toMatchObject({
      tenantId: TENANT,
      status: "active",
      filter: "all",
      sort: "recent",
      limit: 50,
    });
    expect(container.textContent).toContain("1 shown of 1 active");
    // Chips carry the inbox-wide totals from the loaded page.
    expect(button(container, /^Unread \(1\)$/u)).toBeDefined();
    expect(button(container, /^Unknown subscriber \(1\)$/u)).toBeDefined();

    await act(async () => button(container, /^Unread \(1\)$/u)!.click());
    await eventually(() =>
      expect(mocks.conversations.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "active",
        filter: "unread",
        sort: "recent",
      }),
    );
    expect(mocks.conversations.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "cursor",
    );
    await eventually(() =>
      expect(container.textContent).toContain(
        "1 shown · unread filter (1 unread inbox-wide)",
      ),
    );
    expect(container.textContent).not.toContain("1 shown of 1 active");
    expect(
      client
        .getQueryCache()
        .getAll()
        .some(
          (query) =>
            query.queryKey.includes("conversations") &&
            query.queryKey.includes("unread") &&
            query.queryKey.includes("recent"),
        ),
    ).toBe(true);

    const sort = Array.from(container.querySelectorAll("select")).find((node) =>
      Array.from(node.options).some((option) => option.value === "oldest_unread"),
    );
    expect(sort).toBeDefined();
    selectValue(sort!, "oldest_unread");
    await eventually(() =>
      expect(mocks.conversations.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "active",
        filter: "unread",
        sort: "oldest_unread",
      }),
    );
    expect(container.textContent).toContain("Oldest unread orders by");
  });

  it("mounts the consent context panel for the open thread under the opaque thread prefix", async () => {
    const { client, container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    const panel = () =>
      container.querySelector<HTMLElement>(
        'section[aria-label="Subscriber and consent context"]',
      );
    await eventually(() => expect(panel()).not.toBeNull());
    await eventually(() =>
      expect(panel()!.textContent).toContain("Opted in"),
    );
    expect(mocks.context).toHaveBeenCalledWith({
      tenantId: TENANT,
      phoneE164: PHONE,
      signal: expect.any(AbortSignal),
    });
    expect(panel()!.textContent).toContain("sub@example.test");
    expect(panel()!.textContent).toContain("VIP texts");
    expect(panel()!.textContent).toContain(
      "Live dispatch unavailable · no provider request can start.",
    );
    expect(panel()!.textContent).toContain(
      "SMS reply dispatch is release-held on the server.",
    );
    expect(panel()!.textContent).toContain("1 retained message record");
    const keys = client.getQueryCache().getAll().map((q) => q.queryKey);
    expect(
      keys.some(
        (key) => key.includes("active-thread") && key.includes("context"),
      ),
    ).toBe(true);
    expect(serializedQueryKeys(client)).not.toContain(PHONE);
  });

  it("renders the reply composer held with the server's hold copy and sends nothing", async () => {
    const { client, container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    const composer = () =>
      container.querySelector<HTMLElement>(
        'section[aria-label="Reply composer"]',
      );
    await eventually(() => expect(composer()).not.toBeNull());
    await eventually(() => expect(mocks.senders).toHaveBeenCalled());
    await eventually(() =>
      expect(composer()!.textContent).toContain("+1 (415) 555-0100"),
    );
    await eventually(() => expect(composer()!.textContent).toContain(HOLD));
    expect(composer()!.querySelector("code")?.textContent).toBe(
      "sms_reply_dispatch_release_held",
    );

    const textarea = composer()!.querySelector("textarea")!;
    setValue(textarea, "Thanks, on it");
    const send = button(composer()!, /^Send reply$/u)!;
    await eventually(() =>
      expect(send.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(send.getAttribute("title")).toBe(HOLD);
    const describedBy = send.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe(HOLD);

    await act(async () => send.click());
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
        }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(serializedQueryKeys(client)).not.toContain(PHONE);
    expect(serializedQueryKeys(client)).not.toContain("Thanks, on it");
  });

  it("sends the exact reply under one durable key once the server lifts the hold", async () => {
    mocks.context.mockResolvedValue(contextPayload(true));
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    const composer = () =>
      container.querySelector<HTMLElement>(
        'section[aria-label="Reply composer"]',
      );
    await eventually(() => expect(composer()).not.toBeNull());
    await eventually(() =>
      expect(composer()!.textContent).toContain("+1 (415) 555-0100"),
    );
    const messagesBefore = mocks.messages.mock.calls.length;
    const conversationsBefore = mocks.conversations.mock.calls.length;

    setValue(composer()!.querySelector("textarea")!, "  Thanks, on it ");
    const send = button(composer()!, /^Send reply$/u)!;
    await eventually(() =>
      expect(send.getAttribute("aria-disabled")).toBe("false"),
    );
    await act(async () => send.click());
    await eventually(() => expect(mocks.reply).toHaveBeenCalledTimes(1));
    expect(mocks.reply).toHaveBeenCalledWith({
      phoneE164: PHONE,
      request: {
        sender_profile_id: SENDER,
        body: "Thanks, on it",
        list_id: LIST,
      },
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    await eventually(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Reply persisted with a provider receipt",
      ),
    );
    // The persisted receipt restarts the thread and inbox at latest.
    await eventually(() =>
      expect(mocks.messages.mock.calls.length).toBeGreaterThan(messagesBefore),
    );
    await eventually(() =>
      expect(mocks.conversations.mock.calls.length).toBeGreaterThan(
        conversationsBefore,
      ),
    );
    expect(window.localStorage.length).toBe(0);
    expect(composer()!.querySelector("textarea")!.value).toBe("");
  });

  it("offers Copy on every retained bubble, copies the raw body, and surfaces a refused clipboard", async () => {
    const page = messagePage();
    const outboundBody = page.messages[0]!.body;
    const inboundBody = "inbound reply ✓";
    page.messages.push(
      {
        ...page.messages[0]!,
        id: "33333333-3333-4333-8333-333333333334",
        direction: "inbound",
        status: "received",
        body: inboundBody,
        created_at: "2026-08-21T08:59:00Z",
      },
      {
        ...page.messages[0]!,
        id: "33333333-3333-4333-8333-333333333335",
        body: "",
        body_omitted_reason: "legacy_body_unavailable",
        created_at: "2026-08-21T08:58:00Z",
      },
    );
    mocks.messages.mockResolvedValue(page);
    mocks.markRead.mockResolvedValue({ ok: true, applied: 1 });
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    const copyButtons = () =>
      Array.from(container.querySelectorAll("button")).filter((node) =>
        /^(Copy message body|Message body copied)$/u.test(
          node.getAttribute("aria-label") ?? "",
        ),
      );
    await eventually(() => expect(copyButtons()).toHaveLength(2));

    mocks.copy.mockResolvedValueOnce("copied").mockResolvedValueOnce("error");
    for (const node of copyButtons()) await act(async () => node.click());
    await eventually(() => expect(mocks.copy).toHaveBeenCalledTimes(2));
    expect(
      mocks.copy.mock.calls.map((call) => call[0] as string).sort(),
    ).toEqual([outboundBody, inboundBody].sort());
    await eventually(() =>
      expect(
        copyButtons().some(
          (node) => node.getAttribute("aria-label") === "Message body copied",
        ),
      ).toBe(true),
    );
    expect(container.textContent).toContain(
      "Copy failed: the browser refused clipboard access.",
    );
  });

  it("offers Retry only on a terminally failed outbound message and retries it under one durable key", async () => {
    mocks.context.mockResolvedValue(contextPayload(true));
    const page = messagePage();
    const failedBody = "please call us back‮";
    page.messages.push(
      {
        ...page.messages[0]!,
        id: "33333333-3333-4333-8333-333333333336",
        status: "failed",
        error_code: "30007",
        body: failedBody,
        created_at: "2026-08-21T08:59:00Z",
      },
      {
        ...page.messages[0]!,
        id: "33333333-3333-4333-8333-333333333337",
        direction: "inbound",
        status: "failed",
        body: "inbound cannot be retried",
        created_at: "2026-08-21T08:58:00Z",
      },
    );
    mocks.messages.mockResolvedValue(page);
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    const retryButtons = () =>
      Array.from(container.querySelectorAll("button")).filter(
        (node) => node.textContent?.trim() === "Retry",
      );
    await eventually(() =>
      expect(container.textContent).toContain("please call us back"),
    );
    expect(retryButtons()).toHaveLength(1);

    await act(async () => retryButtons()[0]!.click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Retry this failed SMS?"),
    );
    const confirm = () => button(document.body, /^Retry SMS$/u);
    await eventually(() => expect(confirm()?.disabled).toBe(false));
    await act(async () => confirm()!.click());
    await eventually(() => expect(mocks.reply).toHaveBeenCalledTimes(1));
    expect(mocks.reply).toHaveBeenCalledWith({
      phoneE164: PHONE,
      request: {
        sender_profile_id: SENDER,
        body: failedBody,
        list_id: LIST,
      },
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    await eventually(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Retry persisted with a provider receipt",
      ),
    );
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps a failed message's retry held with the server hold copy", async () => {
    const page = messagePage();
    page.messages[0]!.status = "undelivered";
    mocks.messages.mockResolvedValue(page);
    const { container } = await setup(me());
    await eventually(() =>
      expect(button(container, /Open conversation/u)).toBeDefined(),
    );
    await act(async () => button(container, /Open conversation/u)!.click());
    const retry = () =>
      Array.from(container.querySelectorAll("button")).find(
        (node) => node.textContent?.trim() === "Retry",
      );
    await eventually(() => expect(retry()).toBeDefined());
    await act(async () => retry()!.click());
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    const confirm = () => button(dialog()!, /^Retry SMS$/u);
    await eventually(() => expect(confirm()).toBeDefined());
    // The dialog's own reason (not the composer's hold notice outside it)
    // must settle on the server hold sentence once its context read lands.
    await eventually(() =>
      expect(
        document.getElementById(confirm()!.getAttribute("aria-describedby")!)
          ?.textContent,
      ).toBe(HOLD),
    );
    expect(confirm()!.disabled).toBe(true);
    expect(dialog()!.textContent).toContain(HOLD);
    await act(async () => confirm()!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(mocks.reply).not.toHaveBeenCalled();
  });
});
