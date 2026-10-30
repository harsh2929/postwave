// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archiveMacro: vi.fn(),
  assignConversation: vi.fn(),
  createNote: vi.fn(),
  getConversation: vi.fn(),
  listConversations: vi.fn(),
  listMacros: vi.fn(),
  listMessages: vi.fn(),
  listTickets: vi.fn(),
  patchMacro: vi.fn(),
  patchTicket: vi.fn(),
  setStatus: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/service-suite-operations-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/service-suite-operations-api")
  >()),
  archiveHelpdeskMacro: mocks.archiveMacro,
  assignHelpdeskConversation: mocks.assignConversation,
  createHelpdeskInternalNote: mocks.createNote,
  getHelpdeskConversation: mocks.getConversation,
  listHelpdeskConversations: mocks.listConversations,
  listHelpdeskMacros: mocks.listMacros,
  listHelpdeskMessages: mocks.listMessages,
  listHelpdeskTickets: mocks.listTickets,
  patchHelpdeskMacro: mocks.patchMacro,
  patchHelpdeskTicket: mocks.patchTicket,
  setHelpdeskConversationStatus: mocks.setStatus,
  newInternalNoteKey: () =>
    "helpdesk-note-77777777-7777-4777-8777-777777777777",
}));

import { ServiceSuiteOperations } from "@/app/(dashboard)/app/service-suite/service-suite-operations";
import type { ServiceSuiteIdentity } from "@/lib/service-suite-access";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const V1 = "2026-08-29T10:00:00.1Z";
const roots: Root[] = [];
const ORIGIN = "https://app.postwave.test";
const USER = "44444444-4444-4444-8444-444444444444";
const EPOCH = "epoch-helpdesk-test";
const FINGERPRINT = JSON.stringify([ORIGIN, TENANT, USER, "admin", EPOCH]);

const identity: ServiceSuiteIdentity = {
  origin: ORIGIN,
  tenantId: TENANT,
  userId: USER,
  effectiveRole: "admin",
  contextEpoch: EPOCH,
  fingerprint: FINGERPRINT,
  queryBase: [
    "service-suite-v2",
    FINGERPRINT,
    ORIGIN,
    TENANT,
    USER,
    "admin",
    EPOCH,
  ],
};

const pageInfo = {
  hasMore: false,
  nextCursor: null,
  asOf: "2026-08-29T10:01:00Z",
  consistency: "mutable_window" as const,
  mayReorder: true as const,
};

const conversation = {
  tenantId: TENANT,
  id: CONVERSATION_ID,
  version: V1,
  channelId: null,
  channelType: "email" as const,
  sourceType: "inbound_email" as const,
  subscriberId: null,
  requesterEmail: "customer@example.test",
  requesterPhone: null,
  requesterName: "Ada Customer",
  subject: "Refund question",
  status: "open" as const,
  priority: "high" as const,
  assignedTo: null,
  assignedToUserId: null,
  assignmentState: "unassigned" as const,
  tags: [],
  lastMessageAt: "2026-08-29T09:30:00Z",
  createdAt: "2026-08-29T09:00:00Z",
  updatedAt: V1,
};

