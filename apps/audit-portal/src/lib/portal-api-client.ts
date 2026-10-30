/**
 * portal-api-client.ts — typed fetch wrapper for the cookie-authenticated
 * read-only portal routes.
 *
 * The portal SPA cannot reuse the desktop app's api-client because
 * that client is authenticated via the dashboard session / API keys. The
 * portal uses a separate HttpOnly, tenant-bound cookie minted by a one-time
 * bootstrap exchange; renderer JavaScript never receives that cookie token.
 */

export interface Branding {
  brand_name: string;
  logo_url: string;
  primary_color: string;
  support_email: string;
  tenant_id: string;
  scope: string;
  expires_at: string;
}

/** Wire shape mirrored from apps/api/internal/handlers/audit.go. */
export interface AuditRow {
  id: number;
  action: string;
  resourceType?: string;
  resourceId?: string;
  actorType: string;
  actorLabel?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  metadata: Record<string, unknown>;
  at: string;
}

export interface ListAuditResponse {
  rows: AuditRow[];
  nextCursor?: string | null;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

/**
 * Every portal fetch is bounded. A socket that connects and never answers would
 * otherwise park the SPA on "Loading audit portal…" until the browser's own
 * multi-minute network timeout fires — an indefinitely blank compliance portal
 * with no error, no retry, and no support address. The bundle gets a longer
 * bound because it streams a tar.gz rather than one JSON page.
 */
export const PORTAL_REQUEST_TIMEOUT_MS = 10_000;
export const PORTAL_BUNDLE_TIMEOUT_MS = 60_000;

export interface PortalApiClientOptions {
  requestTimeoutMs?: number;
  bundleTimeoutMs?: number;
}

/** A downloaded proof bundle: the gzipped tar bytes + its server filename. */
export interface AivsBundle {
  blob: Blob;
  filename: string;
}

export interface PortalApiClient {
  exchangeBootstrap(bootstrap: string): Promise<ApiResult<null>>;
  getBranding(): Promise<ApiResult<Branding>>;
  listAudit(opts: {
    limit?: number;
    cursor?: string | null;
    since?: string;
    action?: string;
  }): Promise<ApiResult<ListAuditResponse>>;
  /**
   * Download the signed AIVS proof bundle (.tar.gz) for an agent session so the
   * auditor can re-verify the Ed25519 hash chain offline (G-19). The crypto is
   * produced server-side; this only streams the bytes back to the browser.
   */
  downloadAivsBundle(sessionId: string): Promise<ApiResult<AivsBundle>>;
}

// filenameFromDisposition pulls the attachment filename the server set, so the
// downloaded file keeps its meaningful name; falls back to a session-derived one.
function filenameFromDisposition(header: string | null, sessionId: string): string {
  if (header) {
    const match = /filename="?([^"]+)"?/i.exec(header);
    if (match?.[1]) return match[1];
  }
  return `postwave-aivs-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.tar.gz`;
}

const TIMEOUT_MESSAGE = "The portal service did not respond in time. Please retry.";

// The build targets safari14/chrome109, and AbortSignal.timeout arrived after
// the former — an older browser keeps today's unbounded behaviour rather than
// throwing on boot.
function timeoutSignal(milliseconds: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return undefined;
  }
  return AbortSignal.timeout(milliseconds);
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

async function request<T>(
  path: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      credentials: "include",
      referrerPolicy: "no-referrer",
      signal: timeoutSignal(timeoutMs),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as {
          error?: { code?: string; message?: string };
        };
        detail = body.error?.message ?? body.error?.code ?? "";
      } catch {
        // ignore — keep status-only error
      }
      return {
        ok: false,
        error: detail || `${res.status} ${res.statusText}`,
        status: res.status,
      };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    if (isTimeout(err)) return { ok: false, error: TIMEOUT_MESSAGE };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "network error",
    };
  }
}

export function createPortalApiClient(
  options: PortalApiClientOptions = {},
): PortalApiClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? PORTAL_REQUEST_TIMEOUT_MS;
  const bundleTimeoutMs = options.bundleTimeoutMs ?? PORTAL_BUNDLE_TIMEOUT_MS;
  return {
    async exchangeBootstrap(bootstrap) {
      try {
        const res = await fetch("/api/v1/audit/portal/exchange", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ bootstrap }),
          credentials: "include",
          referrerPolicy: "no-referrer",
          signal: timeoutSignal(requestTimeoutMs),
        });
        if (!res.ok) {
          return {
            ok: false,
            error: "This portal link is invalid, expired, or has already been used.",
            status: res.status,
          };
        }
        return { ok: true, data: null };
      } catch (err) {
        if (isTimeout(err)) return { ok: false, error: TIMEOUT_MESSAGE };
        return { ok: false, error: "The portal service could not be reached." };
      }
    },
    getBranding() {
      return request<Branding>("/api/v1/audit/portal/branding", requestTimeoutMs);
    },
    listAudit(opts) {
      const qs = new URLSearchParams();
      if (opts.limit) qs.set("limit", String(opts.limit));
      if (opts.cursor != null) qs.set("cursor", String(opts.cursor));
      if (opts.since) qs.set("since", opts.since);
      if (opts.action) qs.set("action", opts.action);
      const tail = qs.toString() ? `?${qs.toString()}` : "";
      return request<ListAuditResponse>(
        `/api/v1/audit/portal/events${tail}`,
        requestTimeoutMs,
      );
    },
    async downloadAivsBundle(sessionId) {
      const id = sessionId.trim();
      if (!id) return { ok: false, error: "Enter a session id to verify." };
      try {
        const res = await fetch(
          `/api/v1/audit/portal/ai-session/${encodeURIComponent(id)}/aivs-bundle`,
          {
            headers: { Accept: "application/gzip" },
            credentials: "include",
            referrerPolicy: "no-referrer",
            signal: timeoutSignal(bundleTimeoutMs),
          },
        );
        if (!res.ok) {
          const msg =
            res.status === 404
              ? "No agent events found for that session id."
              : `${res.status} ${res.statusText}`;
          return { ok: false, error: msg, status: res.status };
        }
        const blob = await res.blob();
        const filename = filenameFromDisposition(
          res.headers.get("Content-Disposition"),
          id,
        );
        return { ok: true, data: { blob, filename } };
      } catch (err) {
        if (isTimeout(err)) return { ok: false, error: TIMEOUT_MESSAGE };
        return {
          ok: false,
          error: err instanceof Error ? err.message : "network error",
        };
      }
    },
  };
}
