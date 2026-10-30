import { describe, expect, it } from "vitest";

import canonicalCatalogFixture from "../../../web/src/__tests__/fixtures/api/service-suite_catalog.json";

import {
  activeConversationCount,
  conversationSortKey,
  conversationSubtitle,
  conversationTitle,
  helpdeskAdminAccess,
  HelpdeskContractError,
  helpdeskStrongEntityTag,
  helpdeskUtf8Bytes,
  humanizeToken,
  mergeHelpdeskConversationPages,
  mergeHelpdeskMessagePages,
  normalizeHelpdeskInternalNoteBody,
  normalizeServiceCatalog,
  normalizeServiceConversation,
  normalizeServiceConversationPage,
  normalizeServiceInternalNote,
  normalizeServiceMessagePage,
  statusTone,
} from "./helpdesk";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const VERSION = "2026-08-24T10:00:00.123456789Z";

function conversation(over: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    tenantId: TENANT,
    tenant_id: TENANT,
    version: VERSION,
    channel_type: "web_chat",
    source_type: "web_chat",
    requester_name: "",
    requester_email: "ada@example.com",
    requester_phone: "",
    subject: "",
    status: "open",
    priority: "normal",
    assignment_state: "unassigned",
    tags: [],
    last_message_at: "2026-08-24T09:00:00Z",
    updated_at: VERSION,
    ...over,
  };
}

function pageInfo(
  consistency: "mutable_window" | "created_at_window",
  over: Record<string, unknown> = {},
) {
  return {
    has_more: false,
    next_cursor: null,
    as_of: "2026-08-24T10:01:00.1Z",
    consistency,
    may_reorder: true,
    ...over,
  };
}

function message(over: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    tenantId: TENANT,
    tenant_id: TENANT,
    conversation_id: CONVERSATION_ID,
    source_type: "manual",
    direction: "inbound",
    sender_type: "customer",
    body_text: "Hello",
    record_kind: "inbound_record",
    delivery_status: "received",
    body_omitted_reason: "",
    attachment_count: 0,
    projection_truncated: false,
    sent_at: "2026-08-24T09:30:00.123Z",
    created_at: "2026-08-24T09:30:00.123Z",
    ...over,
  };
}

function catalog() {
  return structuredClone(canonicalCatalogFixture);
}

