// SPDX-License-Identifier: AGPL-3.0-only

/** Strict web contracts for account, catalog, and federated profile links. */
import { api } from "@/lib/api";
import {
  isExactSubscriberVersion,
  type Subscriber,
} from "@/lib/subscribers-api";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{15,254}$/;

export class SubscriberAssociationContractError extends Error {
  readonly code = "subscriber_association_contract_error";

  constructor(
    message = "The profile association service returned an invalid response.",
  ) {
    super(message);
    this.name = "SubscriberAssociationContractError";
  }
}

export class SubscriberAssociationInputError extends Error {
  readonly code = "subscriber_association_input_error";

  constructor(message: string) {
    super(message);
    this.name = "SubscriberAssociationInputError";
  }
}

export interface SubscriberAccount {
  id: string;
  tenant_id: string;
  name: string;
  industry: string;
  country: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SubscriberCatalogAttributes {
  subscriber_id: string;
  favorite_category: {
    category?: string;
    count?: number;
    timestamp?: string;
    top?: Array<{ category: string; count: number }>;
  } | null;
  last_viewed_sku: string | null;
  computed_at?: string;
}

export type FederationMatchType = "manual" | "email" | "external_id";

export interface SubscriberFederationLink {
  id: string;
  child_subscriber_id: string;
  parent_tenant_id: string;
  master_subscriber_id: string;
  match_type: FederationMatchType;
  match_key?: string;
  created_at: string;
  updated_at: string;
  subscriber_version?: string;
}

export interface SubscriberFederationPage {
  items: SubscriberFederationLink[];
  subscriber_version: string;
}

type MutationOptions = { idempotencyKey: string; signal?: AbortSignal };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new SubscriberAssociationContractError(`${label} is invalid.`);
  }
  return value;
}

function inputUuid(value: string, label: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!UUID_RE.test(trimmed)) {
    throw new SubscriberAssociationInputError(
      `${label} must be a canonical UUID.`,
    );
  }
  return trimmed;
}

function text(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    value.trim() !== value ||
    CONTROL_RE.test(value) ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new SubscriberAssociationContractError(`${label} is invalid.`);
  }
  return value;
}

function inputText(
  value: string,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  const trimmed = value.trim();
  if (
    trimmed.length > max ||
    CONTROL_RE.test(trimmed) ||
    (!allowEmpty && trimmed.length === 0)
  ) {
    throw new SubscriberAssociationInputError(`${label} is invalid.`);
  }
  return trimmed;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !TIMESTAMP_RE.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new SubscriberAssociationContractError(`${label} is invalid.`);
  }
  return value;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!record(value)) {
    throw new SubscriberAssociationContractError(`${label} is invalid.`);
  }
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > 32 * 1024) {
    throw new SubscriberAssociationContractError(`${label} is too large.`);
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

function assertMutation(options: MutationOptions): void {
  if (!IDEMPOTENCY_RE.test(options.idempotencyKey)) {
    throw new SubscriberAssociationInputError(
      "The mutation identity is invalid.",
    );
  }
}

function assertVersion(value: string, subscriberId: string): void {
  if (!isExactSubscriberVersion(value, subscriberId)) {
    throw new SubscriberAssociationInputError(
      "Reload the subscriber to obtain its latest exact revision.",
    );
  }
}

function parseAccount(value: unknown, tenantId: string): SubscriberAccount {
  if (!record(value) || value.tenant_id !== tenantId) {
    throw new SubscriberAssociationContractError();
  }
  return {
    id: uuid(value.id, "Account identity"),
    tenant_id: uuid(value.tenant_id, "Account tenant"),
    name: text(value.name, "Account name", 200),
    industry: text(value.industry, "Account industry", 120, true),
    country: text(value.country, "Account country", 8, true),
    metadata: jsonObject(value.metadata, "Account metadata"),
    created_at: timestamp(value.created_at, "Account creation time"),
    updated_at: timestamp(value.updated_at, "Account update time"),
  };
}

export async function listSubscriberAccounts(
  tenantId: string,
  signal?: AbortSignal,
): Promise<SubscriberAccount[]> {
  inputUuid(tenantId, "Workspace");
  const value = await api.get<unknown>("/api/v1/accounts", { signal });
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 10_000
  ) {
    throw new SubscriberAssociationContractError();
  }
  const items = value.items.map((item) => parseAccount(item, tenantId));
  if (
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total !== items.length ||
    new Set(items.map((item) => item.id)).size !== items.length
  ) {
    throw new SubscriberAssociationContractError();
  }
  return items;
}

