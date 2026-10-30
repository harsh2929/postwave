// Tests for the pure helpers behind the Customer Hub config form and the
// Customer Agent draft-reply panel (KLV-10). These guard the two trust-
// critical bits — the minimal hub patch differ and the agent guardrail
// classification (handoff / safety flags / tool_plan flattening).

import { describe, expect, it } from "vitest";

import serviceSuiteCatalogFixture from "../../../../web/src/__tests__/fixtures/api/service-suite_catalog.json";
import type { ServiceHubConfig } from "../../lib/api-client";
import {
  buildHubPatch,
  decodeAgentRun,
  decodeHubConfig,
  decodeMacroList,
  decodeServiceSuiteCatalog,
  describeWriteError,
  humanizeToken,
  isHandoff,
  patchHasChanges,
  safetyFlags,
  toolPlanEntries,
} from "../../components/helpdesk/agent-helpers";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const RESOURCE_ID = "33333333-3333-4333-8333-333333333333";
const VERSION = "2026-08-24T00:00:00Z";

function baseConfig(over: Partial<ServiceHubConfig> = {}): ServiceHubConfig {
  return {
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    version: VERSION,
    status: "active",
    order_history_enabled: true,
    favorites_enabled: false,
    coupons_enabled: false,
    recommendations_enabled: true,
    customer_agent_enabled: false,
    storefronts: [],
    content_blocks: [],
    personalization_rules: {},
    support_settings: {},
    styling: {},
    metadata: {},
    ...over,
    runtime_available: over.runtime_available ?? false,
    runtime_status: over.runtime_status ?? "held",
    runtime_reason_code:
      over.runtime_reason_code ?? "customer_hub_runtime_unavailable",
    customer_agent_effective_enabled:
      over.customer_agent_effective_enabled ?? false,
  };
}

function draftFrom(cfg: ServiceHubConfig): {
  status: string;
  order_history_enabled: boolean;
  favorites_enabled: boolean;
  coupons_enabled: boolean;
  recommendations_enabled: boolean;
  customer_agent_enabled: boolean;
} {
  return {
    status: cfg.status ?? "",
    order_history_enabled: Boolean(cfg.order_history_enabled),
    favorites_enabled: Boolean(cfg.favorites_enabled),
    coupons_enabled: Boolean(cfg.coupons_enabled),
    recommendations_enabled: Boolean(cfg.recommendations_enabled),
    customer_agent_enabled: Boolean(cfg.customer_agent_enabled),
  };
}

describe("buildHubPatch", () => {
  it("returns an empty patch when nothing changed", () => {
    const cfg = baseConfig();
    const patch = buildHubPatch(cfg, draftFrom(cfg));
    expect(patch).toEqual({});
    expect(patchHasChanges(patch)).toBe(false);
  });

  it("includes only the toggled fields", () => {
    const cfg = baseConfig();
    const draft = { ...draftFrom(cfg), customer_agent_enabled: true };
    const patch = buildHubPatch(cfg, draft);
    expect(patch).toEqual({ customer_agent_enabled: true });
    expect(patchHasChanges(patch)).toBe(true);
  });

  it("includes a changed status and trims it for comparison", () => {
    const cfg = baseConfig({ status: "active" });
    const draft = { ...draftFrom(cfg), status: "paused" };
    expect(buildHubPatch(cfg, draft)).toEqual({ status: "paused" });
    // Whitespace-only difference is NOT a change.
    expect(
      buildHubPatch(cfg, { ...draftFrom(cfg), status: "active " }),
    ).toEqual({});
  });

  it("treats missing server booleans as false", () => {
    const cfg = baseConfig({
      favorites_enabled: undefined as unknown as boolean,
    });
    // Server omitted favorites → false; flipping to true is the only change.
    const draft = { ...draftFrom(cfg), favorites_enabled: true };
    expect(buildHubPatch(cfg, draft)).toEqual({ favorites_enabled: true });
  });
});

