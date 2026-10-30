/**
 * api/outboundWebhooks.ts — the delivery-health half of outbound webhooks.
 *
 * Creating and deleting endpoints already lived in `api/settings.ts`; what the
 * phone was missing is the part an on-call operator actually needs at 3am:
 *
 *   "Are our webhooks delivering right now, and can I replay the ones that
 *    failed?"
 *
 * Mobile answered only "here are the webhooks that exist" — a single
 * `consecutive_failures` line and no delivery history, no health rollup, no
 * replay, and no way to bring back an endpoint the SERVER auto-disabled.
 *
 * Endpoints used (all verified present in the OpenAPI document and in
 * apps/api/internal/outbound_webhooks):
 *   GET  /api/v1/outbound-webhooks/deliveries?status=&limit=
 *   POST /api/v1/outbound-webhooks/deliveries/{id}/replay   (Idempotency-Key REQUIRED)
 *   GET  /api/v1/outbound-webhooks/{id}/health
 *   POST /api/v1/outbound-webhooks/{id}/re-enable
 *   PATCH /api/v1/outbound-webhooks/{id}                     ({active} — pause/resume)
 *   PATCH /api/v1/outbound-webhooks/{id}                     ({url,description,events})
 *   POST /api/v1/outbound-webhooks/{id}/rotate-secret
 *
 * All of these are writes-or-diagnostics against live state, so none of them
 * is queued for offline replay: a replay fired from a queue hours later would
 * re-deliver an event the operator has long since dealt with.
 */
import * as Crypto from "expo-crypto";

import { rawRequest, type AIApiError } from "./request";

/** Status values the server accepts and returns for a delivery. */
export type DeliveryStatus =
  | "pending"
  | "delivered"
  | "exhausted"
  | "skipped"
  | "failing";

/** One row of GET /api/v1/outbound-webhooks/deliveries. */
export interface OutboundDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  attempt_count: number;
  status: string;
  next_attempt_at?: string | undefined;
  last_status_code?: number | undefined;
  last_error?: string | undefined;
  created_at: string;
  delivered_at?: string | undefined;
}

/** GET /api/v1/outbound-webhooks/{id}/health — trailing 24h. */
export interface OutboundHealth {
  deliveries_total: number;
  deliveries_succeeded: number;
  deliveries_failed: number;
  deliveries_pending: number;
  deliveries_skipped: number;
  consecutive_failures: number;
  auto_disabled: boolean;
  disabled_reason?: string | undefined;
  last_succeeded_at?: string | undefined;
  last_failed_at?: string | undefined;
}

class OutboundWebhookError extends Error {
  readonly status: number;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "OutboundWebhookError";
    this.status = error.status;
  }
}

async function call<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const res = await rawRequest<T>(
    method,
    path,
    body,
    idempotencyKey ? { idempotencyKey } : undefined,
  );
  if (res.error) throw new OutboundWebhookError(res.error, label);
  if (res.data == null) throw new Error(`${label} returned no data.`);
  return res.data;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeDelivery(entry: unknown): OutboundDelivery | null {
  if (!entry || typeof entry !== "object") return null;
  const r = entry as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const code =
    typeof r.last_status_code === "number" ? r.last_status_code : undefined;
  return {
    id,
    webhook_id: str(r.webhook_id),
    event_type: str(r.event_type) || "unknown",
    attempt_count: int(r.attempt_count),
    status: str(r.status) || "pending",
    ...(optionalStr(r.next_attempt_at)
      ? { next_attempt_at: optionalStr(r.next_attempt_at) }
      : {}),
    ...(code !== undefined ? { last_status_code: code } : {}),
    ...(optionalStr(r.last_error) ? { last_error: optionalStr(r.last_error) } : {}),
    created_at: str(r.created_at),
    ...(optionalStr(r.delivered_at)
      ? { delivered_at: optionalStr(r.delivered_at) }
      : {}),
  };
}

/**
 * Recent deliveries across every webhook. `status` maps straight onto the
 * server's filter; "failing" is the one an operator opens this for.
 */
