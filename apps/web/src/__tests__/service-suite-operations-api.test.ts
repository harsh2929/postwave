// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  ServiceSuiteOperationsContractError,
  archiveHelpdeskMacro,
  assignHelpdeskConversation,
  createHelpdeskInternalNote,
  getHelpdeskConversation,
  internalNoteValidationError,
  listHelpdeskConversations,
  listHelpdeskMessages,
  listHelpdeskTickets,
  patchHelpdeskMacro,
  patchHelpdeskTicket,
  setHelpdeskConversationStatus,
} from "@/lib/service-suite-operations-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const MESSAGE = "33333333-3333-4333-8333-333333333333";
const TICKET = "44444444-4444-4444-8444-444444444444";
const MACRO = "55555555-5555-4555-8555-555555555555";
const V1 = "2026-08-29T10:00:00.1Z";
const V2 = "2026-08-29T10:00:00.2Z";

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    id: CONVERSATION,
    version: V1,
    channel_type: "email",
    source_type: "inbound_email",
    requester_name: "Ada Customer",
    subject: "Refund question",
    status: "open",
    priority: "high",
    assignment_state: "unassigned",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: V1,
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    id: MESSAGE,
    conversation_id: CONVERSATION,
    source_type: "inbound_email",
    direction: "inbound",
    sender_type: "customer",
    sender: "customer@example.test",
    body_text: "Please help",
    record_kind: "inbound_record",
    delivery_status: "received",
    attachment_count: 0,
    projection_truncated: false,
    sent_at: "2026-08-29T09:30:00Z",
    created_at: "2026-08-29T09:30:01Z",
    ...overrides,
  };
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    id: TICKET,
    version: V1,
    conversation_id: CONVERSATION,
    ticket_number: 42,
    title: "Refund review",
    status: "open",
    priority: "normal",
    assignment_state: "unassigned",
    source_channel: "email",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: V1,
    ...overrides,
  };
}

function macro(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    id: MACRO,
    version: V2,
    name: "Refund acknowledgement",
    body: "We are reviewing your request.",
    channel_types: ["email"],
    tags: ["refund"],
    status: "active",
    use_count: 3,
    usage_evidence_status: "unverified",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: V2,
    ...overrides,
  };
}

function page(items: unknown[], consistency = "mutable_window") {
  return {
    tenantId: TENANT,
    items,
    page: {
      has_more: false,
      next_cursor: null,
      as_of: "2026-08-29T10:01:00Z",
      consistency,
      may_reorder: true,
    },
  };
}