describe("strict Customer Hub, macro, and deterministic-agent projections", () => {
  const collectionPage = {
    has_more: false,
    next_cursor: null,
    as_of: VERSION,
    consistency: "mutable_window",
    may_reorder: true,
  };

  it("decodes the exact frozen static catalog and rejects status, channel, or capability drift", () => {
    expect(decodeServiceSuiteCatalog(serviceSuiteCatalogFixture)).toMatchObject(
      {
        error: null,
        value: {
          conversation_statuses: [
            "open",
            "pending",
            "waiting",
            "resolved",
            "closed",
            "spam",
            "archived",
          ],
          channels: [
            { key: "web_chat", label: "Web chat", runtime_status: "held" },
            { key: "email", label: "Email", runtime_status: "held" },
            { key: "sms", label: "SMS", runtime_status: "held" },
            { key: "instagram", label: "Instagram", runtime_status: "held" },
            { key: "whatsapp", label: "WhatsApp", runtime_status: "held" },
            { key: "facebook", label: "Facebook", runtime_status: "held" },
          ],
        },
      },
    );

    const clone = () =>
      JSON.parse(JSON.stringify(serviceSuiteCatalogFixture)) as Record<
        string,
        unknown
      >;
    const reorderedStatuses = clone();
    reorderedStatuses.conversation_statuses = [
      "pending",
      "open",
      "waiting",
      "resolved",
      "closed",
      "spam",
      "archived",
    ];
    expect(decodeServiceSuiteCatalog(reorderedStatuses).value).toBeNull();

    const activeChannel = clone();
    (
      activeChannel.channels as Array<Record<string, unknown>>
    )[0]!.runtime_status = "active";
    expect(decodeServiceSuiteCatalog(activeChannel).value).toBeNull();

    const staleAgentShape = clone();
    (staleAgentShape.capabilities as Record<string, unknown>).customer_agent = {
      status: "deterministic_template_only",
    };
    expect(decodeServiceSuiteCatalog(staleAgentShape).value).toBeNull();

    const missingHeldCreate = clone();
    delete (missingHeldCreate.capabilities as Record<string, unknown>)
      .resource_creation;
    expect(decodeServiceSuiteCatalog(missingHeldCreate).value).toBeNull();
  });

  it("requires complete Hub replacement fields and server-owned held runtime truth", () => {
    const config = {
      ...baseConfig(),
      storefronts: [],
      content_blocks: [],
      personalization_rules: {},
      support_settings: {},
      styling: {},
      metadata: {},
      created_at: VERSION,
      updated_at: VERSION,
    };
    expect(decodeHubConfig(config, TENANT_ID).value).toMatchObject({
      runtime_available: false,
      runtime_status: "held",
      runtime_reason_code: "customer_hub_runtime_unavailable",
      customer_agent_effective_enabled: false,
    });
    expect(
      decodeHubConfig({ ...config, storefronts: undefined }, TENANT_ID).value,
    ).toBeNull();
    expect(
      decodeHubConfig({ ...config, runtime_available: true }, TENANT_ID).value,
    ).toBeNull();
    const {
      created_at: _created,
      updated_at: _updated,
      ...normalizedDefault
    } = config;
    expect(
      decodeHubConfig({ ...normalizedDefault, version: "absent" }, TENANT_ID)
        .value,
    ).toMatchObject({ version: "absent" });
    expect(
      decodeHubConfig(
        {
          ...normalizedDefault,
          version: "absent",
          created_at: "0001-01-01T00:00:00Z",
        },
        TENANT_ID,
      ).value,
    ).toBeNull();
    expect(
      decodeHubConfig(
        {
          ...config,
          version: "0001-01-01T00:00:00Z",
          created_at: "0001-01-01T00:00:00Z",
          updated_at: "0001-01-01T00:00:00Z",
        },
        TENANT_ID,
      ).value,
    ).toBeNull();
  });

  it("accepts multiline macro text but rejects poisoned rows and pagination", () => {
    const macro = {
      id: RESOURCE_ID,
      tenantId: TENANT_ID,
      tenant_id: TENANT_ID,
      version: VERSION,
      name: "Welcome",
      body: "First line\n\tSecond line",
      channel_types: ["web_chat"],
      tags: ["operator_review"],
      status: "active",
      usage_evidence_status: "unverified",
      created_at: VERSION,
      updated_at: VERSION,
    };
    expect(
      decodeMacroList(
        { tenantId: TENANT_ID, items: [macro], page: collectionPage },
        TENANT_ID,
      ),
    ).toMatchObject({ rejected: 0, envelopeError: null });
    expect(
      decodeMacroList(
        {
          tenantId: TENANT_ID,
          items: [{ ...macro, body: "😀".repeat(4097) }],
          page: collectionPage,
        },
        TENANT_ID,
      ).rejected,
    ).toBe(1);
    expect(
      decodeMacroList(
        {
          tenantId: TENANT_ID,
          items: [macro],
          page: { ...collectionPage, may_reorder: false },
        },
        TENANT_ID,
      ).envelopeError,
    ).not.toBeNull();
    for (const next_cursor of [
      "macro\tvalue",
      "macro\nvalue",
      "macro\rvalue",
      "macro\u0085value",
      "macro\u202evalue",
    ]) {
      expect(
        decodeMacroList(
          {
            tenantId: TENANT_ID,
            items: [macro],
            page: {
              ...collectionPage,
              has_more: true,
              next_cursor,
            },
          },
          TENANT_ID,
        ).envelopeError,
      ).not.toBeNull();
    }
  });

  it("accepts only bounded tenant-grounded deterministic draft output", () => {
    const run = {
      id: RESOURCE_ID,
      tenantId: TENANT_ID,
      tenant_id: TENANT_ID,
      conversation_id: CONVERSATION_ID,
      run_type: "draft_reply",
      status: "needs_handoff",
      model: "deterministic-template-v1",
      prompt: "Use the recorded context.",
      draft: "Draft line one\nDraft line two",
      safety_flags: ["operator_review_required"],
      handoff_reason: "Human review is required.",
      tool_plan: { send_message: "blocked" },
      execution_mode: "deterministic_template",
      provider_executed: false,
      created_at: VERSION,
      updated_at: VERSION,
    };
    expect(decodeAgentRun(run, TENANT_ID, CONVERSATION_ID).value).toMatchObject(
      {
        execution_mode: "deterministic_template",
        provider_executed: false,
        draft: run.draft,
      },
    );
    expect(
      decodeAgentRun(
        { ...run, provider_executed: true },
        TENANT_ID,
        CONVERSATION_ID,
      ).value,
    ).toBeNull();
    expect(
      decodeAgentRun(
        { ...run, draft: `safe\u202E${"x".repeat(20)}` },
        TENANT_ID,
        CONVERSATION_ID,
      ).value,
    ).toBeNull();
  });
});

