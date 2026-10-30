// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

import canonicalCatalogFixture from "./fixtures/api/service-suite_catalog.json";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: { get: mocks.get } }));

import {
  getServiceSuiteCatalog,
  getServiceSuiteConfig,
  ServiceSuiteContractError,
} from "@/lib/service-suite-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const VERSION = "2026-08-24T10:00:00.123456789Z";

function config(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    version: VERSION,
    status: "draft",
    order_history_enabled: true,
    favorites_enabled: false,
    coupons_enabled: true,
    recommendations_enabled: false,
    customer_agent_enabled: false,
    runtime_available: false,
    runtime_status: "held",
    runtime_reason_code: "customer_hub_runtime_unavailable",
    customer_agent_effective_enabled: false,
    created_at: "2026-08-24T09:00:00Z",
    updated_at: VERSION,
    ...overrides,
  };
}

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    ...structuredClone(canonicalCatalogFixture),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.get.mockReset();
});

describe("service-suite availability client", () => {
  it("requires exact tenant binding and forwards AbortSignal", async () => {
    mocks.get.mockResolvedValue(config());
    const signal = new AbortController().signal;
    await expect(
      getServiceSuiteConfig(TENANT, { signal }),
    ).resolves.toMatchObject({
      tenantId: TENANT,
      version: VERSION,
      orderHistoryEnabled: true,
      customerAgentEnabled: false,
      runtimeAvailable: false,
      customerAgentEffectiveEnabled: false,
    });
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/service-suite/config", {
      signal,
    });

    mocks.get.mockResolvedValueOnce(config({ tenant_id: OTHER_TENANT }));
    await expect(getServiceSuiteConfig(TENANT)).rejects.toThrow(
      /tenant boundary/u,
    );

    mocks.get.mockResolvedValueOnce(config({ runtime_available: true }));
    await expect(getServiceSuiteConfig(TENANT)).rejects.toThrow(
      /runtime hold/u,
    );
  });

  it("accepts only omitted/null timestamps for an absent new-tenant config", async () => {
    const absent = config({
      version: "absent",
      created_at: undefined,
      updated_at: null,
    });
    mocks.get.mockResolvedValue(absent);
    await expect(getServiceSuiteConfig(TENANT)).resolves.toMatchObject({
      version: "absent",
      updatedAt: null,
    });

    mocks.get.mockResolvedValueOnce(
      config({
        version: "absent",
        created_at: "0001-01-01T00:00:00Z",
        updated_at: null,
      }),
    );
    await expect(getServiceSuiteConfig(TENANT)).rejects.toThrow(/invalid/u);

    mocks.get.mockResolvedValueOnce(
      config({ version: "absent", created_at: null, updated_at: "" }),
    );
    await expect(getServiceSuiteConfig(TENANT)).rejects.toThrow(/required/u);

    mocks.get.mockResolvedValueOnce(
      config({
        version: "2026-02-30T00:00:00Z",
        created_at: "2026-02-28T00:00:00Z",
        updated_at: "2026-02-30T00:00:00Z",
      }),
    );
    await expect(getServiceSuiteConfig(TENANT)).rejects.toThrow(/invalid/u);
  });

  it("pins every held capability and the no-provider guardrail", async () => {
    mocks.get.mockResolvedValue(catalog());
    const parsed = await getServiceSuiteCatalog();
    expect(parsed.provenance).toEqual({
      tenantBound: false,
      source: "static_server_catalog",
    });
    expect(parsed.guardrail.providerExecuted).toBe(false);
    expect(
      parsed.capabilities.find(
        (capability) => capability.key === "outbound_reply_delivery",
      ),
    ).toMatchObject({
      status: "held",
      code: "helpdesk_delivery_unavailable",
    });
    expect(
      parsed.capabilities.find(
        (capability) => capability.key === "macro_usage_evidence",
      ),
    ).toMatchObject({
      status: "held",
      code: "macro_usage_evidence_unavailable",
    });
    expect(
      parsed.capabilities.find(
        (capability) => capability.key === "customer_agent",
      ),
    ).toEqual({
      key: "customer_agent",
      status: "held",
      code: "customer_agent_draft_write_held",
      executionMode: "deterministic_template_only",
    });

    mocks.get.mockResolvedValueOnce(
      catalog({
        guardrail: {
          ...catalog().guardrail,
          provider_executed: true,
        },
      }),
    );
    await expect(getServiceSuiteCatalog()).rejects.toThrow(
      ServiceSuiteContractError,
    );
  });

  it("rejects swapped, additive, and action-expanding canonical catalog fields", async () => {
    const swapped = catalog();
    swapped.capabilities.resource_creation = {
      status: "held",
      code: "held",
      execution_mode: "helpdesk_create_replay_unavailable",
    } as never;
    mocks.get.mockResolvedValue(swapped);
    await expect(getServiceSuiteCatalog()).rejects.toThrow(
      /resource_creation/u,
    );

    const extraMode = catalog();
    extraMode.capabilities.resource_creation = {
      ...extraMode.capabilities.resource_creation,
      execution_mode: "deterministic_template_only",
    } as never;
    mocks.get.mockResolvedValue(extraMode);
    await expect(getServiceSuiteCatalog()).rejects.toThrow(
      /resource_creation/u,
    );

    const changedRuns = catalog();
    changedRuns.agent_run_types.push("provider_execute");
    mocks.get.mockResolvedValue(changedRuns);
    await expect(getServiceSuiteCatalog()).rejects.toThrow(/agent_run_types/u);
  });

  it("rejects hidden bidi controls instead of rewriting catalog display text", async () => {
    mocks.get.mockResolvedValue(
      catalog({
        channels: [
          {
            key: "web_chat",
            label: "Web chat\u202espoof",
            runtime_status: "held",
          },
          ...catalog().channels.slice(1),
        ],
      }),
    );
    await expect(getServiceSuiteCatalog()).rejects.toThrow(
      /unsafe to display/u,
    );
  });

  it("rejects non-canonical response UUIDs and safe unknown catalog tokens", async () => {
    mocks.get.mockResolvedValue(config({ tenantId: ` ${TENANT}` }));
    await expect(getServiceSuiteConfig(TENANT)).rejects.toThrow(/invalid/u);

    mocks.get.mockResolvedValue(
      catalog({
        channels: catalog().channels.map((channel, index) =>
          index === 0
            ? { ...channel, runtime_status: "release-held" }
            : channel,
        ),
      }),
    );
    await expect(getServiceSuiteCatalog()).rejects.toThrow(/client release/u);
  });
});
