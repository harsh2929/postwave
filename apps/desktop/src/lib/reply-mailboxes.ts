// SPDX-License-Identifier: AGPL-3.0-only

import { apiRequest } from "./api-client";

const BASE = "/api/v1/replies/mailboxes";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SECRET_SUFFIX = /^[A-Z0-9_]{1,128}$/u;
const SECRET_REFERENCE = /^(env|env-json|aws-sm|vault|gcp-sm|azure-kv):(?:\/\/)?[^\s]+$/u;
const MAILBOX_KEYS = new Set([
  "id",
  "label",
  "host",
  "port",
  "use_tls",
  "folder",
  "username_secret_ref",
  "password_secret_ref",
  "enabled",
  "last_polled_at",
  "last_error",
  "security_quarantined_at",
  "security_quarantine_reason",
]);
const ONLINE_ONCE = { requireOnline: true, maxAttempts: 1 } as const;

export interface ReplyMailbox {
  id: string;
  label: string;
  host: string;
  port: number;
  useTLS: boolean;
  folder: string;
  usernameSecretRef: string;
  passwordSecretRef: string;
  enabled: boolean;
  lastPolledAt?: string;
  lastError?: string;
  securityQuarantinedAt?: string;
  securityQuarantineReason?:
    | "legacy_insecure_transport_or_secret_reference";
}

export interface ReplyMailboxCreateInput {
  label: string;
  host: string;
  folder?: string;
  usernameSecretRef: string;
  passwordSecretRef: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  max: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length <= max &&
    (allowEmpty || value.trim().length > 0)
  );
}

function optionalTimestamp(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (boundedText(value, 128) &&
      /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
      Number.isFinite(Date.parse(value)))
  );
}

export function decodeReplyMailbox(value: unknown): ReplyMailbox {
  if (
    !record(value) ||
    !Object.keys(value).every((key) => MAILBOX_KEYS.has(key))
  ) {
    throw new Error("Invalid reply mailbox response");
  }
  const quarantinedAt = value.security_quarantined_at;
  const quarantineReason = value.security_quarantine_reason;
  const quarantinePairValid =
    (quarantinedAt === undefined && quarantineReason === undefined) ||
    (optionalTimestamp(quarantinedAt) &&
      quarantinedAt !== undefined &&
      quarantineReason === "legacy_insecure_transport_or_secret_reference");
  if (
    !boundedText(value.id, 36) ||
    !UUID.test(value.id) ||
    !boundedText(value.label, 200) ||
    !boundedText(value.host, 255) ||
    !Number.isSafeInteger(value.port) ||
    Number(value.port) < 1 ||
    Number(value.port) > 65_535 ||
    typeof value.use_tls !== "boolean" ||
    !boundedText(value.folder, 255) ||
    !boundedText(value.username_secret_ref, 1_000) ||
    !SECRET_REFERENCE.test(value.username_secret_ref) ||
    !boundedText(value.password_secret_ref, 1_000) ||
    !SECRET_REFERENCE.test(value.password_secret_ref) ||
    typeof value.enabled !== "boolean" ||
    !optionalTimestamp(value.last_polled_at) ||
    !(value.last_error === undefined || boundedText(value.last_error, 2_000)) ||
    !quarantinePairValid ||
    (quarantinedAt !== undefined && value.enabled)
  ) {
    throw new Error("Invalid reply mailbox response");
  }
  return {
    id: value.id,
    label: value.label,
    host: value.host,
    port: value.port as number,
    useTLS: value.use_tls,
    folder: value.folder,
    usernameSecretRef: value.username_secret_ref,
    passwordSecretRef: value.password_secret_ref,
    enabled: value.enabled,
    ...(value.last_polled_at === undefined
      ? {}
      : { lastPolledAt: value.last_polled_at }),
    ...(value.last_error === undefined ? {} : { lastError: value.last_error }),
    ...(quarantinedAt === undefined
      ? {}
      : {
          securityQuarantinedAt: quarantinedAt,
          securityQuarantineReason: quarantineReason,
        }),
  };
}

export function decodeReplyMailboxList(value: unknown): ReplyMailbox[] {
  if (
    !record(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.items)
  ) {
    throw new Error("Invalid reply mailbox list response");
  }
  const rows = value.items.map(decodeReplyMailbox);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Invalid reply mailbox list response: duplicate id");
  }
  return rows;
}