describe("isHandoff", () => {
  it("is true for needs_handoff", () => {
    expect(isHandoff({ status: "needs_handoff" })).toBe(true);
  });
  it("is false for drafted", () => {
    expect(isHandoff({ status: "drafted" })).toBe(false);
    expect(isHandoff({ status: "DRAFTED" })).toBe(false);
  });
  it("fails closed — any other non-empty status is a handoff", () => {
    expect(isHandoff({ status: "errored" })).toBe(true);
    expect(isHandoff({ status: "blocked" })).toBe(true);
  });
  it("fails closed for an empty/absent status — unknown is not all-clear", () => {
    expect(isHandoff({ status: "" })).toBe(true);
    expect(isHandoff({ status: "   " })).toBe(true);
  });
});

describe("safetyFlags", () => {
  it("drops blanks and non-strings, defaults to []", () => {
    expect(safetyFlags({ safety_flags: undefined })).toEqual([]);
    expect(
      safetyFlags({
        safety_flags: ["operator_review_required", "", "  "],
      }),
    ).toEqual(["operator_review_required"]);
    expect(
      safetyFlags({
        safety_flags: ["a", 1, null] as unknown as string[],
      }),
    ).toEqual(["a"]);
  });
});

describe("toolPlanEntries", () => {
  it("returns [] for null / array / non-object", () => {
    expect(toolPlanEntries(null)).toEqual([]);
    expect(toolPlanEntries(undefined)).toEqual([]);
    expect(toolPlanEntries(["a"])).toEqual([]);
    expect(toolPlanEntries("x")).toEqual([]);
  });

  it("flattens scalars and JSON-stringifies nested values", () => {
    const entries = toolPlanEntries({
      lookup_order: "allowed",
      mutate_refund: false,
      blocked: ["refund", "cancel"],
      empty: null,
    });
    expect(entries).toEqual([
      { key: "lookup_order", value: "allowed" },
      { key: "mutate_refund", value: "false" },
      { key: "blocked", value: '["refund","cancel"]' },
      { key: "empty", value: "—" },
    ]);
  });
});

describe("humanizeToken", () => {
  it("title-cases snake/kebab tokens", () => {
    expect(humanizeToken("needs_handoff")).toBe("Needs Handoff");
    expect(humanizeToken("no-order-or-refund-mutation")).toBe(
      "No Order Or Refund Mutation",
    );
    expect(humanizeToken("")).toBe("");
  });
});

describe("describeWriteError", () => {
  const admin = "needs an admin key";
  it("maps an http 403 to the admin copy", () => {
    expect(
      describeWriteError(
        { kind: "http", status: 403, message: "Forbidden" },
        admin,
      ),
    ).toBe(admin);
  });
  it("passes through other errors verbatim", () => {
    expect(
      describeWriteError({ kind: "http", status: 500, message: "boom" }, admin),
    ).toBe("boom");
    expect(
      describeWriteError({ kind: "network", message: "offline" }, admin),
    ).toBe("offline");
  });
});
