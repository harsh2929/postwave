// SPDX-License-Identifier: AGPL-3.0-only

/** Exact client contracts for the advanced subscriber identity/profile APIs. */
import { api } from "@/lib/api";
import { isExactSubscriberVersion } from "@/lib/subscribers-api";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const FREE_TEXT_CONTROL_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const ADDRESS_VERSION_RE = /^"subscriber-email:([A-Za-z0-9._~-]+):v[0-9]+"$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{15,254}$/;

export class SubscriberIdentityContractError extends Error {
  readonly code = "subscriber_identity_contract_error";

  constructor(
    message = "The subscriber identity service returned an invalid response.",
  ) {
    super(message);
    this.name = "SubscriberIdentityContractError";
  }
}

export class SubscriberIdentityInputError extends Error {
  readonly code = "subscriber_identity_input_error";

  constructor(message: string) {
    super(message);
    this.name = "SubscriberIdentityInputError";
  }
}

export type SubscriberAliasType =
  | "email"
  | "external_id"
  | "anonymous_id"
  | "phone"
  | "device_token"
  | "push_token"
  | "custom";

export type EditableSubscriberAliasType = Exclude<
  SubscriberAliasType,
  "email" | "phone"
>;

export interface SubscriberAlias {
  id: string;
  subscriber_id: string;
  alias_type: SubscriberAliasType;
  alias_value: string;
  confidence: number;
  source: string;
  provenance: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  subscriber_version?: string;
  external_id?: string | null;
}

export interface SubscriberAliasPage {
  items: SubscriberAlias[];
  subscriber_version: string;
}

export type SubscriberEmailConsent =
  | "subscribed"
  | "unsubscribed"
  | "never_subscribed"
  | "pending"
  | "unknown";

export interface SubscriberEmailAddress {
  id: string;
  subscriber_id: string;
  email: string;
  is_primary: boolean;
  consent_status: SubscriberEmailConsent;
  suppressed: boolean;
  last_engaged_at?: string;
  created_at: string;
  updated_at: string;
  version: string;
}

export interface SubscriberComputedTrait {
  id: string;
  subscriber_id: string;
  key: string;
  value: unknown;
  value_type: "string" | "number" | "boolean" | "date" | "datetime" | "json";
  source: "operator" | "api" | "model" | "warehouse" | "system";
  model_version?: string;
  confidence?: number;
  drivers: Array<Record<string, unknown>>;
  computed_at?: string;
  updated_at?: string;
}

export const SUBSCRIBER_LIFECYCLE_STAGES = [
  "subscriber",
  "lead",
  "mql",
  "sql",
  "opportunity",
  "customer",
  "evangelist",
  "other",
] as const;
export type SubscriberLifecycleStage =
  (typeof SUBSCRIBER_LIFECYCLE_STAGES)[number];

export interface SubscriberLifecycle {
  subscriber_id: string;
  tenant_id: string;
  stage: SubscriberLifecycleStage;
  previous_stage?: SubscriberLifecycleStage;
  score: number;
  transitioned?: boolean;
  transitioned_at?: string;
  updated_at: string;
  transition_sequence: number;
  subscriber_version: string;
}

interface MutationOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new SubscriberIdentityContractError(`${label} is invalid.`);
  }
  return value;
}

function inputUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) {
    throw new SubscriberIdentityInputError(
      `${label} must be a canonical UUID.`,
    );
  }
  return value;
}

function safeText(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value ||
    CONTROL_RE.test(value)
  ) {
    throw new SubscriberIdentityContractError(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !TIMESTAMP_RE.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new SubscriberIdentityContractError(`${label} is invalid.`);
  }
  return value;
}

function boundedJsonObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!record(value)) {
    throw new SubscriberIdentityContractError(`${label} is invalid.`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new SubscriberIdentityContractError(`${label} is invalid.`);
  }
  if (new TextEncoder().encode(encoded).length > 256 * 1024) {
    throw new SubscriberIdentityContractError(`${label} is too large.`);
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_RE.test(value)) {
    throw new SubscriberIdentityInputError("The mutation identity is invalid.");
  }
}

