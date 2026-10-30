import { beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
const TENANT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const VERSION = "2026-08-24T10:00:00.123456789Z";
const NEXT_VERSION = "2026-08-24T10:01:00.1Z";

vi.mock("@/api/client", () => ({
  getClient: () => ({ client: { request }, tenantId: TENANT }),
}));

// Vitest hoists the transport mock; keep the resource import below its declaration.
// eslint-disable-next-line import/first
import {
  claimHelpdeskConversation,
  fetchHelpdeskConversation,
  helpdeskInternalNoteOutcomeIsAmbiguous,
  helpdeskVersionedMutationOutcomeIsAmbiguous,
  listHelpdeskConversations,
  listHelpdeskMessages,
  recordHelpdeskInternalNote,
  setHelpdeskConversationStatus,
} from "./serviceSuite";

function conversation(version = VERSION) {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    id: CONVERSATION_ID,
    version,
    channel_type: "web_chat",
    source_type: "web_chat",
    status: "open",
    priority: "normal",
    assignment_state: "unassigned",
    tags: [],
    updated_at: version,
  };
}

function note() {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    id: MESSAGE_ID,
    conversation_id: CONVERSATION_ID,
    source_type: "manual",
    direction: "internal",
    sender_type: "agent",
    body_text: "Private note",
    record_kind: "internal_note",
    delivery_status: "not_applicable",
    attachment_count: 0,
    projection_truncated: false,
    sent_at: "2026-08-24T10:00:00Z",
    created_at: "2026-08-24T10:00:00Z",
  };
}

beforeEach(() => {
  request.mockReset();
});