describe("strict conversation contract", () => {
  it("requires singular camel/snake tenant equality and an exact version", () => {
    const row = normalizeServiceConversation(conversation(), TENANT);
    expect(row).toMatchObject({
      id: CONVERSATION_ID,
      tenantId: TENANT,
      version: VERSION,
      requesterName: null,
      requesterEmail: "ada@example.com",
      assignmentState: "unassigned",
      assignedToUserId: null,
    });
    expect(helpdeskStrongEntityTag(`"${VERSION}"`, row.version)).toBe(
      `"${VERSION}"`,
    );
    expect(() =>
      helpdeskStrongEntityTag(`W/"${VERSION}"`, row.version),
    ).toThrow(HelpdeskContractError);
    expect(() =>
      normalizeServiceConversation(
        conversation({ tenant_id: OTHER_TENANT }),
        TENANT,
      ),
    ).toThrow(/tenant boundary/u);
    expect(() =>
      normalizeServiceConversation(
        conversation({ metadata: { raw_customer_record: true } }),
        TENANT,
      ),
    ).toThrow(/unsupported fields/u);
  });

  it("requires a tenant-bound mutable page with deterministic order", () => {
    const newerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const parsed = normalizeServiceConversationPage(
      {
        tenantId: TENANT,
        items: [
          conversation({
            id: newerId,
            last_message_at: "2026-08-24T09:01:00Z",
          }),
          conversation(),
        ],
        page: pageInfo("mutable_window"),
      },
      TENANT,
    );
    expect(parsed.items.map((row) => row.id)).toEqual([
      newerId,
      CONVERSATION_ID,
    ]);
    expect(parsed.page).toMatchObject({
      consistency: "mutable_window",
      mayReorder: true,
    });
    expect(conversationSortKey(parsed.items[0]!)).toBe("2026-08-24T09:01:00Z");
  });

  it("orders mixed RFC3339Nano fractions chronologically", () => {
    const newerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const parsed = normalizeServiceConversationPage(
      {
        tenantId: TENANT,
        items: [
          conversation({
            id: newerId,
            last_message_at: "2026-08-24T09:00:00.1Z",
          }),
          conversation({ last_message_at: "2026-08-24T09:00:00Z" }),
        ],
        page: pageInfo("mutable_window"),
      },
      TENANT,
    );
    expect(parsed.items.map((row) => row.id)).toEqual([
      newerId,
      CONVERSATION_ID,
    ]);
  });

  it("rejects safe but unknown dashed conversation tokens", () => {
    expect(() =>
      normalizeServiceConversation(
        { ...conversation({ source_type: "help-scout" }) },
        TENANT,
      ),
    ).toThrow(/unsupported/u);
  });

  it.each([
    ["tenantId", { tenantId: ` ${TENANT}` }],
    ["tenant_id", { tenant_id: `${TENANT} ` }],
    ["conversation.id", { id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }],
  ])("rejects non-canonical wire UUID in %s", (_label, poison) => {
    expect(() =>
      normalizeServiceConversation({ ...conversation(), ...poison }, TENANT),
    ).toThrow(/invalid/u);
  });

  it("enforces byte bounds and the server projection time window", () => {
    expect(() =>
      normalizeServiceConversation(
        { ...conversation({ requester_name: "é".repeat(101) }) },
        TENANT,
      ),
    ).toThrow(/too long/u);
    expect(() =>
      normalizeServiceConversation(
        { ...conversation({ requester_phone: "é".repeat(33) }) },
        TENANT,
      ),
    ).toThrow(/too long/u);
    expect(() =>
      normalizeServiceConversation(
        { ...conversation({ updated_at: "1999-12-31T23:59:59Z" }) },
        TENANT,
      ),
    ).toThrow(/invalid/u);
    expect(() =>
      normalizeServiceConversation(
        {
          ...conversation({
            version: "2026-02-30T00:00:00Z",
            updated_at: "2026-02-30T00:00:00Z",
          }),
        },
        TENANT,
      ),
    ).toThrow(/invalid/u);
  });

  it("rejects malformed cursors, false immutability, and mixed page windows", () => {
    expect(() =>
      normalizeServiceConversationPage(
        {
          tenantId: TENANT,
          items: [conversation()],
          page: pageInfo("mutable_window", {
            has_more: true,
            next_cursor: null,
          }),
        },
        TENANT,
      ),
    ).toThrow(/cursor/u);
    expect(() =>
      normalizeServiceConversationPage(
        {
          tenantId: TENANT,
          items: [conversation()],
          page: pageInfo("mutable_window", { may_reorder: false }),
        },
        TENANT,
      ),
    ).toThrow(/consistency/u);

    const first = normalizeServiceConversationPage(
      {
        tenantId: TENANT,
        items: [conversation()],
        page: pageInfo("mutable_window", {
          has_more: true,
          next_cursor: "v1.opaque",
        }),
      },
      TENANT,
    );
    const second = normalizeServiceConversationPage(
      {
        tenantId: TENANT,
        items: [],
        page: pageInfo("mutable_window", {
          as_of: "2026-08-24T10:02:00Z",
        }),
      },
      TENANT,
    );
    expect(() => mergeHelpdeskConversationPages([first, second])).toThrow(
      /different windows/u,
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
    "rejects an unsafe opaque next cursor without changing display text (%j)",
    (cursor) => {
      expect(() =>
        normalizeServiceConversationPage(
          {
            tenantId: TENANT,
            items: [conversation()],
            page: pageInfo("mutable_window", {
              has_more: true,
              next_cursor: cursor,
            }),
          },
          TENANT,
        ),
      ).toThrow(/cursor/u);
    },
  );
});

describe("safe customer display", () => {
  it("preserves ordinary RTL evidence without trimming or rewriting it", () => {
    const name = "  مرحبًا من العميل  ";
    const row = normalizeServiceConversation(
      conversation({ requester_name: name }),
      TENANT,
    );
    expect(row.requesterName).toBe(name);
  });

  it.each(["Ada\u202eexe.pdf", "Ada\u2066hidden", "Ada\u200bLovelace"])(
    "rejects hidden bidi/control content instead of silently rewriting %s",
    (hostile) => {
      expect(() =>
        normalizeServiceConversation(
          conversation({ requester_name: hostile }),
          TENANT,
        ),
      ).toThrow(/control characters/u);
    },
  );
});

describe("strict message facts", () => {
  it("keeps received, unverified, and non-delivery records distinct", () => {
    const page = normalizeServiceMessagePage(
      {
        tenantId: TENANT,
        items: [
          message({
            id: "55555555-5555-4555-8555-555555555555",
            direction: "internal",
            sender_type: "agent",
            record_kind: "internal_note",
            delivery_status: "not_applicable",
            sent_at: "2026-08-24T09:32:00Z",
          }),
          message({
            id: "66666666-6666-4666-8666-666666666666",
            direction: "outbound",
            sender_type: "agent",
            record_kind: "outbound_record",
            delivery_status: "unverified",
            sent_at: "2026-08-24T09:31:00Z",
          }),
          message(),
        ],
        page: pageInfo("created_at_window"),
      },
      TENANT,
      CONVERSATION_ID,
      "desc",
    );
    expect(page.items.map((row) => row.deliveryStatus)).toEqual([
      "not_applicable",
      "unverified",
      "received",
    ]);
    expect(
      mergeHelpdeskMessagePages([page]).map((row) => row.direction),
    ).toEqual(["inbound", "outbound", "internal"]);
  });

  it("orders mixed message fractions chronologically", () => {
    const olderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const page = normalizeServiceMessagePage(
      {
        tenantId: TENANT,
        items: [
          message({ sent_at: "2026-08-24T09:30:00.1Z" }),
          message({
            id: olderId,
            sent_at: "2026-08-24T09:30:00Z",
          }),
        ],
        page: pageInfo("created_at_window"),
      },
      TENANT,
      CONVERSATION_ID,
    );
    expect(page.items.map((row) => row.id)).toEqual([MESSAGE_ID, olderId]);
  });

  it("accepts a bounded historical dashed message source token", () => {
    const page = normalizeServiceMessagePage(
      {
        tenantId: TENANT,
        items: [message({ source_type: "help-scout" })],
        page: pageInfo("created_at_window"),
      },
      TENANT,
      CONVERSATION_ID,
    );
    expect(page.items[0]?.sourceType).toBe("help-scout");
  });

  it("rejects non-canonical message tenant and conversation UUIDs", () => {
    for (const poison of [
      message({ tenantId: `${TENANT} ` }),
      message({ tenant_id: ` ${TENANT}` }),
      message({ conversation_id: `${CONVERSATION_ID} ` }),
    ]) {
      expect(() =>
        normalizeServiceMessagePage(
          {
            tenantId: TENANT,
            items: [poison],
            page: pageInfo("created_at_window"),
          },
          TENANT,
          CONVERSATION_ID,
        ),
      ).toThrow(HelpdeskContractError);
    }
  });

  it("requires body omission and projection facts instead of inferring them", () => {
    const omitted = normalizeServiceMessagePage(
      {
        tenantId: TENANT,
        items: [
          message({
            body_text: "",
            body_omitted_reason: "html_only",
            projection_truncated: true,
          }),
        ],
        page: pageInfo("created_at_window"),
      },
      TENANT,
      CONVERSATION_ID,
    ).items[0];
    expect(omitted).toMatchObject({
      body: null,
      bodyOmittedReason: "html_only",
      projectionTruncated: true,
    });
    expect(() =>
      normalizeServiceMessagePage(
        {
          tenantId: TENANT,
          items: [message({ body_text: "", body_omitted_reason: "" })],
          page: pageInfo("created_at_window"),
        },
        TENANT,
        CONVERSATION_ID,
      ),
    ).toThrow(/omission reason/u);
  });

  it("rejects cross-conversation rows, delivery inference, and hostile controls", () => {
    for (const hostile of [
      message({ conversation_id: "77777777-7777-4777-8777-777777777777" }),
      message({ delivery_status: "delivered" }),
      message({ body_text: "invoice\u202epdf" }),
      message({ body_text: "é".repeat(8_193) }),
      message({ body_html: "<b>raw</b>" }),
      message({ attachments: [{ url: "https://private.example/evidence" }] }),
      message({ metadata: { provider_payload: "raw" } }),
      message({
        body_text: "",
        body_omitted_reason: "legacy-unsafe",
      }),
    ]) {
      expect(() =>
        normalizeServiceMessagePage(
          {
            tenantId: TENANT,
            items: [hostile],
            page: pageInfo("created_at_window"),
          },
          TENANT,
          CONVERSATION_ID,
        ),
      ).toThrow(HelpdeskContractError);
    }
    expect(() =>
      normalizeServiceMessagePage(
        {
          tenantId: TENANT,
          items: [message()],
          page: pageInfo("created_at_window"),
          live: true,
        },
        TENANT,
        CONVERSATION_ID,
      ),
    ).toThrow(/unsupported fields/u);
  });

  it("accepts only an explicitly internal, tenant-bound note receipt", () => {
    const note = normalizeServiceInternalNote(
      message({
        direction: "internal",
        sender_type: "agent",
        record_kind: "internal_note",
        delivery_status: "not_applicable",
      }),
      TENANT,
      CONVERSATION_ID,
    );
    expect(note.recordKind).toBe("internal_note");
  });
});

describe("catalog, copy helpers, and local note bounds", () => {
  it("pins static provenance, holds, and the no-provider guardrail", () => {
    const parsed = normalizeServiceCatalog(catalog());
    expect(parsed.provenance.tenantBound).toBe(false);
    expect(parsed.capabilities.outboundReplyDelivery).toEqual({
      status: "held",
      code: "helpdesk_delivery_unavailable",
      executionMode: null,
    });
    expect(parsed.capabilities.macroUsageEvidence.status).toBe("held");
    expect(parsed.capabilities.customerAgent).toEqual({
      status: "held",
      code: "customer_agent_draft_write_held",
      executionMode: "deterministic_template_only",
    });
    expect(parsed.capabilities.spamAssessmentWrite.status).toBe("held");
    expect(parsed.capabilities.resourceCreation.status).toBe("held");
    expect(parsed.guardrail.providerExecuted).toBe(false);
    expect(() =>
      normalizeServiceCatalog({
        ...catalog(),
        guardrail: { ...catalog().guardrail, provider_executed: true },
      }),
    ).toThrow(/guardrail/u);
  });

  it("accepts the entire canonical catalog and rejects misplaced or additive capability fields", () => {
    expect(() => normalizeServiceCatalog(catalog())).not.toThrow();

    const swapped = catalog();
    swapped.capabilities.resource_creation = {
      status: "held",
      code: "held",
      execution_mode: "helpdesk_create_replay_unavailable",
    } as never;
    expect(() => normalizeServiceCatalog(swapped)).toThrow(
      /resource_creation/u,
    );

    const extraExecutionMode = catalog();
    extraExecutionMode.capabilities.resource_creation = {
      ...extraExecutionMode.capabilities.resource_creation,
      execution_mode: "deterministic_template_only",
    } as never;
    expect(() => normalizeServiceCatalog(extraExecutionMode)).toThrow(
      /resource_creation/u,
    );

    const extraCapability = catalog() as ReturnType<typeof catalog> & {
      capabilities: Record<string, unknown>;
    };
    extraCapability.capabilities["provider_delivery"] = { status: "held" };
    expect(() => normalizeServiceCatalog(extraCapability)).toThrow(
      /capabilities/u,
    );
  });

  it("validates frozen channel and agent-run arrays without exposing action surfaces", () => {
    const changedChannel = catalog();
    changedChannel.channels[0]!.runtime_status = "available";
    expect(() => normalizeServiceCatalog(changedChannel)).toThrow(
      /catalog channels/u,
    );

    const changedRuns = catalog();
    changedRuns.agent_run_types.push("provider_execute");
    expect(() => normalizeServiceCatalog(changedRuns)).toThrow(
      /agent run types/u,
    );
  });

  it("names rows honestly and counts only loaded active records", () => {
    const base = normalizeServiceConversation(conversation(), TENANT);
    expect(conversationTitle(base)).toBe("ada@example.com");
    expect(conversationSubtitle(base)).toBe("Web chat conversation");
    expect(conversationTitle({ ...base, requesterEmail: null })).toBe(
      "Unidentified sender",
    );
    expect(humanizeToken("web_chat")).toBe("Web chat");
    expect(
      activeConversationCount([base, { ...base, status: "resolved" }]),
    ).toBe(1);
    expect(statusTone("spam")).toBe("danger");
  });

  it("makes Helpdesk exact-admin/session/online and never queues notes", () => {
    expect(
      helpdeskAdminAccess({ role: "admin", mode: "session", online: true }),
    ).toEqual({ allowed: true, notice: null });
    expect(
      helpdeskAdminAccess({ role: "editor", mode: "session", online: true })
        .notice,
    ).toContain("owners and admins");
    expect(
      helpdeskAdminAccess({ role: "admin", mode: "api_key", online: true })
        .notice,
    ).toContain("API-key scopes");
    expect(
      helpdeskAdminAccess({ role: "admin", mode: "session", online: false })
        .notice,
    ).toContain("never queued");
  });

  it("matches the server's trim and 16 KiB UTF-8 body boundary", () => {
    expect(normalizeHelpdeskInternalNoteBody("  private note  ")).toBe(
      "private note",
    );
    expect(helpdeskUtf8Bytes("🙂")).toBe(4);
    expect(() => normalizeHelpdeskInternalNoteBody("🙂".repeat(4_097))).toThrow(
      /16 KiB/u,
    );
    expect(() => normalizeHelpdeskInternalNoteBody("note\u202ehidden")).toThrow(
      /16 KiB/u,
    );
  });

  it("requires the derived UUID assignment fields to agree", () => {
    expect(
      normalizeServiceConversation(
        conversation({
          assignment_state: "tenant_active_user",
          assigned_to: USER_ID,
          assigned_to_user_id: USER_ID,
        }),
        TENANT,
      ).assignedToUserId,
    ).toBe(USER_ID);
  });

  it("keeps legacy assignment truth without accepting legacy text as identity", () => {
    const parsed = normalizeServiceConversation(
      conversation({ assignment_state: "legacy_unverified" }),
      TENANT,
    );
    expect(parsed).toMatchObject({
      assignmentState: "legacy_unverified",
      assignedToUserId: null,
    });
    expect(() =>
      normalizeServiceConversation(
        conversation({
          assignment_state: "legacy_unverified",
          assigned_to: "legacy@example.com",
        }),
        TENANT,
      ),
    ).toThrow(/must omit assignment identifiers/u);
  });
});