function assertSubscriberVersion(value: string, subscriberId: string): void {
  if (!isExactSubscriberVersion(value, subscriberId)) {
    throw new SubscriberIdentityInputError(
      "Reload the subscriber to obtain its latest exact revision.",
    );
  }
}

function assertAddressReference(
  address: SubscriberEmailAddress,
  subscriberId: string,
): void {
  inputUuid(address.id, "Email identity");
  if (
    address.subscriber_id !== subscriberId ||
    ADDRESS_VERSION_RE.exec(address.version)?.[1]?.toLowerCase() !==
      address.id.toLowerCase()
  ) {
    throw new SubscriberIdentityInputError(
      "Reload this address before changing it.",
    );
  }
}

function parseAlias(
  value: unknown,
  expectedSubscriberId: string,
): SubscriberAlias {
  if (!record(value)) throw new SubscriberIdentityContractError();
  const required = [
    "id",
    "subscriber_id",
    "alias_type",
    "alias_value",
    "confidence",
    "source",
    "provenance",
    "first_seen_at",
    "last_seen_at",
    "created_at",
    "updated_at",
  ] as const;
  if (
    !exactKeys(value, required, ["subscriber_version", "external_id"]) ||
    uuid(value.subscriber_id, "Subscriber identity") !== expectedSubscriberId ||
    ![
      "email",
      "external_id",
      "anonymous_id",
      "phone",
      "device_token",
      "push_token",
      "custom",
    ].includes(String(value.alias_type)) ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new SubscriberIdentityContractError();
  }
  return {
    id: uuid(value.id, "Alias identity"),
    subscriber_id: expectedSubscriberId,
    alias_type: value.alias_type as SubscriberAliasType,
    alias_value: safeText(value.alias_value, "Alias value", 512),
    confidence: value.confidence,
    source: safeText(value.source, "Alias source", 64),
    provenance: boundedJsonObject(value.provenance, "Alias provenance"),
    first_seen_at: timestamp(value.first_seen_at, "First seen time"),
    last_seen_at: timestamp(value.last_seen_at, "Last seen time"),
    created_at: timestamp(value.created_at, "Created time"),
    updated_at: timestamp(value.updated_at, "Updated time"),
    ...(typeof value.subscriber_version === "string"
      ? { subscriber_version: value.subscriber_version }
      : {}),
    ...(value.external_id === null || typeof value.external_id === "string"
      ? { external_id: value.external_id }
      : {}),
  };
}

function parseEmailAddress(
  value: unknown,
  expectedSubscriberId: string,
): SubscriberEmailAddress {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "id",
        "subscriber_id",
        "email",
        "is_primary",
        "consent_status",
        "suppressed",
        "created_at",
        "updated_at",
        "version",
      ],
      ["last_engaged_at"],
    ) ||
    uuid(value.subscriber_id, "Subscriber identity") !== expectedSubscriberId ||
    typeof value.email !== "string" ||
    value.email.length > 320 ||
    !EMAIL_RE.test(value.email) ||
    typeof value.is_primary !== "boolean" ||
    ![
      "subscribed",
      "unsubscribed",
      "never_subscribed",
      "pending",
      "unknown",
    ].includes(String(value.consent_status)) ||
    typeof value.suppressed !== "boolean"
  ) {
    throw new SubscriberIdentityContractError();
  }
  const id = uuid(value.id, "Email identity");
  if (
    typeof value.version !== "string" ||
    ADDRESS_VERSION_RE.exec(value.version)?.[1]?.toLowerCase() !== id
  ) {
    throw new SubscriberIdentityContractError("Email revision is invalid.");
  }
  return {
    id,
    subscriber_id: expectedSubscriberId,
    email: value.email.trim().toLowerCase(),
    is_primary: value.is_primary,
    consent_status: value.consent_status as SubscriberEmailConsent,
    suppressed: value.suppressed,
    ...(value.last_engaged_at !== undefined
      ? { last_engaged_at: timestamp(value.last_engaged_at, "Last engagement") }
      : {}),
    created_at: timestamp(value.created_at, "Created time"),
    updated_at: timestamp(value.updated_at, "Updated time"),
    version: value.version,
  };
}

