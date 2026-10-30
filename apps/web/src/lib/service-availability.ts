// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The API's answer when the service behind a feature is not deployed in this
 * environment (its *_SERVICE_URL is "disabled"): 503 with retryable: false. It
 * describes the environment, not a failure, so it is shown as a neutral state
 * with no Retry — asking again cannot change it.
 *
 * Render it with <ServiceNotDeployedNotice> (components/service-not-deployed-
 * notice.tsx), and disable — do not hide — the actions that need the service,
 * pointing their aria-describedby at the notice. OperationsFailure and
 * QueryError already do this when handed the error.
 */
export const SERVICE_NOT_DEPLOYED = "service_not_deployed";

/**
 * Matched by the error's `code` (what ApiError carries off the envelope), like
 * query-client.ts's retry policy, so this module stays free of the API client
 * and the shared failure components can ask it without pulling that in.
 */
export function isServiceNotDeployed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === SERVICE_NOT_DEPLOYED
  );
}

/** True when any of the given errors is a not-deployed answer. */
export function anyServiceNotDeployed(...errors: unknown[]): boolean {
  return errors.some(isServiceNotDeployed);
}

/** A signed-in workspace needs a sending domain before domain-level reads. */
export function isSendingDomainNotConfigured(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code ===
      "sending_domain_not_configured"
  );
}
