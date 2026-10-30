// SPDX-License-Identifier: AGPL-3.0-only
/** Typed clients for incident credential verification and one-time access secrets. */
import { api } from "@/lib/api";

export interface AlertingAccessRequestOptions {
  signal?: AbortSignal;
  requireOnline?: boolean;
  maxAttempts?: number;
}

export type AlertProvider = "jira" | "pagerduty" | "servicenow";

export interface AlertProviderCredentials {
  jira: {
    site_url: string;
    email: string;
    api_token: string;
  };
  pagerduty: {
    routing_key: string;
  };
  servicenow:
    | {
        instance_url: string;
        bearer_token: string;
      }
    | {
        instance_url: string;
        username: string;
        password: string;
      };
}

/**
 * Verifies credentials without persisting them. Jira and ServiceNow make a
 * bounded upstream identity request; PagerDuty can only shape-check its
 * routing key, so success there does not prove delivery.
 */
export async function authenticateAlertProvider<P extends AlertProvider>(
  provider: P,
  credentials: AlertProviderCredentials[P],
  options?: AlertingAccessRequestOptions,
): Promise<{ ok: true }> {
  const response = await api.post<{ ok?: unknown }>(
    `/api/v1/audit-alerts/${provider}/auth`,
    credentials,
    options,
  );
  if (response?.ok !== true) {
    throw new Error("The verification endpoint did not confirm success.");
  }
  return { ok: true };
}

export interface StreamToken {
  token: string;
  expiresAt: string;
  ttlSeconds: number;
}

/** Mints a working bearer credential. Never persist or log the return value. */
export async function mintStreamToken(
  options?: AlertingAccessRequestOptions,
): Promise<StreamToken> {
  const response = await api.post<Record<string, unknown>>(
    "/api/v1/streams/token",
    {},
    options,
  );
  const token = text(response?.token);
  const expiresAt = text(response?.expires_at);
  const ttlSeconds = finiteNumber(response?.ttl_seconds);
  if (!token || !expiresAt || ttlSeconds <= 0) {
    throw new Error("The server returned an incomplete stream-token receipt.");
  }
  return { token, expiresAt, ttlSeconds };
}

export interface RotatedInboundEndpoint {
  id: string;
  tenantId: string;
  slug: string;
  secretConfigured: boolean;
  rotationRequired: boolean;
  secretRotatedAt: string;
  /** Plaintext signing secret returned exactly once. */
  secret: string;
  createdAt: string;
}

/**
 * Rotates only the inbound endpoint's signing secret. Existing endpoints keep
 * their slug; previously generated signatures stop validating immediately.
 */
export async function rotateInboundEndpoint(
  options?: AlertingAccessRequestOptions,
): Promise<RotatedInboundEndpoint> {
  const response = await api.post<Record<string, unknown>>(
    "/api/v1/inbound-emails/endpoint/rotate",
    {},
    options,
  );
  const parsed: RotatedInboundEndpoint = {
    id: text(response?.id),
    tenantId: text(response?.tenantId),
    slug: text(response?.slug),
    secretConfigured: response?.secretConfigured === true,
    rotationRequired: response?.rotationRequired === true,
    secretRotatedAt: text(response?.secretRotatedAt),
    secret: text(response?.secret),
    createdAt: text(response?.createdAt),
  };
  if (!parsed.id || !parsed.slug || !parsed.secret) {
    throw new Error(
      "The server returned an incomplete signing-secret rotation receipt.",
    );
  }
  return parsed;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
