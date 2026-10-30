/**
 * api/inboundWebhooks.ts — the OPERATE half of inbound webhooks.
 *
 * The endpoint LIST (now `hooks/useInboundWebhookOps.useInboundWebhooks`)
 * was all mobile had. Everything an operator does
 * when an upstream integration goes wrong lived on desktop only:
 *
 *   "Is anything actually arriving on this endpoint, and did it verify?"
 *   "I fixed the trigger — re-fire the event that should have matched."
 *   "Turn this endpoint off / back on."
 *   "The secret leaked. Rotate it."
 *
 * Every route below was read in apps/api/internal/inbound_webhooks/ before it
 * was called; each is mounted with `apikeys.RequireScope(apikeys.ScopeAdmin)`
 * (handlers.go:151-169), which on a session cookie resolves to owner|admin —
 * matching the route's existing `minimumRole: "admin"`.
 *
 *   GET   /api/v1/inbound-webhooks/{id}/events?limit=&cursor=
 *   POST  /api/v1/inbound-webhooks/{id}/events/{event_id}/replay
 *   PATCH /api/v1/inbound-webhooks/{id}                    ({enabled})
 *   POST  /api/v1/inbound-webhooks/{id}/rotate
 *
 * NONE of these is queued for offline replay. A rotate or an event replay
 * fired from a queue hours later would act on state the operator has long
 * since moved past — and replay RE-EXECUTES trigger actions.
 */
import * as Crypto from "expo-crypto";

import { rawRequest, type AIApiError } from "./request";

/** One row of GET /api/v1/inbound-webhooks/{id}/events. */
export interface InboundEvent {
  /** bigint on the wire; kept as a string so no precision is lost. */
  id: string;
  endpointId: string;
  signatureValid: boolean;
  receivedAt: string;
  /** Retained raw body. Empty string when the row predates retention. */
  body: string;
  headers: Record<string, string>;
}

export interface InboundEventPage {
  items: InboundEvent[];
  /** Present when older events exist beyond this page. */
  nextCursor: string | null;
}

/** One entry of the replay response's `matches` array. */
export interface InboundReplayMatch {
  triggerId: string;
  name: string;
  actionType: string;
  executed: boolean;
  error?: string | undefined;
}

export interface InboundReplayResult {
  replayId: string;
  matches: InboundReplayMatch[];
}

export interface InboundRotateResult {
  /** Plaintext signing secret. The server returns it exactly once. */
  secret: string;
  endpointId: string;
}

export class InboundWebhookError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "InboundWebhookError";
    this.status = error.status;
    this.code = error.code;
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
  if (res.error) throw new InboundWebhookError(res.error, label);
  if (res.data == null) throw new Error(`${label} returned no data.`);
  return res.data;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function headerMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

/**
 * The event id is a Postgres bigint. Reading it as a JS number would round
 * above 2^53, and the replay path puts it straight back in a URL, so it is
 * normalised to a string and only ever compared as one.
 */
function eventId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function normalizeEvent(entry: unknown): InboundEvent | null {
  if (!entry || typeof entry !== "object") return null;
  const r = entry as Record<string, unknown>;
  const id = eventId(r.id);
  if (!id) return null;
  return {
    id,
    endpointId: str(r.endpoint_id),
    // Fail closed: anything but an explicit `true` is treated as unverified,
    // which is the state that DISABLES replay. A missing field must never
    // read as "verified".
    signatureValid: r.signature_valid === true,
    receivedAt: str(r.received_at),
    body: str(r.body),
    headers: headerMap(r.headers),
  };
}

/**
 * The most recent events for one endpoint, newest first.
 *
 * The server clamps `limit` to [1, 500] and paginates by cursor; the phone
 * asks for one page and says so, rather than pretending the feed is complete.
 */
