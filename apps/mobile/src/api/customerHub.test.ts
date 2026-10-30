/**
 * Guard for the Customer Hub transport (api/customerHub.ts).
 *
 * This module exists because the record is versioned by a STRONG ETag the
 * server derives from `updated_at` (wire.go setEntityTag / requireIfMatch), so
 * three things have to hold that a plain `sdkResult` call could not express:
 *
 *  - the read must VERIFY the validator it was handed rather than trusting the
 *    body's `version` field;
 *  - the replacement must send that exact quoted validator back in one
 *    `If-Match` header — `requireIfMatch` rejects anything else with 428;
 *  - a draft the server would answer 409 must be refused BEFORE the request,
 *    with the server's own sentence, so a certain refusal costs no round trip
 *    and reads identically to the real 409.
 *
 * The last assertion is the one that matters most on a shared record: the PUT
 * body must be built from the DECODED record, so the six object-shaped members
 * mobile does not edit go back exactly as they arrived.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
const TENANT = "11111111-1111-4111-8111-111111111111";
const CREATED = "2026-08-24T10:00:00.111111111Z";
const VERSION = "2026-08-25T11:30:00.222222222Z";
const NEXT_VERSION = "2026-08-25T12:00:00.333333333Z";

vi.mock("@/api/client", () => ({
  getClient: () => ({ client: { request }, tenantId: TENANT }),
}));

// Vitest hoists the transport mock; keep the resource import below it.
// eslint-disable-next-line import/first
import {
  CUSTOMER_HUB_CONFIG_PATH,
  CustomerHubContractError,
  CustomerHubHeldError,
  fetchCustomerHubConfig,
  replaceCustomerHubConfig,
} from "./customerHub";
// eslint-disable-next-line import/first
import {
  CUSTOMER_HUB_HELD_SENTENCE,
  customerHubDraftFrom,
  parseCustomerHubConfig,
  type CustomerHubConfig,
} from "@/lib/customerHub";

const STOREFRONTS = [{ id: "storefront-built-on-desktop" }];
const STYLING = { accent: "#123456" };

function record(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    version: VERSION,
    status: "draft",
    storefronts: STOREFRONTS,
    content_blocks: [],
    personalization_rules: { segment: "vip" },
    support_settings: { hours: "9-5" },
    order_history_enabled: true,
    favorites_enabled: true,
    coupons_enabled: true,
    recommendations_enabled: true,
    customer_agent_enabled: false,
    styling: STYLING,
    metadata: { owner: "support" },
    runtime_available: false,
    runtime_status: "held",
    runtime_reason_code: "customer_hub_runtime_unavailable",
    customer_agent_effective_enabled: false,
    created_at: CREATED,
    updated_at: VERSION,
    ...overrides,
  };
}

/** Answer the SDK call with `body`, handing back `etag` as the ETag header. */
function respond(body: unknown, etag: string | null) {
  request.mockImplementation(
    async (
      _method: string,
      _path: string,
      options: Record<string, unknown>,
    ) => {
      const headers = new Headers(etag === null ? {} : { ETag: etag });
      (options.onResponseHeaders as (h: Headers) => void)(headers);
      return body;
    },
  );
}

function config(): CustomerHubConfig {
  const decoded = parseCustomerHubConfig(record(), TENANT);
  if (!decoded.value) throw new Error("fixture must decode");
  return decoded.value;
}

beforeEach(() => {
  request.mockReset();
});

describe("fetchCustomerHubConfig", () => {
  it("reads the record and keeps the exact strong validator", async () => {
    respond(record(), `"${VERSION}"`);
    const signal = new AbortController().signal;
    const resource = await fetchCustomerHubConfig({ signal });
    expect(resource.etag).toBe(`"${VERSION}"`);
    expect(resource.config.status).toBe("draft");
    expect(request).toHaveBeenCalledWith(
      "GET",
      CUSTOMER_HUB_CONFIG_PATH,
      expect.objectContaining({ signal }),
    );
  });

  it("addresses the path routeauth mounts", () => {
    expect(CUSTOMER_HUB_CONFIG_PATH).toBe("/api/v1/service-suite/config");
  });

  it("refuses a response whose ETag does not match its own version", async () => {
    respond(record(), `"${NEXT_VERSION}"`);
    await expect(fetchCustomerHubConfig()).rejects.toThrow(/validator/u);
  });

  it("refuses a response with no ETag at all", async () => {
    respond(record(), null);
    await expect(fetchCustomerHubConfig()).rejects.toThrow(/validator/u);
  });

  it("refuses a body that fails the record's own shape checks", async () => {
    respond(record({ runtime_status: "available" }), `"${VERSION}"`);
    await expect(fetchCustomerHubConfig()).rejects.toBeInstanceOf(
      CustomerHubContractError,
    );
  });
});

describe("replaceCustomerHubConfig", () => {
  it("sends one If-Match and a complete replacement body", async () => {
    const current = config();
    respond(record({ version: NEXT_VERSION, updated_at: NEXT_VERSION }), `"${NEXT_VERSION}"`);
    const replaced = await replaceCustomerHubConfig(
      current,
      { ...customerHubDraftFrom(current), status: "paused" },
      { ifMatch: `"${VERSION}"` },
    );
    expect(replaced.config.version).toBe(NEXT_VERSION);
    expect(replaced.etag).toBe(`"${NEXT_VERSION}"`);
    const [method, path, options] = request.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("PUT");
    expect(path).toBe(CUSTOMER_HUB_CONFIG_PATH);
    expect(options.headers).toEqual({ "If-Match": `"${VERSION}"` });
    expect(options.body).toMatchObject({ status: "paused" });
  });

  it("returns the unedited members exactly as the server sent them", async () => {
    const current = config();
    respond(record(), `"${VERSION}"`);
    await replaceCustomerHubConfig(current, customerHubDraftFrom(current), {
      ifMatch: `"${VERSION}"`,
    });
    const body = (request.mock.calls[0] as [string, string, { body: Record<string, unknown> }])[2]
      .body;
    expect(body.storefronts).toEqual(STOREFRONTS);
    expect(body.styling).toEqual(STYLING);
    expect(body.personalization_rules).toEqual({ segment: "vip" });
    expect(body.support_settings).toEqual({ hours: "9-5" });
    expect(body.metadata).toEqual({ owner: "support" });
    expect(body.content_blocks).toEqual([]);
  });

  it("refuses a release-held draft before spending a request", async () => {
    const current = config();
    for (const draft of [
      { ...customerHubDraftFrom(current), status: "active" as const },
      { ...customerHubDraftFrom(current), customer_agent_enabled: true },
    ]) {
      const failure = await replaceCustomerHubConfig(current, draft, {
        ifMatch: `"${VERSION}"`,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CustomerHubHeldError);
      expect((failure as CustomerHubHeldError).message).toBe(
        CUSTOMER_HUB_HELD_SENTENCE,
      );
      expect((failure as CustomerHubHeldError).status).toBe(409);
      expect((failure as CustomerHubHeldError).code).toBe(
        "customer_hub_runtime_unavailable",
      );
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a stale cached validator rather than sending it", async () => {
    const current = config();
    await expect(
      replaceCustomerHubConfig(current, customerHubDraftFrom(current), {
        ifMatch: `"${NEXT_VERSION}"`,
      }),
    ).rejects.toThrow(/validator/u);
    expect(request).not.toHaveBeenCalled();
  });
});
