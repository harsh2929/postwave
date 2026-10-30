/**
 * api/eventBusConnection.ts — the PURE half of "where does the realtime
 * stream connect, and as whom".
 *
 * `eventBus.ts` cannot be unit tested: it imports `expo/fetch` and, through
 * `@/store/auth`, react-native — so any `.test.ts` that touches it dies at
 * import time in the node test environment. That is why the module holding the
 * cluster's connection rules had no tests at all, and it is the wrong half to
 * leave uncovered:
 *
 *  - THE TENANT HEADER IS A SLUG, NOT A UUID. A session's workspace slug and
 *    the api-key mode's tenant id are two different identifiers reaching the
 *    same `X-Tenant-Slug` header; sending the UUID for a session is a
 *    real, previously-shipped class of bug that authenticates as nobody.
 *  - THE BEARER PREFIX IS LOAD-BEARING. A key pasted without its `pw_` prefix
 *    is a valid-looking token the server rejects, and the failure surfaces as
 *    "realtime is quiet", not as an auth error.
 *  - AN UNCONFIGURED BASE URL MUST NOT PRODUCE A URL. Returning a bare path is
 *    what makes the caller's "not connected" branch reachable.
 *
 * Everything here takes its inputs explicitly and imports only other pure
 * modules (`./url`, `./event-bus-topics`), so it is testable in the node
 * environment the rest of the suite runs in. `eventBus.ts` reads the auth store
 * and does the I/O; the decisions live here.
 */
import { normalizeEventBusTopics } from "./event-bus-topics";
import { apiUrl } from "./url";

/** The slice of the auth store the connection is derived from. */
export interface EventBusIdentity {
  /** API-key mode credential, with or without its `pw_` prefix. */
  apiKey: string | null;
  /** `"session"` | `"api_key"`, or null before an identity is established. */
  mode: string | null;
  /** In api-key mode this doubles as the tenant SLUG on the wire. */
  tenantId: string | null;
  /** Session mode's real workspace slug. */
  workspaceSlug: string | null | undefined;
}

/**
 * The value for `X-Tenant-Slug`, or null when we have nothing to send.
 *
 * A SESSION always answers with its workspace slug — never with `tenantId`,
 * which is a UUID. Only api-key mode falls back to `tenantId`, because there
 * the stored value IS the slug the user typed.
 */
export function eventBusTenantSlug(identity: EventBusIdentity): string | null {
  return identity.workspaceSlug ?? (identity.mode === "api_key" ? identity.tenantId : null);
}

/**
 * The `Authorization: Bearer` value for an api key, adding the `pw_` prefix
 * when the stored key lacks it (users paste both forms). Null in session mode,
 * where the cookie carries the identity.
 */
export function eventBusBearer(apiKey: string | null): string | null {
  if (!apiKey) return null;
  return apiKey.startsWith("pw_") ? apiKey : `pw_${apiKey}`;
}

/**
 * The request path for a topic subscription, with the topics CSV encoded.
 *
 * `entityRef` is the OPTIONAL per-record presence scope (SHELL-036): the
 * server reads `?entity=` on every /api/v1/events subscription and registers
 * this connection as a viewer of that record, so other sessions viewing the
 * same record are told. It is bounded server-side at 128 characters
 * (apps/api/internal/events/handler.go) — we trim to the same bound here so a
 * long ref produces the SAME key on both sides rather than one the server
 * silently truncated into a different room. Empty/blank means
 * workspace-global presence only, which is the shape every existing caller
 * sends.
 */
export const MAX_PRESENCE_ENTITY_REF_LENGTH = 128;

export function eventBusRequestPath(
  topics: string[],
  entityRef?: string | null,
): string {
  const base = `/api/v1/events?topics=${encodeURIComponent(normalizeEventBusTopics(topics))}`;
  const entity = normalizePresenceEntityRef(entityRef);
  return entity ? `${base}&entity=${encodeURIComponent(entity)}` : base;
}

/** Trim + bound an entity ref to exactly what the server will store, or null. */
export function normalizePresenceEntityRef(
  entityRef: string | null | undefined,
): string | null {
  const trimmed = (entityRef ?? "").trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_PRESENCE_ENTITY_REF_LENGTH
    ? trimmed.slice(0, MAX_PRESENCE_ENTITY_REF_LENGTH)
    : trimmed;
}

export interface EventBusConnectionInput {
  /** Configured API base; empty/null means "not configured yet". */
  baseUrl: string | null;
  path: string;
  /** Short-lived token from POST /api/v1/streams/token, when one was minted. */
  streamToken: string | null;
}

export interface EventBusConnection {
  url: string;
  bearer: string | null;
  /** Local-development tenant slug (legacy property name retained). */
  tenantId: string | null;
}

/**
 * The absolute stream URL, or the bare path when there is no base URL to
 * resolve against. The stream token rides as a query parameter because an
 * `EventSource`-shaped GET cannot carry a header.
 */
export function eventBusStreamUrl(input: EventBusConnectionInput): string {
  if (!input.baseUrl) return input.path;
  const url = new URL(apiUrl(input.baseUrl, input.path));
  if (input.streamToken) {
    url.searchParams.set("stream_token", input.streamToken);
  }
  return url.toString();
}
