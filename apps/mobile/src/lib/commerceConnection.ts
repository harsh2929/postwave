/**
 * lib/commerceConnection.ts — the two administrative verbs on a store
 * connection that a phone can honestly perform: pause, and disconnect.
 *
 * SERVER TRUTH, read from apps/api/internal/commerce rather than the desktop:
 *
 *   POST   /api/v1/commerce/integrations/{id}/pause   ScopeAdmin (handlers.go:143)
 *     `PauseIntegration` (:326) flips `status` to "paused" through
 *     `SetIntegrationStatus` (repo.go:107) and answers 200 with the updated
 *     Integration row. 404 when the id is gone; 409 `integration_disconnected`
 *     when the row is already disconnected (:342, :353).
 *
 *   DELETE /api/v1/commerce/integrations/{id}         ScopeAdmin (handlers.go:144)
 *     `DeleteIntegration` (:363) attempts provider webhook cleanup where it
 *     holds a token, THEN marks the row disconnected, and answers 200 with
 *     `DisconnectResponse{ok, provider_cleanup}` (types.go:72-95). An already
 *     disconnected row answers 200 again (:378) — the verb is idempotent. A
 *     provider call that fails surfaces as 502/429 (`writeShopifyBackfillError`
 *     :2040) or 422 (`writeCommerceBackfillError` :2063) BEFORE the local row
 *     changes, so on any error the connection is exactly as it was.
 *
 * WHAT "PAUSED" MEANS ON THIS SERVER — AND WHY THE COPY BELOW DOES NOT MIRROR
 * THE DESKTOP'S. IntegrationsTab.tsx says pausing "will stop scheduled
 * provider syncs". Every backfill worker checks the status for "disconnected"
 * and nothing else (shopify_backfill_worker.go:170 and the seven sibling
 * providers), `POST /{id}/sync` never reads or resets it (:1386-1470), and the
 * package has no scheduler to stop. The ONE server behaviour keyed to "paused"
 * is internal/limits/limits.go:186: a paused store stops counting toward the
 * plan's store limit. So the phone says what the server does — marks the store
 * paused, keeps its data, frees a plan slot — and does not promise a scheduler
 * it cannot find. There is no un-pause route, which is why a paused store's
 * button stays visible but disabled instead of becoming a toggle.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

export interface StoreConnectionLike {
  id: string;
  provider: string;
  shopDomain: string;
  status: string;
}

/** The name the sheets and toasts use — the shop first, the provider second. */
export function storeConnectionName(store: StoreConnectionLike): string {
  return store.shopDomain || store.provider || "this store";
}

export function isStorePaused(status: string): boolean {
  return status.trim().toLowerCase() === "paused";
}

export function isStoreDisconnected(status: string): boolean {
  return status.trim().toLowerCase() === "disconnected";
}

export interface ConnectionVerb {
  enabled: boolean;
  /** Spoken in place of the button label when disabled; "" when enabled. */
  reason: string;
}

/**
 * Whether Pause can be pressed for THIS store. The disabled reasons are the
 * two states the server would refuse anyway (409 for disconnected; a no-op
 * for already paused), said before the request instead of after it.
 */
export function pauseVerb(store: StoreConnectionLike): ConnectionVerb {
  const name = storeConnectionName(store);
  if (isStoreDisconnected(store.status)) {
    return {
      enabled: false,
      reason: `${name} is disconnected. Reconnect it on the web admin first.`,
    };
  }
  if (isStorePaused(store.status)) {
    return { enabled: false, reason: `${name} is already paused.` };
  }
  return { enabled: true, reason: "" };
}

/**
 * Whether Disconnect can be pressed. The server answers 200 for a second
 * disconnect, so offering it would be offering a button that does nothing —
 * the dimmed row with its reason is the honest state.
 */
export function disconnectVerb(store: StoreConnectionLike): ConnectionVerb {
  if (isStoreDisconnected(store.status)) {
    return {
      enabled: false,
      reason: `${storeConnectionName(store)} is already disconnected.`,
    };
  }
  return { enabled: true, reason: "" };
}

/**
 * Whether the administrative controls are OFFERED at all. Both routes are
 * ScopeAdmin, so a viewer/editor session sees the store's state and no
 * button — and a commerce write is never queued for replay, so offline hides
 * them too rather than presenting a control that cannot reach the server.
 */
export function offersStoreAdministration(input: {
  canAdmin: boolean;
  online: boolean;
}): boolean {
  return input.canAdmin && input.online;
}

export interface ConnectionConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
  consequence: string;
}

