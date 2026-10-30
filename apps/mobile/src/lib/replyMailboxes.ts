/**
 * lib/replyMailboxes.ts — the reply-capture registry, as a phone reads it.
 *
 * ── WHAT SHIPS HERE, AND WHAT DOES NOT ─────────────────────────────────────
 * List, enable, disable, delete. NOT create.
 *
 * Registering a mailbox is a six-field form including TWO secret references,
 * and getting a reference wrong points the poller at nothing while looking
 * configured. That is desk work. Everything else is a switch:
 *
 *   disable  the stopping half — "this mailbox is erroring every minute, stop
 *            it" is the reason somebody reaches for a phone at all
 *   enable   re-arming a mailbox somebody paused; no typing, no secret
 *   delete   removing a registration outright, which is destructive for a
 *            reason worth stating loudly (below)
 *
 * This follows `lib/stoppingHalfPolicy`, and it is the case that policy was
 * written for: "there is no desk surface yet" is an argument for shipping the
 * stopping half SOONER, because a capability nobody can stop is worse than one
 * nobody can start.
 *
 * No react-native imports — imported by node-run vitest.
 */
import { relativeTime } from "./format";

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
  lastPolledAt: string;
  lastError: string;
  securityQuarantinedAt: string;
  securityQuarantineReason: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= max
  );
}

function timestamp(value: unknown): value is string {
  return (
    boundedText(value, 128) &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * The wire row once every field has been checked. A type alias rather than an
 * interface so it can narrow a `Record<string, unknown>`.
 */
type ReplyMailboxWire = {
  id: string;
  label: string;
  host: string;
  port: number;
  use_tls: boolean;
  folder: string;
  username_secret_ref: string;
  password_secret_ref: string;
  enabled: boolean;
  last_polled_at?: unknown;
  last_error?: unknown;
  security_quarantined_at?: unknown;
  security_quarantine_reason?: unknown;
};

/** Identity: a real id, and a label and host worth rendering. */
function identityValid(raw: Record<string, unknown>): boolean {
  return (
    boundedText(raw.id, 36) &&
    UUID.test(raw.id) &&
    boundedText(raw.label, 200) &&
    boundedText(raw.host, 255)
  );
}

/** Where the poller connects: port, TLS flag, folder. */
function endpointValid(raw: Record<string, unknown>): boolean {
  if (!Number.isSafeInteger(raw.port)) return false;
  const port = Number(raw.port);
  if (port < 1 || port > 65_535) return false;
  return typeof raw.use_tls === "boolean" && boundedText(raw.folder, 255);
}

/** Both credentials must be secret REFERENCES in a scheme the server resolves. */
function secretRefsValid(raw: Record<string, unknown>): boolean {
  return (
    boundedText(raw.username_secret_ref, 1_000) &&
    SECRET_REFERENCE.test(raw.username_secret_ref) &&
    boundedText(raw.password_secret_ref, 1_000) &&
    SECRET_REFERENCE.test(raw.password_secret_ref)
  );
}

/** The enabled flag plus the two optional poll-outcome fields. */
function pollStateValid(raw: Record<string, unknown>): boolean {
  if (typeof raw.enabled !== "boolean") return false;
  const polledAtValid =
    raw.last_polled_at === undefined || timestamp(raw.last_polled_at);
  const errorValid =
    raw.last_error === undefined ||
    (typeof raw.last_error === "string" &&
      Array.from(raw.last_error).length <= 2_000);
  return polledAtValid && errorValid;
}

/**
 * The quarantine timestamp and its reason travel together or not at all, and a
 * quarantined registration may never also arrive enabled.
 */
function quarantineValid(raw: Record<string, unknown>): boolean {
  const quarantinedAt = raw.security_quarantined_at;
  const quarantineReason = raw.security_quarantine_reason;
  const quarantinePairValid =
    (quarantinedAt === undefined && quarantineReason === undefined) ||
    (timestamp(quarantinedAt) &&
      quarantineReason === "legacy_insecure_transport_or_secret_reference");
  if (!quarantinePairValid) return false;
  return quarantinedAt === undefined || !raw.enabled;
}

function isReplyMailboxWire(
  raw: Record<string, unknown>,
): raw is ReplyMailboxWire {
  return (
    identityValid(raw) &&
    endpointValid(raw) &&
    secretRefsValid(raw) &&
    pollStateValid(raw) &&
    quarantineValid(raw)
  );
}

/** Strict decoder: malformed rows fail the read instead of disappearing. */
export function toReplyMailbox(raw: unknown): ReplyMailbox {
  if (
    !isRecord(raw) ||
    !Object.keys(raw).every((key) => MAILBOX_KEYS.has(key)) ||
    !isReplyMailboxWire(raw)
  ) {
    throw new Error("Invalid reply mailbox response");
  }
  return {
    id: raw.id,
    label: raw.label,
    host: raw.host,
    port: raw.port,
    useTLS: raw.use_tls,
    folder: raw.folder,
    usernameSecretRef: raw.username_secret_ref,
    passwordSecretRef: raw.password_secret_ref,
    enabled: raw.enabled,
    lastPolledAt:
      typeof raw.last_polled_at === "string" ? raw.last_polled_at : "",
    lastError: typeof raw.last_error === "string" ? raw.last_error : "",
    securityQuarantinedAt:
      typeof raw.security_quarantined_at === "string"
        ? raw.security_quarantined_at
        : "",
    securityQuarantineReason:
      typeof raw.security_quarantine_reason === "string"
        ? raw.security_quarantine_reason
        : "",
  };
}

export function decodeReplyMailboxList(raw: unknown): ReplyMailbox[] {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 1 ||
    !Array.isArray(raw.items)
  ) {
    throw new Error("Invalid reply mailbox list response");
  }
  const rows = raw.items.map(toReplyMailbox);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Invalid reply mailbox list response: duplicate id");
  }
  return rows;
}