export async function listDeliveries(options?: {
  status?: DeliveryStatus | undefined;
  limit?: number;
}): Promise<OutboundDelivery[]> {
  const params = new URLSearchParams();
  if (options?.status) params.set("status", options.status);
  // Server caps limit at 500; 100 is its own default and plenty for a phone.
  params.set("limit", String(Math.min(Math.max(options?.limit ?? 50, 1), 500)));
  const res = await call<{ deliveries?: unknown } | unknown[]>(
    "GET",
    `/api/v1/outbound-webhooks/deliveries?${params.toString()}`,
    "Loading webhook deliveries",
  );
  const raw = Array.isArray(res)
    ? res
    : Array.isArray(res.deliveries)
      ? res.deliveries
      : [];
  const out: OutboundDelivery[] = [];
  for (const entry of raw) {
    const row = normalizeDelivery(entry);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Replay one delivery. The server REQUIRES an Idempotency-Key and 409s if the
 * same key is reused for a different delivery, so we mint a fresh one per
 * attempt — a double-tap therefore produces two honest attempts rather than a
 * silent no-op, and a network retry of the SAME attempt is deduplicated.
 */
export async function replayDelivery(id: string): Promise<void> {
  await call<unknown>(
    "POST",
    `/api/v1/outbound-webhooks/deliveries/${encodeURIComponent(id)}/replay`,
    "Replaying the delivery",
    {},
    Crypto.randomUUID(),
  );
}

export async function fetchWebhookHealth(id: string): Promise<OutboundHealth> {
  const r = await call<Record<string, unknown>>(
    "GET",
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/health`,
    "Loading webhook health",
  );
  return {
    deliveries_total: int(r.deliveries_total),
    deliveries_succeeded: int(r.deliveries_succeeded),
    deliveries_failed: int(r.deliveries_failed),
    deliveries_pending: int(r.deliveries_pending),
    deliveries_skipped: int(r.deliveries_skipped),
    consecutive_failures: int(r.consecutive_failures),
    auto_disabled: r.auto_disabled === true,
    ...(optionalStr(r.disabled_reason)
      ? { disabled_reason: optionalStr(r.disabled_reason) }
      : {}),
    ...(optionalStr(r.last_succeeded_at)
      ? { last_succeeded_at: optionalStr(r.last_succeeded_at) }
      : {}),
    ...(optionalStr(r.last_failed_at)
      ? { last_failed_at: optionalStr(r.last_failed_at) }
      : {}),
  };
}

/**
 * Bring back an endpoint the delivery worker auto-disabled after repeated
 * failures. Distinct from a resume: the server re-validates destination and
 * receiver auth and will 409 with an actionable reason if either is still
 * broken, which we surface verbatim.
 */
export async function reEnableOutboundWebhook(id: string): Promise<void> {
  await call<unknown>(
    "POST",
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/re-enable`,
    "Re-enabling the webhook",
    {},
  );
}

/**
 * Pause or resume delivery. Pause is the REVERSIBLE stop — history, delivery
 * rows and signing configuration are all retained — which is why the phone
 * offers it as the primary action and leaves the irreversible delete to a
 * bigger screen.
 */
export async function setOutboundWebhookActive(
  id: string,
  active: boolean,
): Promise<void> {
  await call<unknown>(
    "PATCH",
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`,
    active ? "Resuming the webhook" : "Pausing the webhook",
    { active },
  );
}

/**
 * Change where an endpoint points and what it is subscribed to.
 *
 * The same PATCH as pause/resume, with the three fields a phone can edit
 * honestly (`UpdateInput` also carries receiver auth, filter expressions and
 * transform templates — none of which belong in a phone form, and all of
 * which are LEFT UNTOUCHED by omitting them; the server's UnmarshalJSON
 * distinguishes an omitted field from a null one precisely so a partial
 * update cannot silently clear credentials).
 *
 * The server 409s when the new destination is unreachable-by-policy and 400s
 * on a redacted or invalid URL; both messages name the repair, so callers
 * surface them verbatim.
 */
export async function updateOutboundWebhook(
  id: string,
  patch: { url: string; description: string; events: string[] },
): Promise<void> {
  await call<unknown>(
    "PATCH",
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`,
    "Updating the webhook",
    {
      url: patch.url,
      description: patch.description,
      events: patch.events,
    },
  );
}

/**
 * The result of a signing-key rotation. Exactly one of the two is populated,
 * decided by the endpoint's `signing_algorithm`:
 *
 *   hmac_sha256           → `signingSecret`, returned exactly once, never
 *                           retrievable again.
 *   ecdsa_p256 / ed25519  → `publicKeyPem`, which is NOT a secret and stays
 *                           readable on every subsequent list read
 *                           (`Webhook.signing_public_key`).
 *
 * Collapsing those two into one "here is your secret" card would be a lie in
 * one direction and a needless panic in the other, so the caller branches.
 */
export interface OutboundRotateResult {
  webhookId: string;
  signingSecret: string | null;
  publicKeyPem: string | null;
}

/**
 * Mint fresh signing material. The PREVIOUS key is demoted to the secondary
 * slot for a grace window (default 24h) during which deliveries are
 * dual-signed, so a receiver that has not picked up the new material keeps
 * verifying. That grace is what makes this safe to do from a phone.
 */
export async function rotateOutboundWebhookSecret(
  id: string,
): Promise<OutboundRotateResult> {
  const r = await call<Record<string, unknown>>(
    "POST",
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/rotate-secret`,
    "Rotating the signing key",
    {},
  );
  const webhook = r.webhook as Record<string, unknown> | undefined;
  const signingSecret = optionalStr(r.signing_secret) ?? null;
  const publicKeyPem = optionalStr(r.public_key_pem) ?? null;
  if (!signingSecret && !publicKeyPem) {
    // The old key is already demoted server-side at this point, so silence
    // here is not "nothing happened" — say so rather than showing success.
    throw new Error(
      "The key was rotated but the server returned no new material to save. Check the endpoint in the desktop app before the 24-hour grace window ends.",
    );
  }
  return {
    webhookId: str(webhook?.id) || id,
    signingSecret,
    publicKeyPem,
  };
}

/** The grace window the server gives the previous key, for the copy. */
export const OUTBOUND_ROTATION_GRACE_HOURS = 24;
