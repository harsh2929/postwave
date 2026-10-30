/**
 * api/inboundEndpointAdmin.ts — the endpoint LIFECYCLE half of inbound
 * webhooks: mint one, rename one, delete one.
 *
 * `api/inboundWebhooks.ts` is the OPERATE half (events, replay, enable,
 * rotate) and deliberately said the desktop app "remains the primary
 * CREATOR". These three routes close that: an operator standing in front of a
 * partner's dashboard can now mint the endpoint, paste the secret, and fix a
 * label they mistyped — without a laptop.
 *
 *   POST   /api/v1/inbound-webhooks          {name}  -> 201 {endpoint, secret}
 *   PATCH  /api/v1/inbound-webhooks/{id}     {name}  -> 200 endpoint
 *   DELETE /api/v1/inbound-webhooks/{id}             -> 200 {ok:true}
 *
 * All three are `admin` in apps/api/internal/routeauth/manifest.json and are
 * mounted with `apikeys.RequireScope(apikeys.ScopeAdmin)`
 * (inbound_webhooks/handlers.go:154,156,158).
 *
 * TWO TRANSPORT DECISIONS THAT ARE NOT COSMETIC.
 *
 * 1. CREATE AND DELETE OPT OUT OF THE SDK'S AUTO-MINTED IDEMPOTENCY KEY
 *    (`idempotencyKey: null`), which also disables its retries
 *    (packages/sdk-ts/src/client.ts:498-520). The key is auto-minted for every
 *    POST/PATCH/DELETE so that a retry is safe — but THIS handler never reads
 *    it (`Create`, handlers.go:178, decodes only `name` + `transform_jq`;
 *    `Delete`, :395, decodes nothing). A retried create whose first response
 *    was merely lost would therefore mint a SECOND endpoint holding a SECOND
 *    secret that no one will ever see — the one failure this surface must not
 *    have. A retried delete would answer 404 for a delete that in fact
 *    succeeded. One attempt, and an honest error, is the correct trade for
 *    both. Rename keeps the default: PATCH {name} applied twice is the same
 *    row.
 *
 * 2. A PATCH CARRIES `name` AND NOTHING ELSE. The server's partial update is
 *    `name = COALESCE($3, name), enabled = COALESCE($4, enabled),
 *    transform_jq = CASE WHEN $5 THEN ... ELSE transform_jq END`
 *    (repo.go:294-318), so an omitted field is genuinely "keep" — unlike the
 *    inbound-ROUTES PATCH next door, whose omissions write null and which is
 *    why lib/inboundRouteToggle.ts has to echo the whole row. Sending only
 *    the new name cannot disable an endpoint or drop its transform.
 */
import { rawRequest, type AIApiError } from "./request";

/** The one-shot create result. `secret` is never stored or logged. */
export interface InboundEndpointCreated {
  endpointId: string;
  slug: string;
  name: string;
  /** Plaintext signing secret. The server returns it exactly once. */
  secret: string;
}

export class InboundEndpointAdminError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "InboundEndpointAdminError";
    this.status = error.status;
    this.code = error.code;
  }
}

/** True for "that endpoint is already gone" — a 404 from the delete path. */
export function isInboundEndpointGone(error: unknown): boolean {
  return (
    error instanceof InboundEndpointAdminError && error.status === 404
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Mint an endpoint and hand back its one-time secret.
 *
 * A 2xx whose body carries no usable secret is treated as a FAILURE the
 * operator must act on, not as a success with a blank card: the endpoint
 * exists, is enabled, and is signing with a value nobody holds. The message
 * names the repair (rotate it), which is the same posture
 * `rotateInboundSecret` takes for the same reason.
 */
export async function createInboundEndpoint(
  name: string,
): Promise<InboundEndpointCreated> {
  const res = await rawRequest<{ endpoint?: unknown; secret?: unknown }>(
    "POST",
    "/api/v1/inbound-webhooks",
    { name },
    { idempotencyKey: null },
  );
  if (res.error) {
    throw new InboundEndpointAdminError(res.error, "Creating the endpoint");
  }
  if (res.data == null) {
    throw new Error("Creating the endpoint returned no data.");
  }
  const endpoint = (
    res.data.endpoint && typeof res.data.endpoint === "object"
      ? res.data.endpoint
      : {}
  ) as Record<string, unknown>;
  const secret = str(res.data.secret);
  const endpointId = str(endpoint.id);
  if (!secret || !endpointId) {
    throw new Error(
      "The endpoint was created but the server did not return a usable one-time secret. Pull to refresh, then rotate the new endpoint before pointing anything at it.",
    );
  }
  return {
    endpointId,
    slug: str(endpoint.slug),
    name: str(endpoint.name),
    secret,
  };
}

/** Change an endpoint's label. Nothing else about the endpoint moves. */
export async function renameInboundEndpoint(
  id: string,
  name: string,
): Promise<string> {
  const endpointId = (id ?? "").trim();
  if (!endpointId) throw new Error("An endpoint id is required to rename it.");
  const res = await rawRequest<{ name?: unknown }>(
    "PATCH",
    `/api/v1/inbound-webhooks/${encodeURIComponent(endpointId)}`,
    { name },
  );
  if (res.error) {
    throw new InboundEndpointAdminError(res.error, "Renaming the endpoint");
  }
  // The server echoes the stored row; prefer its name over the one we sent so
  // the toast cannot claim a value the database did not accept.
  return str(res.data?.name) || name;
}

/**
 * Delete an endpoint. The server tombstones it (migration 1793): ingest is
 * revoked at once and the signing material is shredded, while retained events
 * and action intents survive for governed retention. The consequence copy the
 * confirm shows lives in lib/inboundEndpointAdmin.
 */
export async function deleteInboundEndpoint(id: string): Promise<void> {
  const endpointId = (id ?? "").trim();
  if (!endpointId) throw new Error("An endpoint id is required to delete it.");
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/inbound-webhooks/${encodeURIComponent(endpointId)}`,
    undefined,
    { idempotencyKey: null },
  );
  if (res.error) {
    throw new InboundEndpointAdminError(res.error, "Deleting the endpoint");
  }
}
