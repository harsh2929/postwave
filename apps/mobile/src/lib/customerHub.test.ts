/**
 * Guard for the Customer Hub configuration record's decode + replacement
 * policy (lib/customerHub.ts).
 *
 * Three properties are load-bearing, and each one has a way of failing
 * silently rather than loudly:
 *
 *  1. THE RECORD IS NOT A RUNTIME. Every response the server can produce
 *     carries `runtime_available:false`, `runtime_status:"held"` and
 *     `customer_agent_effective_enabled:false` (repo.go scanHubConfig /
 *     defaultHubConfig set all three unconditionally). If a future build ever
 *     answered otherwise the decoder must REFUSE, because the sheet's standing
 *     copy tells the operator this record cannot make a customer see anything.
 *     A decoder that shrugged would turn that sentence into a lie.
 *  2. PUT IS A COMPLETE REPLACEMENT. `HubConfigPut.ValidateAndBuild`
 *     (wire.go:119) names twelve required members and rejects the body
 *     otherwise; six of them are objects mobile never edits. A replacement
 *     body that dropped one would either 400 or — worse, if the contract ever
 *     loosened — erase a storefront a desktop operator built.
 *  3. TWO VALUES ARE RELEASE-HELD. `status:"active"` and
 *     `customer_agent_enabled:true` are answered 409 by service_suite.go:420
 *     with a fixed sentence. We mirror the predicate exactly; drifting it
 *     either way spends a round trip on a certain refusal or hides a real one.
 *
 * The tenant/timestamp cases exist because this is a workspace-scoped admin
 * record: showing one workspace's Customer Hub inside another's session is the
 * worst outcome available to this screen.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CUSTOMER_HUB_ABSENT_VERSION,
  CUSTOMER_HUB_CARRIED_FIELDS,
  CUSTOMER_HUB_HELD_CODE,
  CUSTOMER_HUB_HELD_SENTENCE,
  CUSTOMER_HUB_STATUSES,
  CUSTOMER_HUB_TOGGLES,
  buildCustomerHubReplacement,
  customerHubChangedKeys,
  customerHubDraftChanged,
  customerHubDraftFrom,
  customerHubHeldReason,
  customerHubWriteOutcomeIsAmbiguous,
  parseCustomerHubConfig,
  type CustomerHubDraft,
} from "./customerHub";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-08-24T10:00:00.111111111Z";
const UPDATED = "2026-08-25T11:30:00.222222222Z";

function stored(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    version: UPDATED,
    status: "draft",
    storefronts: [],
    content_blocks: [],
    personalization_rules: {},
    support_settings: {},
    order_history_enabled: true,
    favorites_enabled: true,
    coupons_enabled: true,
    recommendations_enabled: true,
    customer_agent_enabled: false,
    styling: {},
    metadata: {},
    runtime_available: false,
    runtime_status: "held",
    runtime_reason_code: "customer_hub_runtime_unavailable",
    customer_agent_effective_enabled: false,
    created_at: CREATED,
    updated_at: UPDATED,
    ...overrides,
  };
}

/** The shape `defaultHubConfig` produces for a tenant with no stored row. */
function absentRow(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = stored({
    version: CUSTOMER_HUB_ABSENT_VERSION,
  });
  delete row.created_at;
  delete row.updated_at;
  return { ...row, ...overrides };
}

function decoded() {
  const result = parseCustomerHubConfig(stored(), TENANT);
  expect(result.error).toBeNull();
  if (!result.value) throw new Error("fixture must decode");
  return result.value;
}

const goSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../api/internal/service_suite/service_suite.go",
      import.meta.url,
    ),
  ),
  "utf8",
);

const wireSource = readFileSync(
  fileURLToPath(
    new URL("../../../api/internal/service_suite/wire.go", import.meta.url),
  ),
  "utf8",
);