function parseLifecycle(
  value: unknown,
  expectedSubscriberId: string,
  expectedTenantId: string,
  responseVersion: string | null,
): SubscriberLifecycle {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "subscriber_id",
        "tenant_id",
        "stage",
        "score",
        "updated_at",
        "transition_sequence",
        "subscriber_version",
      ],
      ["previous_stage", "transitioned", "transitioned_at"],
    ) ||
    uuid(value.subscriber_id, "Subscriber identity") !== expectedSubscriberId ||
    uuid(value.tenant_id, "Tenant identity") !== expectedTenantId ||
    !SUBSCRIBER_LIFECYCLE_STAGES.includes(
      value.stage as SubscriberLifecycleStage,
    ) ||
    !Number.isSafeInteger(value.score) ||
    Number(value.score) < 1 ||
    Number(value.score) > 5 ||
    !Number.isSafeInteger(value.transition_sequence) ||
    Number(value.transition_sequence) < 0 ||
    !isExactSubscriberVersion(value.subscriber_version, expectedSubscriberId) ||
    responseVersion !== value.subscriber_version
  ) {
    throw new SubscriberIdentityContractError();
  }
  const previous = value.previous_stage;
  const transitioned = value.transitioned;
  const transitionedAt = value.transitioned_at;
  if (
    (previous !== undefined &&
      !SUBSCRIBER_LIFECYCLE_STAGES.includes(
        previous as SubscriberLifecycleStage,
      )) ||
    (transitioned !== undefined && typeof transitioned !== "boolean") ||
    (transitionedAt !== undefined && typeof transitionedAt !== "string")
  ) {
    throw new SubscriberIdentityContractError();
  }
  return {
    subscriber_id: expectedSubscriberId,
    tenant_id: expectedTenantId,
    stage: value.stage as SubscriberLifecycleStage,
    score: Number(value.score),
    updated_at: timestamp(value.updated_at, "Lifecycle update time"),
    transition_sequence: Number(value.transition_sequence),
    subscriber_version: value.subscriber_version,
    ...(previous !== undefined
      ? { previous_stage: previous as SubscriberLifecycleStage }
      : {}),
    ...(transitioned !== undefined ? { transitioned } : {}),
    ...(transitionedAt !== undefined
      ? { transitioned_at: timestamp(transitionedAt, "Transition time") }
      : {}),
  };
}

