/**
 * lib/routing-api.ts — inbound routes, outbound webhooks, inbound email.
 *
 * Six paths were reached by desktop and by no web file.
 *
 * `inbound-emails/endpoint` answers 404 `endpoint_not_found` when no inbound
 * address has been provisioned. That is a STATE, not an error — most
 * workspaces have never provisioned one — so it is caught and reported as
 * "not provisioned" rather than surfacing as a failed request. Distinguishing
 * the two matters: one means "set this up", the other means "something is
 * broken".
 *
 * COVERAGE: this module wires 3 of them:
 *   /api/v1/inbound-emails/endpoint
 *   /api/v1/inbound-routes
 *   /api/v1/outbound-webhooks
 * The remaining 3 are not called from web. The sentence above
 * describes the gap that was found, not the part that was closed.
 */
import { api, ApiError } from "@/lib/api";

/**
 * One inbound-mail routing rule.
 *
 * FIELD NAMES ARE THE SERVER'S. The first draft of this interface invented
 * `pattern` / `action` / `position`; `GET /api/v1/inbound-routes` returns
 * `name`, `match_recipient`, `actions`, `priority`
 * (apps/api/internal/inbound_email/routes.go, `type Route`). Nothing errored —
 * the page just rendered every real route as "— / no action", which is the
 * quiet response-shape drift this codebase keeps paying for.
 */
export interface InboundRoute {
  id?: string;
  name?: string;
  priority?: number;
  enabled?: boolean;
  stop_on_match?: boolean;
  match_recipient?: string;
  match_subject_prefix?: string;
  match_from_domain?: string;
  actions?: InboundRouteAction[];
  match_count?: number;
  last_matched_at?: string;
  [k: string]: unknown;
}

/** One step of a route's reaction pipeline. */
export interface InboundRouteAction {
  kind?: string;
  [k: string]: unknown;
}

export interface OutboundWebhook {
  id?: string;
  url?: string;
  events?: unknown[];
  active?: boolean;
  [k: string]: unknown;
}

export interface InboundEndpoint {
  /** Null when no inbound address has been provisioned — not an error. */
  address: string | null;
  provisioned: boolean;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function listInboundRoutes(): Promise<InboundRoute[]> {
  const res = await api.get<{ routes?: unknown }>("/api/v1/inbound-routes");
  return asArray<InboundRoute>(res?.routes);
}

/** What the create form collects. Everything else the server defaults. */
export interface CreateInboundRouteInput {
  name: string;
  match_recipient: string;
  match_subject_prefix?: string;
  match_from_domain?: string;
  priority?: number;
}

/**
 * Create a routing rule.
 *
 * `actions` is deliberately not sent. The server coalesces an omitted
 * `actions` to `[]` on the CREATE path and its own comment records that
 * whether an action-less route should be rejected is an unmade product
 * decision — so a rule created here matches and stores, and the pipeline is
 * added afterwards, rather than this form inventing a policy the schema has
 * not made.
 */
export function createInboundRoute(
  input: CreateInboundRouteInput,
): Promise<InboundRoute> {
  return api.post<InboundRoute>("/api/v1/inbound-routes", input);
}

export async function listOutboundWebhooks(): Promise<OutboundWebhook[]> {
  const res = await api.get<{ webhooks?: unknown }>(
    "/api/v1/outbound-webhooks",
  );
  return asArray<OutboundWebhook>(res?.webhooks);
}

/**
 * The inbound email address, if one exists.
 *
 * A 404 here is "never provisioned", which is the common case and not a
 * failure. Any other error propagates, because an unreadable endpoint IS a
 * failure and must not be reported as an absent one.
 */
export async function getInboundEndpoint(): Promise<InboundEndpoint> {
  try {
    const res = await api.get<{ address?: string }>(
      "/api/v1/inbound-emails/endpoint",
    );
    return {
      address: typeof res?.address === "string" ? res.address : null,
      provisioned: true,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return { address: null, provisioned: false };
    }
    throw err;
  }
}