function respond(
  options: { onResponse?: (response: Response) => void },
  status: number,
  headers: Record<string, string> = {},
) {
  options.onResponse?.(new Response(null, { status, headers }));
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("service-suite Helpdesk operational client", () => {
  it("rejects slash-bearing record ids before they can alter a route boundary", async () => {
    await expect(
      getHelpdeskConversation({
        tenantId: TENANT,
        conversationId: `${CONVERSATION}/messages`,
      }),
    ).rejects.toThrow(/canonical UUID/u);
    await expect(
      patchHelpdeskTicket({
        tenantId: TENANT,
        ticketId: `${TICKET}/resolve`,
        version: V1,
        patch: { status: "resolved" },
      }),
    ).rejects.toThrow(/canonical UUID/u);
    await expect(
      patchHelpdeskMacro({
        tenantId: TENANT,
        macroId: `${MACRO}/use`,
        version: V1,
        patch: { status: "archived" },
      }),
    ).rejects.toThrow(/canonical UUID/u);

    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("accepts only exact tenant-bound conversation pages and opaque cursor receipts", async () => {
    mocks.get.mockResolvedValue(page([conversation()]));
    await expect(
      listHelpdeskConversations({ tenantId: TENANT, status: "open", limit: 25 }),
    ).resolves.toMatchObject({
      tenantId: TENANT,
      items: [{ id: CONVERSATION, requesterName: "Ada Customer" }],
      page: { hasMore: false, nextCursor: null, mayReorder: true },
    });
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/service-suite/conversations",
      expect.objectContaining({
        query: { limit: 25, status: "open" },
      }),
    );

    mocks.get.mockResolvedValueOnce(page([conversation({ tenant_id: OTHER_TENANT })]));
    await expect(
      listHelpdeskConversations({ tenantId: TENANT }),
    ).rejects.toThrow(/tenant boundary/u);

    mocks.get.mockResolvedValueOnce({
      ...page([conversation()]),
      page: {
        ...page([]).page,
        has_more: true,
        next_cursor: "cursor\u202espoof",
      },
    });
    await expect(
      listHelpdeskConversations({ tenantId: TENANT }),
    ).rejects.toThrow(/cursor/u);
  });

  it("withholds an entire message page on unsafe text, cross-conversation rows, or false delivery truth", async () => {
    mocks.get.mockResolvedValue(page([message()], "created_at_window"));
    await expect(
      listHelpdeskMessages({ tenantId: TENANT, conversationId: CONVERSATION }),
    ).resolves.toMatchObject({ items: [{ bodyText: "Please help" }] });

    for (const unsafe of [
      message({ body_text: "safe\u202eunsafe" }),
      message({ conversation_id: OTHER_TENANT }),
      message({ delivery_status: "unverified" }),
    ]) {
      mocks.get.mockResolvedValueOnce(page([unsafe], "created_at_window"));
      await expect(
        listHelpdeskMessages({ tenantId: TENANT, conversationId: CONVERSATION }),
      ).rejects.toBeInstanceOf(ServiceSuiteOperationsContractError);
    }
  });

  it("sends assignment and status writes online once with exact strong If-Match receipts", async () => {
    mocks.post.mockImplementationOnce(
      async (_path: string, _body: unknown, options: { onResponse?: (response: Response) => void }) => {
        respond(options, 200, { etag: `"${V2}"` });
        return conversation({
          version: V2,
          updated_at: V2,
          assigned_to: "66666666-6666-4666-8666-666666666666",
          assigned_to_user_id: "66666666-6666-4666-8666-666666666666",
          assignment_state: "tenant_active_user",
        });
      },
    );
    await assignHelpdeskConversation({
      tenantId: TENANT,
      conversationId: CONVERSATION,
      version: V1,
      action: "assign_self",
      reason: "Owner review",
    });
    expect(mocks.post).toHaveBeenLastCalledWith(
      `/api/v1/service-suite/conversations/${CONVERSATION}/assign`,
      { action: "assign_self", reason: "Owner review" },
      expect.objectContaining({
        headers: { "If-Match": `"${V1}"` },
        requireOnline: true,
        maxAttempts: 1,
      }),
    );

    mocks.post.mockImplementationOnce(
      async (_path: string, _body: unknown, options: { onResponse?: (response: Response) => void }) => {
        respond(options, 200, { etag: `"${V2}"` });
        return conversation({ version: V2, updated_at: V2, status: "pending" });
      },
    );
    await setHelpdeskConversationStatus({
      tenantId: TENANT,
      conversationId: CONVERSATION,
      version: V1,
      status: "pending",
    });
    expect(mocks.post).toHaveBeenLastCalledWith(
      `/api/v1/service-suite/conversations/${CONVERSATION}/status`,
      { status: "pending" },
      expect.objectContaining({ headers: { "If-Match": `"${V1}"` } }),
    );
  });

  it("records only private internal notes and validates new and replay receipts", async () => {
    const key = "helpdesk-note-77777777-7777-4777-8777-777777777777";
    const note = message({
      direction: "internal",
      sender_type: "agent",
      body_text: "Private review",
      record_kind: "internal_note",
      delivery_status: "not_applicable",
      source_type: "manual",
    });
    mocks.post.mockImplementationOnce(
      async (_path: string, _body: unknown, options: { onResponse?: (response: Response) => void }) => {
        respond(options, 201);
        return note;
      },
    );
    await expect(
      createHelpdeskInternalNote({
        tenantId: TENANT,
        conversationId: CONVERSATION,
        bodyText: " Private review ",
        idempotencyKey: key,
      }),
    ).resolves.toMatchObject({ created: true, replayed: false, idempotencyKey: key });
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/service-suite/conversations/${CONVERSATION}/internal-notes`,
      { body_text: "Private review" },
      expect.objectContaining({
        idempotencyKey: key,
        requireOnline: true,
        maxAttempts: 1,
      }),
    );

    mocks.post.mockImplementationOnce(
      async (_path: string, _body: unknown, options: { onResponse?: (response: Response) => void }) => {
        respond(options, 200, { "idempotency-replayed": "true" });
        return note;
      },
    );
    await expect(
      createHelpdeskInternalNote({
        tenantId: TENANT,
        conversationId: CONVERSATION,
        bodyText: "Private review",
        idempotencyKey: key,
      }),
    ).resolves.toMatchObject({ created: false, replayed: true });
    expect(internalNoteValidationError("unsafe\u202etext")).toMatch(/unsafe/u);
    expect(internalNoteValidationError("💥".repeat(5000))).toMatch(/16 KiB/u);
  });

  it("binds ticket filters and versioned patches to supported record fields", async () => {
    mocks.get.mockResolvedValue(page([ticket()]));
    await listHelpdeskTickets({
      tenantId: TENANT,
      conversationId: CONVERSATION,
      status: "open",
    });
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/service-suite/tickets",
      expect.objectContaining({
        query: expect.objectContaining({
          conversation_id: CONVERSATION,
          status: "open",
        }),
      }),
    );

    mocks.patch.mockImplementationOnce(
      async (_path: string, _body: unknown, options: { onResponse?: (response: Response) => void }) => {
        respond(options, 200, { etag: `"${V2}"` });
        return ticket({ version: V2, updated_at: V2, status: "resolved" });
      },
    );
    await patchHelpdeskTicket({
      tenantId: TENANT,
      ticketId: TICKET,
      version: V1,
      patch: { status: "resolved", priority: "high" },
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/service-suite/tickets/${TICKET}`,
      { status: "resolved", priority: "high" },
      expect.objectContaining({
        headers: { "If-Match": `"${V1}"` },
        requireOnline: true,
        maxAttempts: 1,
      }),
    );
  });

  it("updates and archives macros without calling held create/use routes", async () => {
    mocks.patch.mockImplementationOnce(
      async (_path: string, _body: unknown, options: { onResponse?: (response: Response) => void }) => {
        respond(options, 200, { etag: `"${V2}"` });
        return macro();
      },
    );
    await patchHelpdeskMacro({
      tenantId: TENANT,
      macroId: MACRO,
      version: V1,
      patch: { name: "Refund acknowledgement", channelTypes: ["email"] },
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/service-suite/macros/${MACRO}`,
      { name: "Refund acknowledgement", channel_types: ["email"] },
      expect.objectContaining({ headers: { "If-Match": `"${V1}"` } }),
    );

    mocks.delete.mockImplementationOnce(
      async (_path: string, options: { onResponse?: (response: Response) => void }) => {
        respond(options, 204, { etag: `"${V2}"` });
      },
    );
    await expect(
      archiveHelpdeskMacro({ tenantId: TENANT, macroId: MACRO, version: V1 }),
    ).resolves.toEqual({
      id: MACRO,
      previousVersion: V1,
      version: V2,
      archived: true,
    });
    expect(mocks.delete).toHaveBeenCalledWith(
      `/api/v1/service-suite/macros/${MACRO}`,
      expect.objectContaining({
        headers: { "If-Match": `"${V1}"` },
        requireOnline: true,
        maxAttempts: 1,
      }),
    );
  });

  it("contains no client function for release-held reply, create, or macro-use mutations", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/service-suite-operations-api.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /api\.post<unknown>\(\s*`\/api\/v1\/service-suite\/conversations\/\$\{id\}\/messages`/u,
    );
    expect(source).not.toMatch(/\/macros\/\$\{id\}\/use/u);
    expect(source).not.toMatch(/api\.post<unknown>\(\s*"\/api\/v1\/service-suite\/(?:conversations|tickets|macros)"/u);
    expect(source).not.toContain("createHelpdeskReply");
  });
});