describe("Customer Hub server mirror", () => {
  it("renders the server's own 409 sentence and code, not a paraphrase", () => {
    expect(goSource).toContain(
      `errEnv("${CUSTOMER_HUB_HELD_CODE}", "${CUSTOMER_HUB_HELD_SENTENCE}")`,
    );
  });

  it("offers exactly the statuses ValidateConfig accepts", () => {
    const listed = goSource.match(
      /allowed\(in\.Status, \[\]string\{([^}]*)\}\)/,
    );
    expect(listed?.[1]).toBeDefined();
    const serverStatuses = Array.from(
      listed![1]!.matchAll(/"([a-z_]+)"/g),
      (m) => m[1],
    );
    expect([...CUSTOMER_HUB_STATUSES]).toEqual(serverStatuses);
  });

  it("names the same absent-row sentinel the repo returns", () => {
    expect(wireSource).toContain(
      `const absentResourceVersion = "${CUSTOMER_HUB_ABSENT_VERSION}"`,
    );
  });

  it("sends every member ValidateAndBuild requires", () => {
    const body = buildCustomerHubReplacement(decoded(), {
      status: "paused",
      order_history_enabled: false,
      favorites_enabled: true,
      coupons_enabled: true,
      recommendations_enabled: true,
      customer_agent_enabled: false,
    });
    const required = Array.from(
      wireSource
        .slice(wireSource.indexOf("func (in HubConfigPut) ValidateAndBuild()"))
        .slice(0, 2000)
        .matchAll(/missing = append\(missing, "([a-z_]+)"\)/g),
      (m) => m[1]!,
    );
    expect(required.length).toBe(12);
    for (const member of required) {
      expect(Object.keys(body)).toContain(member);
    }
  });
});

describe("parseCustomerHubConfig", () => {
  it("decodes a stored record", () => {
    const { value, error } = parseCustomerHubConfig(stored(), TENANT);
    expect(error).toBeNull();
    expect(value?.version).toBe(UPDATED);
    expect(value?.status).toBe("draft");
    expect(value?.runtimeStatus).toBe("held");
    expect(value?.createdAt).toBe(CREATED);
  });

  it("decodes the absent-row default, which carries no timestamps", () => {
    const { value, error } = parseCustomerHubConfig(absentRow(), TENANT);
    expect(error).toBeNull();
    expect(value?.version).toBe(CUSTOMER_HUB_ABSENT_VERSION);
    expect(value?.createdAt).toBeNull();
    expect(value?.updatedAt).toBeNull();
  });

  it("refuses an absent row that nonetheless carries timestamps", () => {
    const { value } = parseCustomerHubConfig(
      absentRow({ created_at: CREATED, updated_at: UPDATED }),
      TENANT,
    );
    expect(value).toBeNull();
  });

  it("refuses another workspace's record", () => {
    const { value, error } = parseCustomerHubConfig(
      stored({ tenantId: OTHER_TENANT, tenant_id: OTHER_TENANT }),
      TENANT,
    );
    expect(value).toBeNull();
    expect(error).toContain("did not match this workspace");
  });

  it("refuses a record whose two tenant projections disagree", () => {
    const { value } = parseCustomerHubConfig(
      stored({ tenant_id: OTHER_TENANT }),
      TENANT,
    );
    expect(value).toBeNull();
  });

  it("refuses any claim that the storefront runtime is live", () => {
    for (const claim of [
      { runtime_available: true },
      { runtime_status: "available" },
      { customer_agent_effective_enabled: true },
      { runtime_reason_code: "" },
    ]) {
      const { value, error } = parseCustomerHubConfig(stored(claim), TENANT);
      expect(value, JSON.stringify(claim)).toBeNull();
      expect(error).toContain("live storefront runtime");
    }
  });

  it("refuses a status the server would not accept", () => {
    expect(parseCustomerHubConfig(stored({ status: "live" }), TENANT).value)
      .toBeNull();
  });

  it("refuses a non-boolean toggle rather than coercing it", () => {
    for (const toggle of CUSTOMER_HUB_TOGGLES) {
      const { value } = parseCustomerHubConfig(
        stored({ [toggle.key]: "true" }),
        TENANT,
      );
      expect(value, toggle.key).toBeNull();
    }
  });

  it("refuses a malformed carried member instead of narrowing it to empty", () => {
    for (const field of CUSTOMER_HUB_CARRIED_FIELDS) {
      const { value } = parseCustomerHubConfig(
        stored({ [field]: "not-json-shaped" }),
        TENANT,
      );
      expect(value, field).toBeNull();
    }
  });

  it("refuses a version that does not match the updated_at projection", () => {
    const { value } = parseCustomerHubConfig(
      stored({ version: "2026-08-25T11:30:00.999999999Z" }),
      TENANT,
    );
    expect(value).toBeNull();
  });

  it("refuses an updated_at that precedes created_at", () => {
    const { value } = parseCustomerHubConfig(
      stored({ created_at: UPDATED, updated_at: CREATED, version: CREATED }),
      TENANT,
    );
    expect(value).toBeNull();
  });

  it("refuses when the session's tenant is not a canonical id", () => {
    expect(parseCustomerHubConfig(stored(), "").value).toBeNull();
    expect(parseCustomerHubConfig(stored(), "not-a-uuid").value).toBeNull();
  });

  it("refuses a non-object body", () => {
    for (const body of [null, undefined, "{}", 7, []]) {
      expect(parseCustomerHubConfig(body, TENANT).value).toBeNull();
    }
  });
});