export async function createSubscriberAccount(
  tenantId: string,
  input: { name: string; industry?: string },
  options: MutationOptions,
): Promise<SubscriberAccount> {
  inputUuid(tenantId, "Workspace");
  assertMutation(options);
  const name = inputText(input.name, "Account name", 200);
  const industry = inputText(input.industry ?? "", "Industry", 120, true);
  const value = await api.post<unknown>(
    "/api/v1/accounts",
    { name, industry },
    {
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
    },
  );
  const account = parseAccount(value, tenantId);
  if (account.name !== name || account.industry !== industry) {
    throw new SubscriberAssociationContractError();
  }
  return account;
}

export async function setSubscriberAccountLink(
  subscriberId: string,
  accountId: string | null,
  expectedVersion: string,
  options: MutationOptions,
): Promise<Subscriber> {
  inputUuid(subscriberId, "Subscriber");
  const normalizedAccountId =
    accountId === null ? null : inputUuid(accountId, "Account");
  assertVersion(expectedVersion, subscriberId);
  assertMutation(options);
  let responseVersion: string | null = null;
  const value = await api.patch<Subscriber>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/account`,
    { account_id: normalizedAccountId },
    {
      headers: { "If-Match": expectedVersion },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  if (
    value.id !== subscriberId ||
    (value.account_id ?? null) !== normalizedAccountId ||
    !isExactSubscriberVersion(value.version, subscriberId) ||
    value.version !== responseVersion
  ) {
    throw new SubscriberAssociationContractError();
  }
  return value;
}

function parseFavoriteCategory(
  value: unknown,
): SubscriberCatalogAttributes["favorite_category"] {
  if (value === null) return null;
  if (!record(value)) throw new SubscriberAssociationContractError();
  const output: NonNullable<SubscriberCatalogAttributes["favorite_category"]> =
    {};
  if (value.category !== undefined)
    output.category = text(value.category, "Favorite category", 256);
  if (value.count !== undefined) {
    if (
      typeof value.count !== "number" ||
      !Number.isFinite(value.count) ||
      value.count < 0
    ) {
      throw new SubscriberAssociationContractError();
    }
    output.count = value.count;
  }
  if (value.timestamp !== undefined)
    output.timestamp = timestamp(value.timestamp, "Catalog event time");
  if (value.top !== undefined) {
    if (!Array.isArray(value.top) || value.top.length > 20) {
      throw new SubscriberAssociationContractError();
    }
    output.top = value.top.map((candidate) => {
      if (
        !record(candidate) ||
        typeof candidate.count !== "number" ||
        !Number.isFinite(candidate.count) ||
        candidate.count < 0
      ) {
        throw new SubscriberAssociationContractError();
      }
      return {
        category: text(candidate.category, "Favorite category", 256),
        count: candidate.count,
      };
    });
  }
  return output;
}

export async function getSubscriberCatalogAttributes(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberCatalogAttributes> {
  inputUuid(subscriberId, "Subscriber");
  const value = await api.get<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/catalog-attributes`,
    { signal },
  );
  if (!record(value) || value.subscriber_id !== subscriberId) {
    throw new SubscriberAssociationContractError();
  }
  const lastViewedSku = value.last_viewed_sku;
  if (lastViewedSku !== null && typeof lastViewedSku !== "string") {
    throw new SubscriberAssociationContractError();
  }
  return {
    subscriber_id: subscriberId,
    favorite_category: parseFavoriteCategory(value.favorite_category),
    last_viewed_sku:
      lastViewedSku === null
        ? null
        : text(lastViewedSku, "Last viewed SKU", 512, true),
    ...(value.computed_at === undefined
      ? {}
      : {
          computed_at: timestamp(value.computed_at, "Catalog computation time"),
        }),
  };
}