const message = {
  tenantId: TENANT,
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  sourceType: "inbound_email",
  direction: "inbound" as const,
  senderType: "customer" as const,
  sender: "customer@example.test",
  bodyText: '<img src=x onerror="window.pwned=true"> plain customer text',
  bodyOmittedReason: null,
  recordKind: "inbound_record" as const,
  deliveryStatus: "received" as const,
  attachmentCount: 0,
  projectionTruncated: false,
  sentAt: "2026-08-29T09:30:00Z",
  createdAt: "2026-08-29T09:30:01Z",
};

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  do {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await act(
      async () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        }),
    );
  } while (Date.now() < deadline);
  throw lastError;
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ServiceSuiteOperations identity={identity} />
      </QueryClientProvider>,
    );
  });
  return container;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`button ${name} not found`);
  }
  return found;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue({
    user_id: identity.userId,
    tenant_id: TENANT,
    email: "admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
  });
  mocks.listConversations.mockResolvedValue({
    tenantId: TENANT,
    items: [conversation],
    page: pageInfo,
  });
  mocks.getConversation.mockResolvedValue(conversation);
  mocks.listMessages.mockResolvedValue({
    tenantId: TENANT,
    items: [message],
    page: { ...pageInfo, consistency: "created_at_window" },
  });
  mocks.listTickets.mockResolvedValue({
    tenantId: TENANT,
    items: [],
    page: pageInfo,
  });
  mocks.listMacros.mockResolvedValue({
    tenantId: TENANT,
    items: [],
    page: pageInfo,
  });
  mocks.createNote.mockResolvedValue({
    message: {
      ...message,
      id: "55555555-5555-4555-8555-555555555555",
      direction: "internal",
      senderType: "agent",
      bodyText: "Private review",
      recordKind: "internal_note",
      deliveryStatus: "not_applicable",
    },
    idempotencyKey:
      "helpdesk-note-77777777-7777-4777-8777-777777777777",
    created: true,
    replayed: false,
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Service Suite Helpdesk operations", () => {
  it("makes zero protected-record requests when fresh exact-admin reauthorization fails", async () => {
    mocks.whoami.mockResolvedValueOnce({
      user_id: identity.userId,
      tenant_id: TENANT,
      email: "viewer@example.test",
      role: "viewer",
      effective_role: "viewer",
      viewer_mode: false,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Test",
      workspace_slug: "test",
    });
    const container = await mount();
    await eventually(() => {
      expect(container.textContent).toContain(
        "Helpdesk access could not be reauthorized",
      );
    });
    expect(mocks.listConversations).not.toHaveBeenCalled();
    expect(mocks.listTickets).not.toHaveBeenCalled();
    expect(mocks.listMacros).not.toHaveBeenCalled();
    expect(mocks.listMessages).not.toHaveBeenCalled();
    expect(mocks.getConversation).not.toHaveBeenCalled();
  });

  it("loads only the selected queue and states every release-held action", async () => {
    const container = await mount();
    await eventually(() => {
      expect(container.textContent).toContain("Refund question");
    });
    expect(mocks.listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, signal: expect.any(AbortSignal) }),
    );
    expect(mocks.listTickets).not.toHaveBeenCalled();
    expect(mocks.listMacros).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Customer and provider replies are release-held");
    expect(container.textContent).toContain("Internal notes are private workspace records");
    const actionLabels = [...container.querySelectorAll("button")].map((item) =>
      item.textContent?.trim().toLowerCase(),
    );
    expect(actionLabels).not.toContain("send reply");
    expect(actionLabels).not.toContain("create ticket");
    expect(actionLabels).not.toContain("create macro");
  });

  it("opens tenant detail, renders customer markup as text, and proves linked-ticket emptiness", async () => {
    const container = await mount();
    await eventually(() => expect(container.textContent).toContain("Refund question"));
    await act(async () => button("Review conversation with Ada Customer").click());
    await eventually(() => {
      expect(document.body.textContent).toContain("Conversation review");
      expect(document.body.textContent).toContain("Verified empty linked-ticket window");
      expect(document.body.textContent).toContain("<img src=x onerror=");
    });
    expect(document.querySelector("img")).toBeNull();
    expect(mocks.getConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        conversationId: CONVERSATION_ID,
      }),
    );
    expect(mocks.listTickets).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
    );
  });

  it("confirms a private note and never models it as a customer send", async () => {
    const container = await mount();
    await eventually(() => expect(container.textContent).toContain("Refund question"));
    await act(async () => button("Review conversation with Ada Customer").click());
    await eventually(() => expect(document.body.textContent).toContain("Private internal note"));

    const textarea = document.querySelector("textarea#internal-note");
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    await act(async () => {
      const field = textarea as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(field, "Private review");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await eventually(() => {
      expect(button("Review and add private note").disabled).toBe(false);
    });
    await act(async () => button("Review and add private note").click());
    await eventually(() => expect(document.body.textContent).toContain("Record this private internal note?"));
    await act(async () => button("Add private note").click());
    await eventually(() => expect(mocks.createNote).toHaveBeenCalledTimes(1));
    expect(mocks.createNote).toHaveBeenCalledWith({
      tenantId: TENANT,
      conversationId: CONVERSATION_ID,
      bodyText: "Private review",
      idempotencyKey:
        "helpdesk-note-77777777-7777-4777-8777-777777777777",
    });
    expect(document.body.textContent).toContain("Private internal note recorded");
  });
});
