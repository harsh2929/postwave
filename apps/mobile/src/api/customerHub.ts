/**
 * Transport for the Customer Hub configuration record.
 *
 *   GET /api/v1/service-suite/config  role=admin  (routeauth manifest.json:18657)
 *   PUT /api/v1/service-suite/config  role=admin  (routeauth manifest.json:39720)
 *
 * Both are `session_minimum_role: admin`, reviewed, and NOT in the helpdesk
 * release-held set — the hold on this feature lives inside the record's own
 * response (`runtime_status: "held"`), not on the route.
 *
 * Uses `getClient()` directly rather than `rawRequest`, matching its sibling
 * `api/serviceSuite.ts`: this family verifies the strong ETag against the body
 * version on every read, and that needs the response headers, which the
 * result-envelope helpers do not surface.
 */
import { getClient } from "@/api/client";
import { helpdeskStrongEntityTag } from "@/lib/helpdesk";
import {
  buildCustomerHubReplacement,
  customerHubHeldReason,
  parseCustomerHubConfig,
  type CustomerHubConfig,
  type CustomerHubDraft,
} from "@/lib/customerHub";

export const CUSTOMER_HUB_CONFIG_PATH = "/api/v1/service-suite/config";

export interface CustomerHubResource {
  config: CustomerHubConfig;
  /** The exact strong validator to send back as `If-Match`. */
  etag: string;
}

export class CustomerHubContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerHubContractError";
  }
}

/**
 * A local refusal that carries the server's own code and sentence, so a UI
 * branch written for the 409 works for the pre-flight refusal too.
 */
export class CustomerHubHeldError extends Error {
  readonly status = 409;
  readonly code = "customer_hub_runtime_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "CustomerHubHeldError";
  }
}

function decodeOrThrow(
  raw: unknown,
  tenantId: string,
  responseTag: string | null,
): CustomerHubResource {
  const decoded = parseCustomerHubConfig(raw, tenantId);
  if (!decoded.value) {
    throw new CustomerHubContractError(
      decoded.error ?? "The Customer Hub response was invalid.",
    );
  }
  return {
    config: decoded.value,
    etag: helpdeskStrongEntityTag(responseTag, decoded.value.version),
  };
}

export async function fetchCustomerHubConfig(
  options: { signal?: AbortSignal } = {},
): Promise<CustomerHubResource> {
  const { client, tenantId } = getClient();
  let responseTag: string | null = null;
  const raw = await client.request<unknown>("GET", CUSTOMER_HUB_CONFIG_PATH, {
    onResponseHeaders: (headers) => {
      responseTag = headers.get("ETag");
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return decodeOrThrow(raw, tenantId, responseTag);
}

/**
 * Replace the whole configuration record.
 *
 * The body is built from the DECODED record, never from the raw response, so
 * the six object-shaped members that mobile does not edit round-trip exactly.
 * A draft the server would refuse (409 `customer_hub_runtime_unavailable`) is
 * refused here first, with the server's sentence.
 */
export async function replaceCustomerHubConfig(
  config: CustomerHubConfig,
  draft: CustomerHubDraft,
  options: { ifMatch: string; signal?: AbortSignal },
): Promise<CustomerHubResource> {
  const held = customerHubHeldReason(draft);
  if (held) throw new CustomerHubHeldError(held);
  const { client, tenantId } = getClient();
  const ifMatch = helpdeskStrongEntityTag(options.ifMatch, config.version);
  let responseTag: string | null = null;
  const raw = await client.request<unknown>("PUT", CUSTOMER_HUB_CONFIG_PATH, {
    body: buildCustomerHubReplacement(config, draft),
    headers: { "If-Match": ifMatch },
    onResponseHeaders: (headers) => {
      responseTag = headers.get("ETag");
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return decodeOrThrow(raw, tenantId, responseTag);
}