export function pauseConfirmCopy(
  store: StoreConnectionLike,
): ConnectionConfirmCopy {
  const name = storeConnectionName(store);
  return {
    title: "Pause store integration?",
    message: `Moosewave will mark ${name} paused and keep everything it has already imported.`,
    confirmLabel: "Pause integration",
    consequence:
      "A paused store stops counting toward your plan's store limit. There is no un-pause from the app.",
  };
}

export function disconnectConfirmCopy(
  store: StoreConnectionLike,
): ConnectionConfirmCopy {
  const name = storeConnectionName(store);
  return {
    title: "Disconnect store integration?",
    message: `Moosewave will stop syncing ${name} and mark the connection disconnected.`,
    confirmLabel: "Disconnect",
    consequence:
      "Already-imported customers, products, and orders are kept. Reconnecting is done on the web admin.",
  };
}

function statusOf(err: unknown): number {
  return err && typeof err === "object" && "status" in err
    ? Number((err as { status: unknown }).status)
    : 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message.trim() : "";
}

/** The HTTP outcomes `PauseIntegration` can produce, in the customer's words. */
export function commercePauseErrorMessage(err: unknown): string {
  const status = statusOf(err);
  if (status === 403) {
    return "Pausing a store needs an owner or admin session.";
  }
  if (status === 409) {
    return "This store is disconnected. Reconnect it on the web admin first.";
  }
  if (status === 404) {
    return "That store no longer exists. Pull to refresh.";
  }
  return messageOf(err) || "Couldn't pause the store.";
}

/**
 * The HTTP outcomes `DeleteIntegration` can produce. The provider-cleanup
 * failures (429/502/422) all happen BEFORE the local row is touched, so every
 * one of them can truthfully say the connection was left as it was.
 */
export function commerceDisconnectErrorMessage(err: unknown): string {
  const status = statusOf(err);
  if (status === 403) {
    return "Disconnecting a store needs an owner or admin session.";
  }
  if (status === 404) {
    return "That store no longer exists. Pull to refresh.";
  }
  if (status === 429) {
    return "The provider is rate-limiting Moosewave. The connection was left as it was — wait a moment and try again.";
  }
  if (status === 502 || status === 422) {
    return "Moosewave couldn't remove its webhooks from the provider, so the connection was left as it was.";
  }
  return messageOf(err) || "Couldn't disconnect the store.";
}

/** Mirrors `DisconnectCleanupEvidence` (types.go:72-90), camel-cased. */
export interface DisconnectOutcome {
  ok: boolean;
  provider: string;
  postwaveStatus: string;
  managedProviderCleanup: boolean;
  webhookCleanupStatus: string;
  credentialCleanupStatus: string;
  /** Server-authored sentences. Rendered verbatim, never paraphrased. */
  postwaveEffects: string[];
  providerConsoleActions: string[];
  providerCleanupEvidence: string[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sentences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const line = str(entry);
    if (line) out.push(line);
  }
  return out;
}

export function normalizeDisconnectOutcome(raw: unknown): DisconnectOutcome {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const cleanupRaw = body.provider_cleanup;
  const cleanup = (
    cleanupRaw && typeof cleanupRaw === "object" ? cleanupRaw : {}
  ) as Record<string, unknown>;
  return {
    ok: body.ok === true,
    provider: str(cleanup.provider),
    postwaveStatus: str(cleanup.postwave_status),
    managedProviderCleanup: cleanup.managed_provider_cleanup === true,
    webhookCleanupStatus: str(cleanup.webhook_cleanup_status),
    credentialCleanupStatus: str(cleanup.credential_cleanup_status),
    postwaveEffects: sentences(cleanup.postwave_effects),
    providerConsoleActions: sentences(cleanup.provider_console_actions),
    providerCleanupEvidence: sentences(cleanup.provider_cleanup_evidence),
  };
}

/**
 * Same predicate the desktop's DisconnectOutcomeModal uses: cleanup is only
 * "complete" when the server MANAGED it and both halves report completed.
 * An unmanaged provider (Stripe, Square, PayPal…) never satisfies this, and
 * must not, because for those the operator still has console steps to do.
 */
export function disconnectCleanupComplete(outcome: DisconnectOutcome): boolean {
  return (
    outcome.managedProviderCleanup &&
    outcome.webhookCleanupStatus === "completed" &&
    outcome.credentialCleanupStatus === "completed"
  );
}

export function disconnectOutcomeHeadline(outcome: DisconnectOutcome): string {
  if (disconnectCleanupComplete(outcome)) {
    return "Moosewave stopped this connection and removed what it had installed at the provider.";
  }
  return "Moosewave stopped this connection locally. Review the provider cleanup boundary before considering the store fully removed.";
}