describe("draft policy", () => {
  it("takes the editable slice and reports no changes against itself", () => {
    const config = decoded();
    const draft = customerHubDraftFrom(config);
    expect(customerHubChangedKeys(config, draft)).toEqual([]);
    expect(customerHubDraftChanged(config, draft)).toBe(false);
  });

  it("names each changed key", () => {
    const config = decoded();
    const draft: CustomerHubDraft = {
      ...customerHubDraftFrom(config),
      status: "paused",
      coupons_enabled: false,
    };
    expect(customerHubChangedKeys(config, draft).sort()).toEqual([
      "coupons_enabled",
      "status",
    ]);
    expect(customerHubDraftChanged(config, draft)).toBe(true);
  });

  it("refuses the two release-held values with the server's sentence", () => {
    const base = customerHubDraftFrom(decoded());
    expect(customerHubHeldReason(base)).toBeNull();
    expect(customerHubHeldReason({ ...base, status: "active" })).toBe(
      CUSTOMER_HUB_HELD_SENTENCE,
    );
    expect(
      customerHubHeldReason({ ...base, customer_agent_enabled: true }),
    ).toBe(CUSTOMER_HUB_HELD_SENTENCE);
  });

  it("does not hold the statuses the server accepts", () => {
    const base = customerHubDraftFrom(decoded());
    for (const status of ["draft", "paused", "archived"] as const) {
      expect(customerHubHeldReason({ ...base, status })).toBeNull();
    }
  });

  it("carries the six unedited members forward by identity", () => {
    const config = decoded();
    const body = buildCustomerHubReplacement(
      config,
      customerHubDraftFrom(config),
    );
    expect(body.storefronts).toBe(config.carried.storefronts);
    expect(body.content_blocks).toBe(config.carried.content_blocks);
    expect(body.personalization_rules).toBe(
      config.carried.personalization_rules,
    );
    expect(body.support_settings).toBe(config.carried.support_settings);
    expect(body.styling).toBe(config.carried.styling);
    expect(body.metadata).toBe(config.carried.metadata);
  });

  it("sends the draft's values, not the record's", () => {
    const config = decoded();
    const body = buildCustomerHubReplacement(config, {
      ...customerHubDraftFrom(config),
      status: "archived",
      favorites_enabled: false,
    });
    expect(body.status).toBe("archived");
    expect(body.favorites_enabled).toBe(false);
    expect(body.order_history_enabled).toBe(true);
  });
});

describe("customerHubWriteOutcomeIsAmbiguous", () => {
  it("treats the server's frozen 4xx verdicts as definitive", () => {
    for (const status of [400, 401, 403, 404, 409, 412, 428, 429]) {
      expect(customerHubWriteOutcomeIsAmbiguous({ status })).toBe(false);
    }
  });

  it("treats a timeout, a 5xx and an unshaped failure as ambiguous", () => {
    for (const error of [
      null,
      undefined,
      "network",
      {},
      { status: "500" },
      { status: 500 },
      { status: 502 },
      { status: 408 },
      { status: Number.NaN },
    ]) {
      expect(customerHubWriteOutcomeIsAmbiguous(error)).toBe(true);
    }
  });
});
