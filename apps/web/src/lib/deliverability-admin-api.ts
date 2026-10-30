// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

const MAX_ROWS = 1_000;
const MAX_TEXT = 16_384;
const MUTATION_OPTIONS = { requireOnline: true, maxAttempts: 1 } as const;

export const DELIVERABILITY_PROVIDERS = [
  "postmark",
  "mailgun",
  "ses",
  "sendgrid",
  "resend",
  "sparkpost",
  "mailersend",
  "mailchimp",
] as const;
export type DeliverabilityProvider = (typeof DELIVERABILITY_PROVIDERS)[number];

export const FREQUENCY_CHANNELS = ["email", "sms", "push"] as const;
export type FrequencyChannel = (typeof FREQUENCY_CHANNELS)[number];

export interface DeliverabilityProviderConfig {
  id: string;
  tenant_id: string;
  provider: DeliverabilityProvider;
  display_name: string;
  config: Record<string, unknown>;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DeliverabilityProviderInput {
  provider: DeliverabilityProvider;
  display_name: string;
  config: Record<string, unknown>;
  active: boolean;
}

export interface BlocklistAutoSuppressState {
  auto_suppress: boolean;
  eligible_now: number;
  active_suppressions: number;
  observed_at: string;
}

export interface FrequencyCapRule {
  id: string;
  label: string;
  max_sends: number;
  window_hours: number;
  active: boolean;
  /** Empty on an old row means a global rule across every channel. */
  channels: FrequencyChannel[];
  created_at: string;
  updated_at: string;
}

export interface FrequencyCapInput {
  label: string;
  max_sends: number;
  window_hours: number;
  active: boolean;
  channels?: FrequencyChannel[];
}

export interface FrequencyMutationOptions {
  /** Caller-owned key for retrying this exact logical write. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(
  value: unknown,
  max = MAX_TEXT,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0)
  );
}

function timestamp(value: unknown): value is string {
  return (
    text(value, 128) &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function count(value: unknown, max: number): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max
  );
}

function parseProvider(value: unknown): DeliverabilityProviderConfig {
  if (!record(value))
    throw new Error("Invalid deliverability provider response");
  const provider = value.provider;
  if (
    !text(value.id, 128) ||
    !text(value.tenant_id, 128) ||
    !text(provider, 32) ||
    !(DELIVERABILITY_PROVIDERS as readonly string[]).includes(provider) ||
    !(
      value.display_name === undefined || text(value.display_name, 160, true)
    ) ||
    !(value.config === undefined || record(value.config)) ||
    typeof value.active !== "boolean" ||
    !timestamp(value.created_at) ||
    !timestamp(value.updated_at)
  ) {
    throw new Error("Invalid deliverability provider response");
  }
  const config = value.config ?? {};
  if (Object.keys(config).length > 128) {
    throw new Error("Invalid deliverability provider response");
  }
  return {
    id: value.id,
    tenant_id: value.tenant_id,
    provider: provider as DeliverabilityProvider,
    display_name: value.display_name ?? "",
    config,
    active: value.active,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function parseProviderEnvelope(value: unknown): DeliverabilityProviderConfig {
  if (!record(value))
    throw new Error("Invalid deliverability provider response");
  return parseProvider(value.item);
}

export async function listDeliverabilityProviders(
  options: {
    signal?: AbortSignal;
    fresh?: boolean;
  } = {},
): Promise<DeliverabilityProviderConfig[]> {
  const response = await api.get<unknown>("/api/v1/deliverability/providers", {
    signal: options.signal,
    ...(options.fresh ? MUTATION_OPTIONS : {}),
  });
  if (
    !record(response) ||
    !Array.isArray(response.items) ||
    response.items.length > MAX_ROWS
  ) {
    throw new Error("Invalid deliverability providers response");
  }
  return response.items.map(parseProvider);
}

export async function saveDeliverabilityProvider(
  input: DeliverabilityProviderInput,
  options: { id?: string; signal?: AbortSignal } = {},
): Promise<DeliverabilityProviderConfig> {
  const response = options.id
    ? await api.patch<unknown>(
        `/api/v1/deliverability/providers/${encodeURIComponent(options.id)}`,
        input,
        { ...MUTATION_OPTIONS, signal: options.signal },
      )
    : await api.post<unknown>("/api/v1/deliverability/providers", input, {
        ...MUTATION_OPTIONS,
        signal: options.signal,
      });
  return parseProviderEnvelope(response);
}

export async function deleteDeliverabilityProvider(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await api.delete<unknown>(
    `/api/v1/deliverability/providers/${encodeURIComponent(id)}`,
    { ...MUTATION_OPTIONS, signal },
  );
  if (!record(response) || response.ok !== true) {
    throw new Error("Provider removal was not confirmed by the server");
  }
}

export function sameProviderRevision(
  left: DeliverabilityProviderConfig,
  right: DeliverabilityProviderConfig,
): boolean {
  return (
    left.id === right.id &&
    left.tenant_id === right.tenant_id &&
    left.provider === right.provider &&
    left.updated_at === right.updated_at &&
    left.active === right.active &&
    left.display_name === right.display_name
  );
}

function parseBlocklistState(value: unknown): BlocklistAutoSuppressState {
  if (
    !record(value) ||
    typeof value.auto_suppress !== "boolean" ||
    !count(value.eligible_now, Number.MAX_SAFE_INTEGER) ||
    !count(value.active_suppressions, Number.MAX_SAFE_INTEGER) ||
    !timestamp(value.observed_at)
  ) {
    throw new Error("Invalid blocklist auto-containment response");
  }
  return {
    auto_suppress: value.auto_suppress,
    eligible_now: value.eligible_now,
    active_suppressions: value.active_suppressions,
    observed_at: value.observed_at,
  };
}

export async function getBlocklistAutoSuppress(
  options: {
    signal?: AbortSignal;
    fresh?: boolean;
  } = {},
): Promise<BlocklistAutoSuppressState> {
  return parseBlocklistState(
    await api.get<unknown>("/api/v1/blocklist/auto-suppress", {
      signal: options.signal,
      ...(options.fresh ? MUTATION_OPTIONS : {}),
    }),
  );
}

export async function setBlocklistAutoSuppress(
  autoSuppress: boolean,
  signal?: AbortSignal,
): Promise<BlocklistAutoSuppressState> {
  return parseBlocklistState(
    await api.patch<unknown>(
      "/api/v1/blocklist/auto-suppress",
      { auto_suppress: autoSuppress },
      { ...MUTATION_OPTIONS, signal },
    ),
  );
}

function parseFrequencyRule(value: unknown): FrequencyCapRule {
  if (!record(value)) throw new Error("Invalid frequency-cap response");
  const channels = value.channels;
  if (
    !text(value.id, 128) ||
    !text(value.label, 160) ||
    !count(value.max_sends, 1_000) ||
    Number(value.max_sends) < 1 ||
    !count(value.window_hours, 720) ||
    Number(value.window_hours) < 1 ||
    typeof value.active !== "boolean" ||
    !Array.isArray(channels) ||
    channels.length > FREQUENCY_CHANNELS.length ||
    new Set(channels).size !== channels.length ||
    !channels.every(
      (channel) =>
        typeof channel === "string" &&
        (FREQUENCY_CHANNELS as readonly string[]).includes(channel),
    ) ||
    !timestamp(value.created_at) ||
    !timestamp(value.updated_at)
  ) {
    throw new Error("Invalid frequency-cap response");
  }
  return {
    id: value.id,
    label: value.label,
    max_sends: value.max_sends,
    window_hours: value.window_hours,
    active: value.active,
    channels: channels as FrequencyChannel[],
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

export async function listFrequencyCapRules(
  options: {
    signal?: AbortSignal;
    fresh?: boolean;
  } = {},
): Promise<FrequencyCapRule[]> {
  const response = await api.get<unknown>("/api/v1/sending/frequency-caps", {
    signal: options.signal,
    ...(options.fresh ? MUTATION_OPTIONS : {}),
  });
  if (
    !record(response) ||
    !Array.isArray(response.rules) ||
    response.rules.length > MAX_ROWS
  ) {
    throw new Error("Invalid frequency-caps response");
  }
  const rules = response.rules.map(parseFrequencyRule);
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new Error("Invalid frequency-caps response");
  }
  return rules;
}

function parseFrequencyMutation(value: unknown): FrequencyCapRule {
  if (!record(value)) throw new Error("Invalid frequency-cap response");
  return parseFrequencyRule(value.rule);
}

export async function createFrequencyCapRule(
  input: FrequencyCapInput,
  options: FrequencyMutationOptions,
): Promise<FrequencyCapRule> {
  return parseFrequencyMutation(
    await api.post<unknown>("/api/v1/sending/frequency-caps", input, {
      ...MUTATION_OPTIONS,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    }),
  );
}

export async function updateFrequencyCapRule(
  id: string,
  input: Partial<FrequencyCapInput>,
  expectedUpdatedAt: string,
  options: FrequencyMutationOptions,
): Promise<FrequencyCapRule> {
  return parseFrequencyMutation(
    await api.patch<unknown>(
      `/api/v1/sending/frequency-caps/${encodeURIComponent(id)}`,
      { ...input, expected_updated_at: expectedUpdatedAt },
      {
        ...MUTATION_OPTIONS,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    ),
  );
}

export async function deleteFrequencyCapRule(
  id: string,
  expectedUpdatedAt: string,
  options: FrequencyMutationOptions,
): Promise<void> {
  // The canonical enforced route intentionally returns 204 No Content.
  await api.delete<void>(
    `/api/v1/sending/frequency-caps/${encodeURIComponent(id)}`,
    {
      ...MUTATION_OPTIONS,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
      body: { expected_updated_at: expectedUpdatedAt },
    },
  );
}

export function sameFrequencyCapRevision(
  left: FrequencyCapRule,
  right: FrequencyCapRule,
): boolean {
  return left.id === right.id && left.updated_at === right.updated_at;
}

export const REDACTED_PROVIDER_VALUE = "redacted";

export function providerSupportsSuppressionMirror(provider: string): boolean {
  return provider === "mailchimp" || provider === "sendgrid";
}

export function providerSecretState(config: Record<string, unknown>): {
  webhookTokenSet: boolean;
  credentialRefSet: boolean;
  legacyRawCredentialSet: boolean;
} {
  const set = (key: string) =>
    typeof config[key] === "string" && String(config[key]).trim().length > 0;
  return {
    webhookTokenSet: set("webhook_token_hash") || set("webhook_token"),
    credentialRefSet: set("credential_ref"),
    legacyRawCredentialSet: set("api_key"),
  };
}

export function webhookTokenError(raw: string): string | null {
  const token = raw.trim();
  if (!token) return null;
  if (
    token.length < 32 ||
    token.length > 512 ||
    /\s/u.test(token) ||
    !/^[\x21-\x7e]+$/u.test(token)
  ) {
    return "Use a 32-512 character, whitespace-free high-entropy token.";
  }
  return null;
}

export function credentialReferenceError(raw: string): string | null {
  const ref = raw.trim();
  if (!ref) return null;
  const lower = ref.toLowerCase();
  const forbiddenPrefix = [
    "{",
    "[",
    "bearer",
    "basic",
    "sk_",
    "sg.",
    "xox",
    "eyj",
  ].some((prefix) => lower.startsWith(prefix));
  const validSegments = ref
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (
    ref.length > 512 ||
    /\s/u.test(ref) ||
    forbiddenPrefix ||
    lower.startsWith("tenants/") ||
    (!ref.includes("/") && !lower.startsWith("cred_")) ||
    !/^[A-Za-z0-9/_+=.@-]+$/u.test(ref) ||
    !validSegments ||
    ref.startsWith("/") ||
    ref.endsWith("/")
  ) {
    return "Use a tenant-relative runtime-secret name such as deliverability/sendgrid; do not paste an API key.";
  }
  return null;
}

export function generateWebhookToken(): string {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("Secure random generation is unavailable in this browser");
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Sparse config: omitted write-only fields are preserved by the server merge. */
export function buildProviderConfigInput(input: {
  webhookToken: string;
  credentialReference: string;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const token = input.webhookToken.trim();
  const reference = input.credentialReference.trim();
  if (token && token !== REDACTED_PROVIDER_VALUE) config.webhook_token = token;
  if (reference && reference !== REDACTED_PROVIDER_VALUE) {
    config.credential_ref = reference;
  }
  return config;
}