export type MailboxHealth =
  | "quarantined"
  | "failing"
  | "polling"
  | "paused"
  | "never_polled";

/**
 * The one fact that decides what an operator does next.
 *
 * FAILING OUTRANKS EVERYTHING, including paused: a mailbox that errored and was
 * then disabled still needs its error read, and rendering it as a calm "paused"
 * hides the reason it was paused. `last_error` is only cleared by a successful
 * poll, so a non-empty error on a disabled mailbox is real history.
 */
export function mailboxHealth(mailbox: ReplyMailbox): MailboxHealth {
  if (mailbox.securityQuarantinedAt.trim()) return "quarantined";
  if (mailbox.lastError.trim()) return "failing";
  if (!mailbox.enabled) return "paused";
  return mailbox.lastPolledAt.trim() ? "polling" : "never_polled";
}

/**
 * The status line.
 *
 * `never_polled` is deliberately distinct from `polling`: a mailbox enabled ten
 * minutes ago that has not yet run is not the same as one running fine, and
 * collapsing them would let a misconfigured registration look healthy for as
 * long as nobody checked the timestamp.
 */
export function mailboxSummary(
  mailbox: ReplyMailbox,
  now: number = Date.now(),
): string {
  const where = `${mailbox.host}${mailbox.port ? `:${mailbox.port}` : ""} · ${mailbox.folder}`;
  switch (mailboxHealth(mailbox)) {
    case "quarantined":
      return `${where} — security-quarantined; replace this legacy registration before polling can resume.`;
    case "failing":
      // The server's own error text, verbatim. Paraphrasing an IMAP failure
      // ("check your settings") throws away the one string that says which of
      // six things is wrong.
      return `${where} — last poll failed: ${mailbox.lastError.trim()}`;
    case "paused":
      return `${where} — paused, not polling.`;
    case "never_polled":
      return `${where} — enabled, but has never completed a poll.`;
    default:
      return `${where} — last polled ${relativeTime(mailbox.lastPolledAt, { fallback: "recently" })}.`;
  }
}

/** Failing and never-polled both want attention; polling and paused do not. */
export function mailboxTone(
  mailbox: ReplyMailbox,
): "warning" | "success" | "neutral" {
  const health = mailboxHealth(mailbox);
  if (
    health === "quarantined" ||
    health === "failing" ||
    health === "never_polled"
  ) {
    return "warning";
  }
  return health === "polling" ? "success" : "neutral";
}

/**
 * The consequence of deleting a registration.
 *
 * Losing the poll CURSOR means a later replacement is treated as never-polled.
 * Its first poll anchors at the mailbox's then-current high-water mark, so
 * replies that arrive while no registration exists can be skipped.
 */
export function mailboxDeleteConsequence(mailbox: ReplyMailbox): string {
  return (
    `Removing ${mailbox.label} also discards its poll cursor. If it is ever ` +
    `registered again, its first poll anchors at the mailbox's then-current ` +
    `high-water mark, so replies received while it was absent may be skipped. ` +
    `Disable it instead if you only want polling to stop.`
  );
}

/** Registering is a desk job; say so where somebody would look for the button. */
export const MAILBOX_CREATE_NOTICE =
  "Adding a disabled mailbox requires tenant-scoped secret references, so use the web or desktop administrator surface. Everything else can be done here.";
