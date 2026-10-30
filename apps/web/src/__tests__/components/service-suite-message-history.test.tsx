// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Helpdesk conversation review: "Older messages" walks the server's message
// cursor (GET /api/v1/service-suite/conversations/{id}/messages?cursor=…),
// newest records first, and "Newer messages" returns to the prior page.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
  getHelpdeskConversation: mocks.getConversation,
  listHelpdeskConversations: mocks.listConversations,
  listHelpdeskMacros: mocks.listMacros,
  listHelpdeskMessages: mocks.listMessages,
  listHelpdeskTickets: mocks.listTickets,
}));

import { ServiceSuiteOperations } from "@/app/(dashboard)/app/service-suite/service-suite-operations";
import type { ServiceSuiteIdentity } from "@/lib/service-suite-access";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const USER = "44444444-4444-4444-8444-444444444444";
const ORIGIN = "https://app.postwave.test";
const EPOCH = "epoch-helpdesk-history";
const FINGERPRINT = JSON.stringify([ORIGIN, TENANT, USER, "admin", EPOCH]);
const roots: Root[] = [];

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
  nextCursor: null,
  asOf: "2026-08-29T10:01:00Z",
  consistency: "mutable_window" as const,
  mayReorder: true as const,
};

const conversation = {
  tenantId: TENANT,
  id: CONVERSATION_ID,
  version: "2026-08-29T10:00:00.1Z",
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
  updatedAt: "2026-08-29T10:00:00.1Z",
};

function message(id: string, bodyText: string, sentAt: string) {
  return {
    tenantId: TENANT,
    id,
    conversationId: CONVERSATION_ID,
    sourceType: "inbound_email",
    direction: "inbound" as const,
    senderType: "customer" as const,
    sender: "customer@example.test",
    bodyText,
    bodyOmittedReason: null,
    recordKind: "inbound_record" as const,
    deliveryStatus: "received" as const,
    attachmentCount: 0,
    projectionTruncated: false,
    sentAt,
    createdAt: sentAt,
  };
}

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
    await act(async () => new Promise<void>((r) => setTimeout(r, 0)));
  } while (Date.now() < deadline);
  throw lastError;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name ||
      candidate.getAttribute("aria-label") === name,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button ${name} not found`);
  return found;
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
    items: [conversation],
    page: pageInfo,
  });
  mocks.getConversation.mockResolvedValue(conversation);
  mocks.listTickets.mockResolvedValue({ tenantId: TENANT, items: [], page: pageInfo });
  mocks.listMacros.mockResolvedValue({ tenantId: TENANT, items: [], page: pageInfo });
  mocks.listMessages.mockImplementation(
    async (args: { cursor?: string | null }) =>
      args.cursor === "cursor-older"
        ? {
            tenantId: TENANT,
            items: [
              message(
                "66666666-6666-4666-8666-666666666666",
                "Older customer text",
                "2026-08-28T09:00:00Z",
              ),
            ],
            page: { ...pageInfo, consistency: "created_at_window" },
          }
        : {
            tenantId: TENANT,
            items: [
              message(
                "55555555-5555-4555-8555-555555555555",
                "Newest customer text",
                "2026-08-29T09:30:00Z",
              ),
            ],
            page: {
              ...pageInfo,
              consistency: "created_at_window",
              hasMore: true,
              nextCursor: "cursor-older",
            },
          },
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Helpdesk message history paging", () => {
  it("loads older message records with the server cursor and returns to newer ones", async () => {
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
    await act(async () => button("Review conversation with Ada Customer").click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Newest customer text"),
    );
    expect(mocks.listMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        conversationId: CONVERSATION_ID,
        order: "desc",
        cursor: null,
      }),
    );
    expect(
      document.querySelector('nav[aria-label="Message history pagination, page 1"]'),
    ).not.toBeNull();
    expect(button("Newer messages").disabled).toBe(true);

    await act(async () => button("Older messages").click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Older customer text"),
    );
    expect(mocks.listMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        order: "desc",
        cursor: "cursor-older",
      }),
    );
    expect(document.body.textContent).not.toContain("Newest customer text");
    expect(button("Older messages").disabled).toBe(true);

    await act(async () => button("Newer messages").click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Newest customer text"),
    );
  });
});
