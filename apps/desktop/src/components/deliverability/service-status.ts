/**
 * service-status — pure classifier for errors coming back from the
 * three PROXIED deliverability-service routes (#42 inbox-reality
 * placement, #43 auth-checks, #44 diagnostician) plus the gateway's
 * rate limiter.
 *
 * The gateway mounts these through serviceproxy and answers 503 (not
 * 404) when DeliverabilityServiceURL isn't configured — see
 * WIRING-WRAPPERS.md "Gateway gaps". An honest UI must therefore
 * distinguish:
 *
 *   503 → "Inbox Reality service not configured on this deployment"
 *         (NOT an empty state — the data may exist on other deploys);
 *   429 → rate limited, show the retry-after when the server sent one;
 *   404 → a real "nothing recorded yet" (e.g. no seed test reported
 *         for the campaign) — this one IS an empty state;
 *   anything else → a real error with the verbatim message + retry.
 *
 * Lives in a .ts module (not the .tsx cards) so the node-environment
 * vitest suite can exercise it without a JSX transform.
 */

/** Structural subset of ApiErr["error"] — keeps the module decoupled
 *  from the api-client barrel for tests. */
export interface ApiErrorLike {
  message: string;
  status?: number;
  retryAfterSeconds?: number;
}

export type ServiceErrorKind =
  | "unconfigured"
  | "rate_limited"
  | "not_found"
  | "error";

export interface ServiceErrorView {
  kind: ServiceErrorKind;
  /** Ready-to-render copy. For kind "error" this is the verbatim
   *  server/network message so outages never get prettified away. */
  message: string;
}

/** Standard honest-UI copy for a 503 from a serviceproxy mount. */
export const SERVICE_UNCONFIGURED_COPY =
  "Inbox Reality service not configured on this deployment.";

export function describeServiceError(err: ApiErrorLike): ServiceErrorView {
  if (err.status === 503) {
    // Keep the server's own reason ("diagnostician not configured",
    // "LLM not wired", …) as a parenthetical so operators can tell
    // WHICH sub-system is missing, but lead with the stable copy.
    const detail = err.message?.trim();
    return {
      kind: "unconfigured",
      message: detail
        ? `${SERVICE_UNCONFIGURED_COPY} (${detail})`
        : SERVICE_UNCONFIGURED_COPY,
    };
  }
  if (err.status === 429) {
    const after =
      err.retryAfterSeconds != null && err.retryAfterSeconds > 0
        ? ` Try again in ~${Math.ceil(err.retryAfterSeconds)}s.`
        : " Try again shortly.";
    return { kind: "rate_limited", message: `Rate limited.${after}` };
  }
  if (err.status === 404) {
    return { kind: "not_found", message: err.message };
  }
  return { kind: "error", message: err.message };
}