export async function listSubscriberAliases(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberAliasPage> {
  inputUuid(subscriberId, "Subscriber identity");
  let responseVersion: string | null = null;
  const payload = await api.get<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/aliases`,
    {
      signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  if (
    !record(payload) ||
    !exactKeys(payload, ["items", "subscriber_version"]) ||
    !Array.isArray(payload.items) ||
    payload.items.length > 1_000 ||
    !isExactSubscriberVersion(payload.subscriber_version, subscriberId) ||
    payload.subscriber_version !== responseVersion
  ) {
    throw new SubscriberIdentityContractError();
  }
  const items = payload.items.map((item) => parseAlias(item, subscriberId));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new SubscriberIdentityContractError();
  }
  return { items, subscriber_version: payload.subscriber_version };
}

export async function addSubscriberAlias(
  subscriberId: string,
  input: {
    alias_type: EditableSubscriberAliasType;
    alias_value: string;
    source?: string;
  },
  expectedVersion: string,
  options: MutationOptions,
): Promise<SubscriberAlias> {
  inputUuid(subscriberId, "Subscriber identity");
  assertSubscriberVersion(expectedVersion, subscriberId);
  assertIdempotencyKey(options.idempotencyKey);
  const aliasValue = input.alias_value.trim();
  if (!aliasValue || aliasValue.length > 512 || CONTROL_RE.test(aliasValue)) {
    throw new SubscriberIdentityInputError("Enter a safe alias value.");
  }
  let responseVersion: string | null = null;
  const payload = await api.post<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/aliases`,
    {
      alias_type: input.alias_type,
      alias_value: aliasValue,
      confidence: 1,
      source: input.source ?? "operator",
      provenance: { surface: "web_subscriber_profile" },
    },
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
  const parsed = parseAlias(payload, subscriberId);
  if (
    parsed.alias_type !== input.alias_type ||
    parsed.alias_value !== aliasValue ||
    !isExactSubscriberVersion(parsed.subscriber_version, subscriberId) ||
    parsed.subscriber_version !== responseVersion
  ) {
    throw new SubscriberIdentityContractError();
  }
  return parsed;
}

export async function deleteSubscriberAlias(
  subscriberId: string,
  aliasId: string,
  expectedVersion: string,
  options: MutationOptions,
): Promise<{ subscriberVersion: string; externalId: string | null }> {
  inputUuid(subscriberId, "Subscriber identity");
  inputUuid(aliasId, "Alias identity");
  assertSubscriberVersion(expectedVersion, subscriberId);
  assertIdempotencyKey(options.idempotencyKey);
  let responseVersion: string | null = null;
  const payload = await api.delete<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/aliases/${encodeURIComponent(aliasId)}`,
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
    !record(payload) ||
    !exactKeys(payload, [
      "deleted",
      "subscriber_id",
      "subscriber_version",
      "external_id",
    ]) ||
    payload.deleted !== true ||
    payload.subscriber_id !== subscriberId ||
    !isExactSubscriberVersion(payload.subscriber_version, subscriberId) ||
    payload.subscriber_version !== responseVersion ||
    !(payload.external_id === null || typeof payload.external_id === "string")
  ) {
    throw new SubscriberIdentityContractError();
  }
  return {
    subscriberVersion: payload.subscriber_version,
    externalId: payload.external_id,
  };
}

export async function listSubscriberEmails(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberEmailAddress[]> {
  inputUuid(subscriberId, "Subscriber identity");
  const payload = await api.get<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/emails`,
    { signal },
  );
  if (
    !record(payload) ||
    !exactKeys(payload, ["items"]) ||
    !Array.isArray(payload.items) ||
    payload.items.length > 5
  ) {
    throw new SubscriberIdentityContractError();
  }
  const items = payload.items.map((item) =>
    parseEmailAddress(item, subscriberId),
  );
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    new Set(items.map((item) => item.email)).size !== items.length ||
    (items.length > 0 && items.filter((item) => item.is_primary).length !== 1)
  ) {
    throw new SubscriberIdentityContractError();
  }
  return items;
}

