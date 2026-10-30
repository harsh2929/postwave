// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Support-provider (customer-service) integration release policy.
 *
 * Keep this synchronized with:
 *   - apps/desktop/src/lib/api/support-integrations.ts
 *     (SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE, supportRuntimeHeld)
 *   - apps/api/internal/support_integrations/handlers.go (MountRoutes →
 *     RuntimeHeld on every create/sync/backfill/ingest/pause/disconnect/runs)
 *
 * The static provider catalog (GET /api/v1/support-integrations/providers)
 * and the minimized connection list stay readable. Every runtime mutation is
 * fail-closed — the server answers 503 `support_integration_runtime_held`
 * and desktop refuses before transport — until Helpdesk privacy governance
 * is complete.
 */
export const SUPPORT_INTEGRATION_RUNTIME_AVAILABLE: boolean = false;

export const SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE =
  "support_integration_runtime_held" as const;

/** The public callback ingress carries its own, separate hold. */
export const SUPPORT_PROVIDER_INGRESS_HOLD_CODE =
  "support_provider_ingress_held" as const;

export const SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE =
  "Support provider runtime is release-held. No support runtime request was sent.";

export class SupportRuntimeHeldError extends Error {
  readonly code = SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE;
  readonly status = 503;
  readonly retryable = false;

  constructor() {
    super(SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE);
    this.name = "SupportRuntimeHeldError";
  }
}

/** Throws before any request leaves the client while the runtime is held. */
export function requireSupportRuntime(): void {
  if (!SUPPORT_INTEGRATION_RUNTIME_AVAILABLE) throw new SupportRuntimeHeldError();
}