export async function listInboundEvents(
  endpointId: string,
  limit = 50,
): Promise<InboundEventPage> {
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(limit, 1), 500)),
  });
  const res = await call<{ items?: unknown; next_cursor?: unknown }>(
    "GET",
    `/api/v1/inbound-webhooks/${encodeURIComponent(endpointId)}/events?${params.toString()}`,
    "Loading inbound events",
  );
  const raw = Array.isArray(res.items) ? res.items : [];
  const items: InboundEvent[] = [];
  for (const entry of raw) {
    const row = normalizeEvent(entry);
    if (row) items.push(row);
  }
  const cursor = str(res.next_cursor);
  return { items, nextCursor: cursor || null };
}

function normalizeMatch(entry: unknown): InboundReplayMatch | null {
  if (!entry || typeof entry !== "object") return null;
  const r = entry as Record<string, unknown>;
  const triggerId = str(r.trigger_id);
  if (!triggerId) return null;
  const error = str(r.error);
  return {
    triggerId,
    name: str(r.name) || "Unnamed trigger",
    actionType: str(r.action_type) || "unknown",
    executed: r.executed === true,
    ...(error ? { error } : {}),
  };
}

/**
 * Re-fire one stored event through the trigger evaluator.
 *
 * The server REQUIRES an Idempotency-Key (replay.go:112) and derives the
 * replay id from it, so a network retry of the same attempt is deduplicated
 * while a deliberate second tap is an honest second replay. It returns 202
 * with the trigger matches, which is what makes the "fix the trigger, re-fire
 * it" loop legible on a phone.
 */
export async function replayInboundEvent(
  endpointId: string,
  eventIdValue: string,
): Promise<InboundReplayResult> {
  const res = await call<{ replay_id?: unknown; matches?: unknown }>(
    "POST",
    `/api/v1/inbound-webhooks/${encodeURIComponent(endpointId)}/events/${encodeURIComponent(eventIdValue)}/replay`,
    "Replaying the event",
    {},
    Crypto.randomUUID(),
  );
  const rawMatches = Array.isArray(res.matches) ? res.matches : [];
  const matches: InboundReplayMatch[] = [];
  for (const entry of rawMatches) {
    const match = normalizeMatch(entry);
    if (match) matches.push(match);
  }
  return { replayId: str(res.replay_id), matches };
}

/**
 * Enable or disable ingest for one endpoint. A disabled endpoint answers the
 * public ingest route with 410 Gone (handlers.go Ingest), so this is the
 * reversible stop — the upstream system sees a hard refusal and its own
 * retry/alerting fires, which is exactly what an operator wants when a
 * partner is flooding them.
 */
export async function setInboundEndpointEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await call<unknown>(
    "PATCH",
    `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`,
    enabled ? "Enabling the endpoint" : "Disabling the endpoint",
    { enabled },
  );
}

/**
 * Mint a new signing secret. The previous secret is demoted to
 * `secondary_secret` with a 24h expiry (repo.go:365-401) and the ingest path
 * dual-verifies against it for that window (handlers.go:481), so rotating
 * does NOT immediately break the upstream sender — it gives you a day to
 * paste the new value in. The plaintext comes back exactly once.
 */
export async function rotateInboundSecret(
  id: string,
): Promise<InboundRotateResult> {
  const res = await call<{ secret?: unknown; endpoint?: unknown }>(
    "POST",
    `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/rotate`,
    "Rotating the signing secret",
    {},
  );
  const secret = str(res.secret);
  if (!secret) {
    // A rotate whose secret we cannot show is worse than no rotate: the old
    // secret is already demoted server-side and the new one is unrecoverable.
    throw new Error(
      "The secret was rotated but the server did not return the new value. Rotate again from the desktop app to obtain one you can save.",
    );
  }
  const endpoint = res.endpoint as Record<string, unknown> | undefined;
  return { secret, endpointId: str(endpoint?.id) || id };
}

/** The grace window the server gives the previous secret, for the copy. */
export const INBOUND_ROTATION_GRACE_HOURS = 24;