export async function addSubscriberEmail(
  subscriberId: string,
  email: string,
  expectedSubscriberVersion: string,
  options: MutationOptions,
): Promise<SubscriberEmailAddress> {
  inputUuid(subscriberId, "Subscriber identity");
  assertSubscriberVersion(expectedSubscriberVersion, subscriberId);
  assertIdempotencyKey(options.idempotencyKey);
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 320 || !EMAIL_RE.test(normalized)) {
    throw new SubscriberIdentityInputError("Enter a valid email address.");
  }
  let responseVersion: string | null = null;
  const payload = await api.post<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/emails`,
    { email: normalized, is_primary: false },
    {
      headers: { "If-Match": expectedSubscriberVersion },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  const parsed = parseEmailAddress(payload, subscriberId);
  if (
    parsed.email !== normalized ||
    parsed.is_primary ||
    parsed.version !== responseVersion
  ) {
    throw new SubscriberIdentityContractError();
  }
  return parsed;
}

export async function setSubscriberEmailSuppression(
  subscriberId: string,
  address: SubscriberEmailAddress,
  input: { suppressed: boolean; reason: string; evidence: string },
  options: MutationOptions,
): Promise<SubscriberEmailAddress> {
  inputUuid(subscriberId, "Subscriber identity");
  assertAddressReference(address, subscriberId);
  assertIdempotencyKey(options.idempotencyKey);
  const reason = input.reason.trim();
  const evidence = input.evidence.trim();
  if (
    !reason ||
    reason.length > 500 ||
    FREE_TEXT_CONTROL_RE.test(reason) ||
    !evidence ||
    evidence.length > 2_048 ||
    FREE_TEXT_CONTROL_RE.test(evidence)
  ) {
    throw new SubscriberIdentityInputError(
      "Review the complete suppression evidence before saving.",
    );
  }
  let responseVersion: string | null = null;
  const payload = await api.patch<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/emails/${encodeURIComponent(address.id)}`,
    {
      suppressed: input.suppressed,
      suppression_reason: reason,
      suppression_evidence: evidence,
    },
    {
      headers: { "If-Match": address.version },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  const parsed = parseEmailAddress(payload, subscriberId);
  if (
    parsed.id !== address.id ||
    parsed.suppressed !== input.suppressed ||
    parsed.version !== responseVersion
  ) {
    throw new SubscriberIdentityContractError();
  }
  return parsed;
}

export async function updateSubscriberEmailConsent(
  subscriberId: string,
  address: SubscriberEmailAddress,
  input: {
    consent_status: "subscribed" | "unsubscribed" | "pending";
    source:
      | "double_optin"
      | "single_optin"
      | "preference_center"
      | "signed_form"
      | "direct_request";
    channel: "web" | "mobile" | "desktop" | "email" | "import" | "api";
    legal_basis:
      | "consent"
      | "contract"
      | "legitimate_interest"
      | "legal_obligation";
    occurred_at: string;
    jurisdiction: string;
    evidence: string;
    reason: string;
    policy_version: string;
  },
  options: MutationOptions,
): Promise<SubscriberEmailAddress> {
  inputUuid(subscriberId, "Subscriber identity");
  assertAddressReference(address, subscriberId);
  assertIdempotencyKey(options.idempotencyKey);
  if (
    !Number.isFinite(Date.parse(input.occurred_at)) ||
    input.jurisdiction.trim().length < 1 ||
    input.jurisdiction.trim().length > 32 ||
    input.evidence.trim().length < 1 ||
    input.evidence.trim().length > 2_048 ||
    input.reason.trim().length < 1 ||
    input.reason.trim().length > 500 ||
    input.policy_version.trim().length < 1 ||
    input.policy_version.trim().length > 100
  ) {
    throw new SubscriberIdentityInputError(
      "Review the complete address-consent evidence before saving.",
    );
  }
  let responseVersion: string | null = null;
  const payload = await api.patch<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/emails/${encodeURIComponent(address.id)}`,
    {
      ...input,
      jurisdiction: input.jurisdiction.trim().toUpperCase(),
      evidence: input.evidence.trim(),
      reason: input.reason.trim(),
      policy_version: input.policy_version.trim(),
    },
    {
      headers: { "If-Match": address.version },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  const parsed = parseEmailAddress(payload, subscriberId);
  if (
    parsed.id !== address.id ||
    parsed.consent_status !== input.consent_status ||
    parsed.version !== responseVersion
  ) {
    throw new SubscriberIdentityContractError();
  }
  return parsed;
}

export async function deleteSubscriberEmail(
  subscriberId: string,
  address: SubscriberEmailAddress,
  options: MutationOptions,
): Promise<void> {
  inputUuid(subscriberId, "Subscriber identity");
  assertAddressReference(address, subscriberId);
  assertIdempotencyKey(options.idempotencyKey);
  const payload = await api.delete<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/emails/${encodeURIComponent(address.id)}`,
    {
      headers: { "If-Match": address.version },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
    },
  );
  if (
    !record(payload) ||
    !exactKeys(payload, ["deleted"]) ||
    payload.deleted !== true
  ) {
    throw new SubscriberIdentityContractError();
  }
}