describe("Helpdesk transport", () => {
  it("uses a bounded newest-first message window with AbortSignal", async () => {
    request.mockResolvedValue({
      tenantId: TENANT,
      items: [],
      page: {
        has_more: false,
        next_cursor: null,
        as_of: "2026-08-24T10:02:00Z",
        consistency: "created_at_window",
        may_reorder: true,
      },
    });
    const signal = new AbortController().signal;
    await listHelpdeskMessages(CONVERSATION_ID, {
      order: "desc",
      cursor: "v1.opaque",
      limit: 25,
      signal,
    });
    expect(request).toHaveBeenCalledWith(
      "GET",
      `/api/v1/service-suite/conversations/${CONVERSATION_ID}/messages`,
      {
        query: { limit: 25, cursor: "v1.opaque", order: "desc" },
        signal,
      },
    );
  });

  it.each([
    "v1.a\tb",
    "v1.a\nb",
    "v1.a\rb",
    "v1.a\u0085b",
    "v1.a\u061cb",
    "v1.a\u200bb",
    "v1.a\u202eb",
    "v1.a\u2066b",
    "v1.a\ufeffb",
  ])(
    "rejects an unsafe outgoing cursor before transport (%j)",
    async (cursor) => {
      await expect(
        listHelpdeskMessages(CONVERSATION_ID, { cursor }),
      ).rejects.toThrow(/cursor/u);
      await expect(listHelpdeskConversations({ cursor })).rejects.toThrow(
        /cursor/u,
      );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("records only an explicit internal note with one retained key", async () => {
    request.mockImplementation(
      async (
        _method: string,
        _path: string,
        options: Record<string, unknown>,
      ) => {
        (options.onResponseHeaders as (headers: Headers) => void)(
          new Headers({ "Idempotency-Replayed": "true" }),
        );
        return note();
      },
    );
    const signal = new AbortController().signal;
    await expect(
      recordHelpdeskInternalNote(
        CONVERSATION_ID,
        "  Private note  ",
        "mobile-helpdesk-note-stable-key",
        { signal },
      ),
    ).resolves.toMatchObject({
      replayed: true,
      note: { recordKind: "internal_note" },
    });
    expect(request).toHaveBeenCalledWith(
      "POST",
      `/api/v1/service-suite/conversations/${CONVERSATION_ID}/internal-notes`,
      expect.objectContaining({
        body: { body_text: "Private note" },
        idempotencyKey: "mobile-helpdesk-note-stable-key",
        signal,
      }),
    );
    expect(JSON.stringify(request.mock.calls)).not.toContain('"direction"');
    expect(String(request.mock.calls[0]?.[1])).not.toMatch(/\/messages$/u);
  });

  it("accepts only the frozen idempotency replay header name", async () => {
    request.mockImplementation(
      async (
        _method: string,
        _path: string,
        options: Record<string, unknown>,
      ) => {
        (options.onResponseHeaders as (headers: Headers) => void)(
          new Headers({ "Idempotent-Replayed": "true" }),
        );
        return note();
      },
    );
    await expect(
      recordHelpdeskInternalNote(
        CONVERSATION_ID,
        "Private note",
        "mobile-helpdesk-note-old-header",
      ),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("requires the singular strong ETag to equal the row version", async () => {
    request.mockImplementation(
      async (
        _method: string,
        _path: string,
        options: Record<string, unknown>,
      ) => {
        (options.onResponseHeaders as (headers: Headers) => void)(
          new Headers({ ETag: `"${VERSION}"` }),
        );
        return conversation();
      },
    );
    await expect(fetchHelpdeskConversation(CONVERSATION_ID)).resolves.toEqual({
      conversation: expect.objectContaining({ version: VERSION }),
      etag: `"${VERSION}"`,
    });

    request.mockImplementationOnce(
      async (
        _method: string,
        _path: string,
        options: Record<string, unknown>,
      ) => {
        (options.onResponseHeaders as (headers: Headers) => void)(
          new Headers({ ETag: `W/"${VERSION}"` }),
        );
        return conversation();
      },
    );
    await expect(fetchHelpdeskConversation(CONVERSATION_ID)).rejects.toThrow(
      /strong resource validator/u,
    );
  });

  it("sends exact If-Match for status and derived assignment actions", async () => {
    request.mockImplementation(
      async (
        _method: string,
        _path: string,
        options: Record<string, unknown>,
      ) => {
        (options.onResponseHeaders as (headers: Headers) => void)(
          new Headers({ ETag: `"${NEXT_VERSION}"` }),
        );
        return conversation(NEXT_VERSION);
      },
    );
    await setHelpdeskConversationStatus(CONVERSATION_ID, "resolved", {
      ifMatch: `"${VERSION}"`,
      expectedVersion: VERSION,
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "POST",
      `/api/v1/service-suite/conversations/${CONVERSATION_ID}/status`,
      expect.objectContaining({
        body: { status: "resolved" },
        headers: { "If-Match": `"${VERSION}"` },
      }),
    );

    await claimHelpdeskConversation(CONVERSATION_ID, "assign_self", {
      ifMatch: `"${VERSION}"`,
      expectedVersion: VERSION,
      reason: " mobile_helpdesk_takeover ",
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST",
      `/api/v1/service-suite/conversations/${CONVERSATION_ID}/assign`,
      expect.objectContaining({
        body: {
          action: "assign_self",
          reason: "mobile_helpdesk_takeover",
        },
        headers: { "If-Match": `"${VERSION}"` },
      }),
    );
  });

  it("rejects invalid deep-link IDs before transport", async () => {
    await expect(
      fetchHelpdeskConversation("../../other-tenant"),
    ).rejects.toThrow(/canonical UUID/u);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects invalid status and idempotency inputs before transport", async () => {
    await expect(
      setHelpdeskConversationStatus(CONVERSATION_ID, "release-held", {
        ifMatch: `"${VERSION}"`,
        expectedVersion: VERSION,
      }),
    ).rejects.toThrow(/status is invalid/u);
    await expect(
      recordHelpdeskInternalNote(
        CONVERSATION_ID,
        "Private note",
        "mobile-note-\u202ehidden",
      ),
    ).rejects.toThrow(/idempotency key is invalid/u);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [400, "internal_note_invalid"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [412, "precondition_failed"],
    [428, "precondition_required"],
    [429, "rate_limited"],
    [409, "helpdesk_delivery_unavailable"],
    [409, "helpdesk_channel_create_held"],
    [409, "helpdesk_conversation_create_held"],
    [409, "helpdesk_create_replay_unavailable"],
    [409, "helpdesk_ticket_create_held"],
    [409, "helpdesk_view_create_held"],
    [409, "helpdesk_macro_create_held"],
    [409, "macro_usage_evidence_unavailable"],
    [409, "spam_assessment_write_held"],
    [409, "customer_agent_draft_write_held"],
  ])(
    "retires a durable note key after authoritative no-effect %i %s",
    (status, code) => {
      expect(
        helpdeskInternalNoteOutcomeIsAmbiguous(
          Object.assign(new Error("held"), { status, code }),
        ),
      ).toBe(false);
    },
  );

  it.each([
    [409, "idempotency_key_conflict"],
    [410, "internal_note_result_unavailable"],
    [403, "helpdesk_identity_retired"],
    [409, "unknown_conflict"],
    [500, "internal_error"],
    [503, "internal_note_idempotency_unavailable"],
    [0, "network_error"],
    [201, "response_parse_error"],
  ])("retains the original note key after ambiguous %i %s", (status, code) => {
    expect(
      helpdeskInternalNoteOutcomeIsAmbiguous(
        Object.assign(new Error("unknown"), { status, code }),
      ),
    ).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 412, 428, 429])(
    "treats versioned-mutation HTTP %i as an authoritative no-effect verdict",
    (status) => {
      expect(
        helpdeskVersionedMutationOutcomeIsAmbiguous(
          Object.assign(new Error("refused"), { status }),
        ),
      ).toBe(false);
    },
  );

  it.each([
    Object.assign(new Error("timeout"), { status: 0 }),
    Object.assign(new Error("server"), { status: 503 }),
    new Error("strict success response was malformed"),
  ])("treats versioned-mutation %s as commit-ambiguous", (error) => {
    expect(helpdeskVersionedMutationOutcomeIsAmbiguous(error)).toBe(true);
  });
});