export function tenantMailboxSecretPrefix(tenantId: string): string {
  const normalized = tenantId.trim().toLowerCase();
  if (!UUID.test(normalized)) throw new Error("A verified workspace UUID is required");
  return `env:POSTWAVE_REPLY_IMAP_TENANT_${normalized.replaceAll("-", "").toUpperCase()}_`;
}

export function buildReplyMailboxCreateInput(
  input: ReplyMailboxCreateInput,
  tenantId: string,
) {
  const label = input.label.trim();
  const host = input.host.trim();
  const folder = input.folder?.trim() || "INBOX";
  const prefix = tenantMailboxSecretPrefix(tenantId);
  const tenantRef = (value: string) =>
    value === value.trim() &&
    value.startsWith(prefix) &&
    SECRET_SUFFIX.test(value.slice(prefix.length));
  if (!label || Array.from(label).length > 200) {
    throw new Error("Mailbox label must contain 1–200 characters.");
  }
  if (
    !host ||
    Array.from(host).length < 3 ||
    Array.from(host).length > 253 ||
    /[\s/\\@?#\[\]]/u.test(host)
  ) {
    throw new Error("Enter a valid public IMAP host without a port or URL path.");
  }
  if (Array.from(folder).length > 255) {
    throw new Error("Folder must be 255 characters or fewer.");
  }
  if (!tenantRef(input.usernameSecretRef)) {
    throw new Error(
      "Username must be a reference in this workspace's IMAP secret namespace, never a credential value.",
    );
  }
  if (!tenantRef(input.passwordSecretRef)) {
    throw new Error(
      "Password must be a reference in this workspace's IMAP secret namespace, never a credential value.",
    );
  }
  return {
    label,
    host,
    port: 993 as const,
    use_tls: true as const,
    folder,
    username_secret_ref: input.usernameSecretRef,
    password_secret_ref: input.passwordSecretRef,
  };
}

function safeRequestError(
  error: { code?: string; status?: number } | undefined,
  fallback: string,
): Error {
  if (error?.code === "mailbox_security_quarantined") {
    return new Error(
      "This legacy mailbox is security-quarantined. Replace it with a TLS/tenant-reference registration.",
    );
  }
  if (error?.code === "mailbox_exists") {
    return new Error("That host, folder, and username reference is already registered.");
  }
  if (error?.status === 403) return new Error("Admin access is required.");
  return new Error(fallback);
}

export async function listReplyMailboxes(signal?: AbortSignal): Promise<ReplyMailbox[]> {
  const result = await apiRequest<unknown>(
    BASE,
    { method: "GET", cache: "no-store" },
    { ...ONLINE_ONCE, signal },
  );
  if (result.error) throw safeRequestError(result.error, "Reply mailboxes could not be verified.");
  return decodeReplyMailboxList(result.data);
}

export async function createReplyMailbox(
  input: ReplyMailboxCreateInput,
  tenantId: string,
  signal?: AbortSignal,
): Promise<ReplyMailbox> {
  const result = await apiRequest<unknown>(
    BASE,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(buildReplyMailboxCreateInput(input, tenantId)),
    },
    { ...ONLINE_ONCE, signal },
  );
  if (result.error) throw safeRequestError(result.error, "Mailbox registration could not be confirmed.");
  return decodeReplyMailbox(result.data);
}

export async function setReplyMailboxEnabled(
  id: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<ReplyMailbox> {
  if (!UUID.test(id)) throw new Error("Invalid reply mailbox id");
  const result = await apiRequest<unknown>(
    `${BASE}/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
    { method: "POST", cache: "no-store" },
    { ...ONLINE_ONCE, signal },
  );
  if (result.error) {
    throw safeRequestError(
      result.error,
      `Mailbox ${enabled ? "enable" : "disable"} could not be confirmed.`,
    );
  }
  return decodeReplyMailbox(result.data);
}

export async function deleteReplyMailbox(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!UUID.test(id)) throw new Error("Invalid reply mailbox id");
  const result = await apiRequest<unknown>(
    `${BASE}/${encodeURIComponent(id)}`,
    { method: "DELETE", cache: "no-store" },
    { ...ONLINE_ONCE, signal },
  );
  if (result.error) throw safeRequestError(result.error, "Mailbox deletion could not be confirmed.");
  if (result.data !== undefined) throw new Error("Invalid mailbox deletion response");
}
