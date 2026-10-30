// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Helpdesk queue parity with desktop HelpdeskInbox:
//   - local search over the loaded conversation page (+ clear), no request;
//   - "Insert macro text" in the private-note composer, loading the COMPLETE
//     macro library on first focus and refusing a partial one, with a
//     "Retry complete macro list" path.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createNote: vi.fn(),
  getConversation: vi.fn(),
  listConversations: vi.fn(),
  listMacros: vi.fn(),
  listMessages: vi.fn(),
  listTickets: vi.fn(),
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
  createHelpdeskInternalNote: mocks.createNote,
  getHelpdeskConversation: mocks.getConversation,
  listHelpdeskConversations: mocks.listConversations,
  listHelpdeskMacros: mocks.listMacros,
  listHelpdeskMessages: mocks.listMessages,
  listHelpdeskTickets: mocks.listTickets,
  newInternalNoteKey: () => "helpdesk-note-88888888-8888-4888-8888-888888888888",
}));

import { ServiceSuiteOperations } from "@/app/(dashboard)/app/service-suite/service-suite-operations";
import type { ServiceSuiteIdentity } from "@/lib/service-suite-access";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "44444444-4444-4444-8444-444444444444";
const ORIGIN = "https://app.postwave.test";
const EPOCH = "epoch-queue-search";
const FINGERPRINT = JSON.stringify([ORIGIN, TENANT, USER, "admin", EPOCH]);
const V1 = "2026-08-29T10:00:00.1Z";

const identity: ServiceSuiteIdentity = {
  origin: ORIGIN,
  tenantId: TENANT,
  userId: USER,
  effectiveRole: "admin",
  contextEpoch: EPOCH,
  fingerprint: FINGERPRINT,
  queryBase: ["service-suite-v2", FINGERPRINT, ORIGIN, TENANT, USER, "admin", EPOCH],
};

const pageInfo = {
  hasMore: false,
  nextCursor: null as string | null,
  asOf: "2026-08-29T10:01:00Z",
  consistency: "mutable_window" as const,
  mayReorder: true as const,
};

function conversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    id,
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
    tags: [] as string[],
    lastMessageAt: "2026-08-29T09:30:00Z",
    createdAt: "2026-08-29T09:00:00Z",
    updatedAt: V1,
    ...overrides,
  };
}

const ADA = conversation("22222222-2222-4222-8222-222222222222");
const GRACE = conversation("33333333-3333-4333-8333-333333333333", {
  requesterName: "Grace Buyer",
  requesterEmail: "grace@example.test",
  subject: "Shipping delay",
  tags: ["vip-escalation"],
});

function macro(id: string, name: string, body: string, status = "active") {
  return {
    tenantId: TENANT,
    id,
    version: V1,
    name,
    body,
    channelTypes: ["email"],
    tags: [],
    status,
    useCount: 0,
    lastUsedAt: null,
    usageEvidenceStatus: "unverified" as const,
    createdAt: "2026-08-29T09:00:00Z",
    updatedAt: V1,
  };
}

const REFUND = macro("55555555-5555-4555-8555-555555555555", "Refund policy", "Refunds post within 5 business days.");
const APOLOGY = macro("66666666-6666-4666-8666-666666666666", "Apology", "Sorry for the wait.");
const RETIRED = macro("77777777-7777-4777-8777-777777777777", "Old greeting", "Howdy.", "archived");