export async function listSubscriberTraits(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberComputedTrait[]> {
  inputUuid(subscriberId, "Subscriber identity");
  const payload = await api.get<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/traits`,
    { signal },
  );
  if (
    !record(payload) ||
    !exactKeys(payload, ["items"]) ||
    !Array.isArray(payload.items) ||
    payload.items.length > 1_000
  ) {
    throw new SubscriberIdentityContractError();
  }
  return payload.items.map((item) => {
    if (
      !record(item) ||
      uuid(item.subscriber_id, "Subscriber identity") !== subscriberId ||
      !["string", "number", "boolean", "date", "datetime", "json"].includes(
        String(item.value_type),
      ) ||
      !["operator", "api", "model", "warehouse", "system"].includes(
        String(item.source),
      )
    ) {
      throw new SubscriberIdentityContractError();
    }
    return {
      id: uuid(item.id, "Trait identity"),
      subscriber_id: subscriberId,
      key: safeText(item.key, "Trait key", 96),
      value: item.value,
      value_type: item.value_type as SubscriberComputedTrait["value_type"],
      source: item.source as SubscriberComputedTrait["source"],
      ...(typeof item.model_version === "string"
        ? { model_version: safeText(item.model_version, "Model version", 200) }
        : {}),
      ...(typeof item.confidence === "number" &&
      Number.isFinite(item.confidence) &&
      item.confidence >= 0 &&
      item.confidence <= 1
        ? { confidence: item.confidence }
        : {}),
      drivers: Array.isArray(item.drivers)
        ? item.drivers
            .slice(0, 100)
            .map((entry) => boundedJsonObject(entry, "Trait driver"))
        : [],
      ...(typeof item.computed_at === "string"
        ? { computed_at: timestamp(item.computed_at, "Computed time") }
        : {}),
      ...(typeof item.updated_at === "string"
        ? { updated_at: timestamp(item.updated_at, "Updated time") }
        : {}),
    };
  });
}

export async function getSubscriberLifecycle(
  subscriberId: string,
  tenantId: string,
  signal?: AbortSignal,
): Promise<SubscriberLifecycle> {
  inputUuid(subscriberId, "Subscriber identity");
  inputUuid(tenantId, "Tenant identity");
  let responseVersion: string | null = null;
  const payload = await api.get<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/lifecycle`,
    {
      signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  return parseLifecycle(payload, subscriberId, tenantId, responseVersion);
}

export async function updateSubscriberLifecycle(
  subscriberId: string,
  tenantId: string,
  input: { stage: SubscriberLifecycleStage; score: number; reason: string },
  expectedVersion: string,
  options: MutationOptions,
): Promise<SubscriberLifecycle> {
  inputUuid(subscriberId, "Subscriber identity");
  inputUuid(tenantId, "Tenant identity");
  assertSubscriberVersion(expectedVersion, subscriberId);
  assertIdempotencyKey(options.idempotencyKey);
  if (
    !SUBSCRIBER_LIFECYCLE_STAGES.includes(input.stage) ||
    !Number.isSafeInteger(input.score) ||
    input.score < 1 ||
    input.score > 5 ||
    !input.reason.trim() ||
    input.reason.trim().length > 500
  ) {
    throw new SubscriberIdentityInputError(
      "Review the lifecycle change fields.",
    );
  }
  let responseVersion: string | null = null;
  const payload = await api.put<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/lifecycle`,
    {
      stage: input.stage,
      score: input.score,
      source: "web_subscriber_profile",
      reason: input.reason.trim(),
    },
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
  const parsed = parseLifecycle(
    payload,
    subscriberId,
    tenantId,
    responseVersion,
  );
  if (parsed.stage !== input.stage || parsed.score !== input.score) {
    throw new SubscriberIdentityContractError();
  }
  return parsed;
}