function parseFederationLink(
  value: unknown,
  subscriberId: string,
): SubscriberFederationLink {
  if (
    !record(value) ||
    value.child_subscriber_id !== subscriberId ||
    !["manual", "email", "external_id"].includes(String(value.match_type))
  ) {
    throw new SubscriberAssociationContractError();
  }
  return {
    id: uuid(value.id, "Federation link"),
    child_subscriber_id: subscriberId,
    parent_tenant_id: uuid(value.parent_tenant_id, "Parent workspace"),
    master_subscriber_id: uuid(value.master_subscriber_id, "Master subscriber"),
    match_type: value.match_type as FederationMatchType,
    ...(value.match_key === undefined || value.match_key === ""
      ? {}
      : { match_key: text(value.match_key, "Federation evidence", 2048) }),
    created_at: timestamp(value.created_at, "Federation creation time"),
    updated_at: timestamp(value.updated_at, "Federation update time"),
    ...(value.subscriber_version === undefined
      ? {}
      : {
          subscriber_version: isExactSubscriberVersion(
            value.subscriber_version,
            subscriberId,
          )
            ? value.subscriber_version
            : (() => {
                throw new SubscriberAssociationContractError();
              })(),
        }),
  };
}

export async function listSubscriberFederationLinks(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberFederationPage> {
  inputUuid(subscriberId, "Subscriber");
  let responseVersion: string | null = null;
  const value = await api.get<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/federated-links`,
    {
      signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    !isExactSubscriberVersion(value.subscriber_version, subscriberId) ||
    value.subscriber_version !== responseVersion
  ) {
    throw new SubscriberAssociationContractError();
  }
  const items = value.items.map((item) =>
    parseFederationLink(item, subscriberId),
  );
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new SubscriberAssociationContractError();
  }
  return { items, subscriber_version: value.subscriber_version };
}

export async function createSubscriberFederationLink(
  subscriberId: string,
  input: {
    parent_tenant_id: string;
    master_subscriber_id: string;
    match_type: FederationMatchType;
    match_key: string;
  },
  expectedVersion: string,
  options: MutationOptions,
): Promise<SubscriberFederationLink> {
  inputUuid(subscriberId, "Subscriber");
  assertVersion(expectedVersion, subscriberId);
  assertMutation(options);
  const normalized = {
    parent_tenant_id: inputUuid(input.parent_tenant_id, "Parent workspace"),
    master_subscriber_id: inputUuid(
      input.master_subscriber_id,
      "Master subscriber",
    ),
    match_type: input.match_type,
    match_key: inputText(input.match_key, "Federation evidence", 2048),
  };
  if (!["manual", "email", "external_id"].includes(normalized.match_type)) {
    throw new SubscriberAssociationInputError("Match type is invalid.");
  }
  let responseVersion: string | null = null;
  const value = await api.post<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/federated-links`,
    normalized,
    {
      headers: { "If-Match": expectedVersion },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  const link = parseFederationLink(value, subscriberId);
  if (
    link.parent_tenant_id !== normalized.parent_tenant_id ||
    link.master_subscriber_id !== normalized.master_subscriber_id ||
    link.match_type !== normalized.match_type ||
    link.match_key !== normalized.match_key ||
    !isExactSubscriberVersion(link.subscriber_version, subscriberId) ||
    link.subscriber_version !== responseVersion
  ) {
    throw new SubscriberAssociationContractError();
  }
  return link;
}

export async function deleteSubscriberFederationLink(
  subscriberId: string,
  masterSubscriberId: string,
  expectedVersion: string,
  options: MutationOptions,
): Promise<string> {
  inputUuid(subscriberId, "Subscriber");
  const master = inputUuid(masterSubscriberId, "Master subscriber");
  assertVersion(expectedVersion, subscriberId);
  assertMutation(options);
  let responseVersion: string | null = null;
  const value = await api.delete<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/federated-links/${encodeURIComponent(master)}`,
    {
      headers: { "If-Match": expectedVersion },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  if (
    !record(value) ||
    value.deleted !== true ||
    !isExactSubscriberVersion(value.subscriber_version, subscriberId) ||
    value.subscriber_version !== responseVersion
  ) {
    throw new SubscriberAssociationContractError();
  }
  return value.subscriber_version;
}