const roots: Root[] = [];

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  throw last;
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ServiceSuiteOperations identity={identity} />
      </QueryClientProvider>,
    );
  });
  await eventually(() => expect(container.textContent).toContain("Refund question"));
  return container;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button ${name} not found`);
  return found;
}

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function macroSelect(): HTMLSelectElement {
  const select = document.querySelector("select#internal-note-macro");
  if (!(select instanceof HTMLSelectElement)) throw new Error("no macro picker");
  return select;
}

async function openConversation() {
  await act(async () => button("Review conversation with Ada Customer").click());
  await eventually(() =>
    expect(document.body.textContent).toContain("Insert macro text into this note"),
  );
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue({
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
  });
  mocks.listConversations.mockResolvedValue({
    tenantId: TENANT,
    items: [ADA, GRACE],
    page: pageInfo,
  });
  mocks.getConversation.mockResolvedValue(ADA);
  mocks.listMessages.mockResolvedValue({
    tenantId: TENANT,
    items: [],
    page: { ...pageInfo, consistency: "created_at_window" },
  });
  mocks.listTickets.mockResolvedValue({ tenantId: TENANT, items: [], page: pageInfo });
  mocks.createNote.mockImplementation(async (args: { bodyText: string }) => ({
    message: {
      tenantId: TENANT,
      id: "99999999-9999-4999-8999-999999999999",
      conversationId: ADA.id,
      sourceType: "manual",
      direction: "internal",
      senderType: "agent",
      sender: "admin@example.test",
      bodyText: args.bodyText,
      bodyOmittedReason: null,
      recordKind: "internal_note",
      deliveryStatus: "not_applicable",
      attachmentCount: 0,
      projectionTruncated: false,
      sentAt: "2026-08-29T10:05:00Z",
      createdAt: "2026-08-29T10:05:00Z",
    },
    idempotencyKey: "helpdesk-note-88888888-8888-4888-8888-888888888888",
    created: true,
    replayed: false,
  }));
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("conversation queue local search", () => {
  it("filters the loaded page by requester, subject, or tag without a request, and clears", async () => {
    const container = await mount();
    const search = container.querySelector("input#conversation-queue-search");
    expect(search).toBeInstanceOf(HTMLInputElement);
    const requests = mocks.listConversations.mock.calls.length;

    await type(search as HTMLInputElement, "VIP-ESC");
    await eventually(() => {
      expect(container.textContent).toContain("Shipping delay");
      expect(container.textContent).not.toContain("Refund question");
    });

    await type(search as HTMLInputElement, "nobody-matches");
    await eventually(() =>
      expect(container.textContent).toContain("No matching conversations on this page"),
    );
    expect(container.textContent).toContain("None of the 2 loaded conversation(s)");

    await act(async () => button("Clear search").click());
    await eventually(() => {
      expect(container.textContent).toContain("Refund question");
      expect(container.textContent).toContain("Shipping delay");
    });
    expect((search as HTMLInputElement).value).toBe("");
    // Local only: the server window was never re-queried for the text.
    expect(mocks.listConversations).toHaveBeenCalledTimes(requests);
    expect(JSON.stringify(mocks.listConversations.mock.calls)).not.toContain("nobody");
  });
});

describe("insert macro text into a private note", () => {
  it("loads every macro page on first focus, offers only active macros, and appends the chosen text", async () => {
    mocks.listMacros
      .mockResolvedValueOnce({
        tenantId: TENANT,
        items: [REFUND, RETIRED],
        page: { ...pageInfo, hasMore: true, nextCursor: "cursor-page-2" },
      })
      .mockResolvedValueOnce({ tenantId: TENANT, items: [APOLOGY], page: pageInfo });
    await mount();
    await openConversation();
    // Opening a conversation does not read the macro library.
    expect(mocks.listMacros).not.toHaveBeenCalled();

    await act(async () => macroSelect().focus());
    await eventually(() => expect(mocks.listMacros).toHaveBeenCalledTimes(2));
    expect(mocks.listMacros.mock.calls[0]?.[0]).toMatchObject({
      tenantId: TENANT,
      limit: 100,
      cursor: null,
    });
    expect(mocks.listMacros.mock.calls[1]?.[0]).toMatchObject({
      tenantId: TENANT,
      limit: 100,
      cursor: "cursor-page-2",
    });
    await eventually(() =>
      expect([...macroSelect().options].map((option) => option.textContent)).toEqual([
        "Insert macro text…",
        "Refund policy",
        "Apology",
      ]),
    );

    const note = document.querySelector("textarea#internal-note") as HTMLTextAreaElement;
    await type(note, "Checked the order.   ");
    await act(async () => {
      macroSelect().value = REFUND.id;
      macroSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(note.value).toBe("Checked the order.\n\nRefunds post within 5 business days.");
    expect(macroSelect().value).toBe("");

    await act(async () => button("Review and add private note").click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Record this private internal note?"),
    );
    await act(async () => button("Add private note").click());
    await eventually(() => expect(mocks.createNote).toHaveBeenCalledTimes(1));
    expect(mocks.createNote.mock.calls[0]?.[0]).toMatchObject({
      conversationId: ADA.id,
      bodyText: "Checked the order.\n\nRefunds post within 5 business days.",
    });
  });

  it("refuses a partial library and retries the complete list", async () => {
    mocks.listMacros
      .mockResolvedValueOnce({
        tenantId: TENANT,
        items: [REFUND],
        page: { ...pageInfo, hasMore: true, nextCursor: "loop" },
      })
      .mockResolvedValueOnce({
        tenantId: TENANT,
        items: [APOLOGY],
        page: { ...pageInfo, hasMore: true, nextCursor: "loop" },
      });
    await mount();
    await openConversation();
    await act(async () => macroSelect().focus());
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "Macro pagination repeated a cursor. No partial macro list was offered.",
      ),
    );
    expect(macroSelect().disabled).toBe(true);
    expect([...macroSelect().options]).toHaveLength(1);

    mocks.listMacros.mockResolvedValueOnce({ tenantId: TENANT, items: [APOLOGY], page: pageInfo });
    await act(async () => button("Retry complete macro list").click());
    await eventually(() =>
      expect([...macroSelect().options].map((option) => option.textContent)).toEqual([
        "Insert macro text…",
        "Apology",
      ]),
    );
    expect(macroSelect().disabled).toBe(false);
    expect(mocks.listMacros).toHaveBeenCalledTimes(3);
  });
});
