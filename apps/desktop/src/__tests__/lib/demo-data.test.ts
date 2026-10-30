import { describe, expect, it } from "vitest";

import {
  decodeHubConfig,
  decodeMacroList,
  decodeServiceSuiteCatalog,
} from "../../components/helpdesk/agent-helpers";
import {
  decodeConversation,
  decodeConversationList,
  decodeMessageList,
  decodeTicketList,
} from "../../components/helpdesk/helpdesk-helpers";
import { demoDataForRequest, responseNeedsDemoData } from "../../lib/demo-data";
import type { ApiResult } from "../../lib/api/result";
import {
  createSmsInboxOperationsMethods,
  type SmsInboxRequester,
} from "../../lib/api/sms-inbox-operations";

describe("local demo data fallback", () => {
  it("fills empty collection responses but preserves real populated data", () => {
    expect(responseNeedsDemoData({ items: [], total: 0 })).toBe(true);
    expect(responseNeedsDemoData({ items: [{ id: "real" }], total: 1 })).toBe(
      false,
    );
    expect(responseNeedsDemoData({ enabled: false })).toBe(false);
  });

  it("provides human-readable tag records for the catalogue", () => {
    const response = demoDataForRequest("/api/v1/tags") as {
      items: Array<{ name: string; etag: string }>;
    };
    expect(response.items).toHaveLength(3);
    expect(response.items[0]).toMatchObject({
      name: "Product launch",
      etag: '"tag:00000000-0000-4000-8000-000000000001:v1"',
    });
  });

  it("normalizes the local tag taxonomy's duplicate compatibility alias", () => {
    const response = demoDataForRequest("/api/v1/tag-taxonomy", {
      count: 1,
      items: [{ tag: "sample", subscribers: 50, registered: true }],
      tags: [{ tag: "sample", subscribers: 50, registered: true }],
    }) as { items: unknown[]; tags?: unknown[] };
    expect(response.items).toHaveLength(1);
    expect(response.tags).toBeUndefined();
  });

  it("provides a contract-valid privacy incident register", () => {
    const response = demoDataForRequest("/api/v1/privacy/incidents") as {
      incidents: Array<{ summary: string }>;
      known_jurisdictions: unknown[];
    };
    expect(response.incidents).toHaveLength(3);
    expect(response.incidents[0]?.summary).toContain("Export link");
    expect(response.known_jurisdictions).toHaveLength(2);
  });

  it("paginates the complete template catalogue", () => {
    const response = demoDataForRequest(
      "/api/v1/campaign-templates/search?page=2&per_page=48",
    ) as { items: unknown[]; page: number; per_page: number; total: number };
    expect(response).toMatchObject({ page: 2, per_page: 48, total: 2_048 });
    expect(response.items).toHaveLength(48);
  });

  it("keeps the complete demo catalogue when the local API has a smaller seed", () => {
    const response = demoDataForRequest(
      "/api/v1/campaign-templates/search?page=1&per_page=100",
      {
        items: [{ id: "real-template" }],
        page: 1,
        per_page: 100,
        total: 29,
      },
    ) as { items: unknown[]; page: number; per_page: number; total: number };
    expect(response).toMatchObject({ page: 1, per_page: 100, total: 2_048 });
    expect(response.items).toHaveLength(100);
  });

  it("never fabricates identity, health, or onboarding state", () => {
    expect(demoDataForRequest("/api/health")).toBeUndefined();
    expect(demoDataForRequest("/api/v1/me")).toBeUndefined();
    expect(demoDataForRequest("/api/v1/auth/me")).toBeUndefined();
    expect(
      demoDataForRequest("/api/v1/onboarding/sample-data"),
    ).toBeUndefined();
  });

  it("retains bare-array contracts used by legacy integrations", () => {
    const response = demoDataForRequest("/api/v1/affiliates");
    expect(Array.isArray(response)).toBe(true);
    expect(response).toHaveLength(3);
  });

  it("emits a strict tenant-bound SMS inbox page for demo mode", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000099";
    const payload = demoDataForRequest("/api/v1/sms/conversations");
    const request: SmsInboxRequester = async <T>() =>
      ({ data: payload as T }) as ApiResult<T>;
    const operations = createSmsInboxOperationsMethods({
      request,
      getTenantId: () => tenantId,
      getApiUrl: () => "https://api.example.invalid",
    });

    await expect(operations.listSMSConversations()).resolves.toEqual({
      data: payload,
    });
    expect(payload).toMatchObject({
      tenantId,
      snapshotAt: "2026-08-18T10:30:00.000Z",
      unreadTotal: 2,
      unknownTotal: 1,
      totalConversations: 3,
      activeTotal: 3,
      snoozedTotal: 0,
      archivedTotal: 0,
    });
    const conversations = (
      payload as {
        conversations: Array<{
          unreadCount: number;
          oldestUnreadAt?: string;
          identityAmbiguous: boolean;
        }>;
      }
    ).conversations;
    expect(
      conversations.every(
        (row) =>
          row.identityAmbiguous === false &&
          row.unreadCount > 0 === (row.oldestUnreadAt !== undefined),
      ),
    ).toBe(true);
  });

  it("emits a strict tenant-bound SMS suppression page for demo mode", () => {
    const tenantId = "00000000-0000-4000-8000-000000000099";
    const payload = demoDataForRequest("/api/v1/sms/suppressions") as {
      tenantId: string;
      items: Array<{
        id: string;
        reason: string;
        source: string;
        reversible: boolean;
        locked_reason?: string;
      }>;
      snapshotAt: string;
      total: number;
    };

    expect(payload).toMatchObject({
      tenantId,
      snapshotAt: "2026-08-18T10:30:00.000Z",
      total: 3,
    });
    expect(payload.items).toHaveLength(3);
    expect(payload.items[0]).toMatchObject({
      reason: "manual",
      source: "manual",
      reversible: true,
    });
    expect(payload.items[0]).not.toHaveProperty("locked_reason");
    expect(payload.items.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reversible: false,
          locked_reason: "carrier_or_system_authority",
        }),
      ]),
    );
  });

  it("uses strict, synthetic, read-only Helpdesk fixtures without inventing runtime", () => {
    const tenantId = "00000000-0000-4000-8000-000000000099";
    const conversationId = "00000000-0000-4000-8000-000000000101";
    const catalog = demoDataForRequest("/api/v1/service-suite/catalog");
    const decodedCatalog = decodeServiceSuiteCatalog(catalog);
    expect(decodedCatalog.error).toBeNull();
    expect(decodedCatalog.value?.capabilities).toMatchObject({
      outbound_reply_delivery: { status: "held" },
      privacy_lifecycle: { status: "held" },
      customer_hub_runtime: { status: "held" },
      channel_runtime: { status: "held" },
      customer_agent: {
        status: "held",
        code: "customer_agent_draft_write_held",
        execution_mode: "deterministic_template_only",
      },
      spam_assessment_write: { status: "held" },
      resource_creation: { status: "held" },
    });

    const config = demoDataForRequest("/api/v1/service-suite/config");
    expect(decodeHubConfig(config, tenantId)).toMatchObject({
      error: null,
      value: {
        version: "absent",
        status: "draft",
        runtime_available: false,
        runtime_status: "held",
        customer_agent_enabled: false,
        customer_agent_effective_enabled: false,
      },
    });

    const conversations = demoDataForRequest(
      "/api/v1/service-suite/conversations?status=open",
    );
    expect(decodeConversationList(conversations, tenantId)).toMatchObject({
      rejected: 0,
      envelopeError: null,
      items: [{ id: conversationId, assignment_state: "unassigned" }],
    });
    const conversation = demoDataForRequest(
      `/api/v1/service-suite/conversations/${conversationId}`,
    );
    expect(decodeConversation(conversation, tenantId)).toMatchObject({
      id: conversationId,
      tenantId,
    });

    const messages = demoDataForRequest(
      `/api/v1/service-suite/conversations/${conversationId}/messages?order=desc`,
    );
    const decodedMessages = decodeMessageList(
      messages,
      tenantId,
      conversationId,
    );
    expect(decodedMessages).toMatchObject({
      rejected: 0,
      envelopeError: null,
    });
    expect(
      decodedMessages.items.map((message) => [
        message.record_kind,
        message.delivery_status,
      ]),
    ).toEqual([
      ["internal_note", "not_applicable"],
      ["inbound_record", "received"],
    ]);
    expect(
      decodedMessages.items.some(
        (message) => message.delivery_status === "delivered",
      ),
    ).toBe(false);

    const tickets = demoDataForRequest(
      `/api/v1/service-suite/tickets?conversation_id=${conversationId}`,
    );
    expect(decodeTicketList(tickets, tenantId)).toMatchObject({
      rejected: 0,
      envelopeError: null,
      items: [{ conversation_id: conversationId }],
    });
    const macros = demoDataForRequest("/api/v1/service-suite/macros");
    expect(decodeMacroList(macros, tenantId)).toMatchObject({
      rejected: 0,
      envelopeError: null,
      items: [{ usage_evidence_status: "unverified" }],
    });

    expect(
      demoDataForRequest(
        `/api/v1/service-suite/conversations/${conversationId}/internal-notes`,
      ),
    ).toBeUndefined();
    expect(
      demoDataForRequest("/api/v1/service-suite/agent/drafts"),
    ).toBeUndefined();
    expect(
      demoDataForRequest("/api/v1/service-suite/channels"),
    ).toBeUndefined();
  });
});
