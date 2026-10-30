/**
 * Commerce → Integrations tab (#33a).
 *
 * Store connections (bare-array wire), Shopify OAuth/webhook connect for
 * live events, canonical-row import foundations for other providers, and
 * a browse area: an analytics strip (GET /integrations/{id}/analytics)
 * plus paged customers / products / orders / events tables, with
 * per-product variants, inventory-snapshot, and price-history drilldowns.
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The named integrations table is a bounded overflow region that keyboard users must be able to pan. */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { HeroEmptyState } from "../HeroEmptyState";
import { Modal, ModalFooter } from "../Modal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { useCredentialDraftLifecycle } from "../../hooks/useCredentialDraftLifecycle";
import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import {
  type CommerceDisconnectResponse,
  type CommerceIntegration,
  type CommerceProviderField,
  type CommerceProviderSpec,
  commerceApi,
} from "../../lib/api-client";
import {
  type CommerceAdministrationIntent,
  resolveCommerceAdministrationTarget,
} from "../../lib/commerce-owner-intents";
import { HERO } from "../../lib/heroAssets";
import {
  remoteFailureFromError,
  type RemoteApiError,
} from "../../lib/remote-resource";
import { tauriApi } from "../../lib/tauri";

import {
  fmtCommerceDate,
  integrationSyncStateText,
  integrationSyncStateTone,
  integrationTone,
  syncSummaryMessage,
} from "./commerce-helpers";
import { IntegrationBrowsePanel } from "./IntegrationBrowsePanel";

const INTEGRATION_COLS = "1.4fr 1fr 110px 170px 200px";
function safeCommerceFailure(error: RemoteApiError): string {
  return remoteFailureFromError(error).message;
}

function CommerceTime({ value }: { value?: string | null }): ReactElement {
  if (!value) return <span className="muted">Not recorded</span>;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return <span className="commerce-value">{value}</span>;
  }
  return (
    <time dateTime={parsed.toISOString()} className="commerce-time">
      <span>{fmtCommerceDate(value)}</span>
      <span className="commerce-detail">{parsed.toISOString()}</span>
    </time>
  );
}

function normalizedIntegrations(
  integrations: CommerceIntegration[] | null,
): CommerceIntegration[] | null {
  if (integrations === null) return null;
  return Array.isArray(integrations) ? integrations : [];
}

function findExpandedBrowseOpener(panelId: string): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[aria-controls]"),
  ).find(
    (candidate) =>
      candidate.getAttribute("aria-controls") === panelId &&
      candidate.getAttribute("aria-expanded") === "true",
  );
}

function captureReturnFocus(ref: { current: HTMLElement | null }): void {
  ref.current =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
}

export function IntegrationsTab({
  integrations,
  err,
  canAdmin,
  onReload,
  administrationIntent,
  onAdministrationIntentResolved,
}: {
  integrations: CommerceIntegration[] | null;
  err: string | null;
  canAdmin: boolean;
  onReload: () => Promise<void>;
  administrationIntent: CommerceAdministrationIntent | null;
  onAdministrationIntentResolved: () => void;
}): ReactElement {
  const browsePanelId = useId();
  const mountedRef = useRef(true);
  const connectReturnFocusRef = useRef<HTMLElement | null>(null);
  const pauseReturnFocusRef = useRef<HTMLElement | null>(null);
  const disconnectReturnFocusRef = useRef<HTMLElement | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [browseId, setBrowseId] = useState<string | null>(null);
  // [D11-commerce-growth#4] Per-integration sync (provider pull/backfill)
  // and disconnect — the client methods shipped but were left unwired,
  // leaving a permanently-disabled "API import only" button and no way to
  // remove a connected store.
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [pauseTarget, setPauseTarget] = useState<CommerceIntegration | null>(
    null,
  );
  const [pausing, setPausing] = useState(false);
  const [disconnectTarget, setDisconnectTarget] =
    useState<CommerceIntegration | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectOutcome, setDisconnectOutcome] =
    useState<CommerceDisconnectResponse | null>(null);
  const storeOperation = useSingleFlightOperation({
    ownerId: "commerce-store-administration",
    label: "Commerce store operation",
    detail: "Wait for the commerce store request to finish before leaving.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reloadAfterMutation = async (): Promise<void> => {
    try {
      await onReload();
    } catch {
      toast.info(
        "The store action succeeded, but this list couldn't refresh. Refresh Commerce to verify the latest state.",
      );
    }
  };

  const doSync = async (i: CommerceIntegration): Promise<boolean> => {
    if (syncingId) return false;
    const request = storeOperation.run(async () => {
      setSyncingId(i.id);
      // Empty payload → provider-managed pull/backfill. The server answers
      // 202 with upsert counts for pull-capable providers, or a verbatim
      // 422 for providers whose puller isn't wired yet (surfaced honestly).
      try {
        const res = await commerceApi.syncIntegration(i.id, {});
        if (res.error) {
          toast.error(`Sync failed. ${safeCommerceFailure(res.error)}`);
          return false;
        }
        toast.success(syncSummaryMessage(res.data));
        await reloadAfterMutation();
        return true;
      } catch {
        toast.error("Sync failed. Check your connection and retry.");
        return false;
      } finally {
        if (mountedRef.current) setSyncingId(null);
      }
    });
    if (!request) await storeOperation.wait();
    return request ? await request : false;
  };

  const doPause = async (): Promise<boolean> => {
    if (!pauseTarget || pausing) return false;
    const target = pauseTarget;
    const request = storeOperation.run(async () => {
      setPausing(true);
      try {
        const res = await commerceApi.pauseIntegration(target.id);
        if (res.error) {
          toast.error(`Pause failed. ${safeCommerceFailure(res.error)}`);
          return false;
        }
        toast.success("Store integration paused");
        if (mountedRef.current) setPauseTarget(null);
        await reloadAfterMutation();
        return true;
      } catch {
        toast.error("Pause failed. Check your connection and retry.");
        return false;
      } finally {
        if (mountedRef.current) setPausing(false);
      }
    });
    if (!request) await storeOperation.wait();
    return request ? await request : false;
  };

  const doDisconnect = async (): Promise<boolean> => {
    if (!disconnectTarget || disconnecting) return false;
    const target = disconnectTarget;
    const request = storeOperation.run(async () => {
      setDisconnecting(true);
      try {
        const res = await commerceApi.disconnectIntegration(target.id);
        if (res.error) {
          toast.error(`Disconnect failed. ${safeCommerceFailure(res.error)}`);
          return false;
        }
        toast.success("Moosewave connection marked disconnected");
        if (mountedRef.current) {
          setDisconnectTarget(null);
          setDisconnectOutcome(res.data ?? { ok: true });
        }
        await reloadAfterMutation();
        return true;
      } catch {
        toast.error("Disconnect failed. Check your connection and retry.");
        return false;
      } finally {
        if (mountedRef.current) setDisconnecting(false);
      }
    });
    if (!request) await storeOperation.wait();
    return request ? await request : false;
  };

  // Defensive: the prop is typed `CommerceIntegration[] | null`, but the
  // bare-array wire can deliver a shape-light `{}` at runtime. `null`
  // means "still loading"; anything else that isn't an array collapses
  // to empty so `.find/.map/.length` below render the empty state
  // instead of white-screening.
  const rows = normalizedIntegrations(integrations);

  const administrationTarget = resolveCommerceAdministrationTarget(
    rows,
    administrationIntent,
  );
  const managedBrowseTarget =
    administrationIntent?.task === "manage" ? administrationTarget : null;
  const browseTarget =
    managedBrowseTarget ?? rows?.find((i) => i.id === browseId) ?? null;
  const reconnectingTarget =
    administrationTarget?.status.toLowerCase() === "disconnected";
  const routeConnectOpen =
    administrationIntent?.task === "connect" &&
    canAdmin &&
    (!administrationIntent.integrationId || reconnectingTarget);
  const connectProvider = administrationIntent?.provider;

  const resolveRouteIntentAfter = async (
    operation: Promise<boolean>,
    shouldResolve = true,
  ): Promise<void> => {
    if ((await operation) && shouldResolve) onAdministrationIntentResolved();
  };

  const closePauseConfirmation = (): void => {
    if (pausing) return;
    const wasRouteIntent =
      administrationIntent?.task === "pause" &&
      pauseTarget?.id === administrationTarget?.id;
    setPauseTarget(null);
    if (wasRouteIntent) onAdministrationIntentResolved();
  };

  const closeDisconnectConfirmation = (): void => {
    if (disconnecting) return;
    const wasRouteIntent =
      administrationIntent?.task === "disconnect" &&
      disconnectTarget?.id === administrationTarget?.id;
    setDisconnectTarget(null);
    if (wasRouteIntent) onAdministrationIntentResolved();
  };
  const closeBrowsePanel = (): void => {
    const opener = findExpandedBrowseOpener(browsePanelId);
    if (managedBrowseTarget) onAdministrationIntentResolved();
    else setBrowseId(null);
    window.setTimeout(() => opener?.focus(), 0);
  };
  const openConnect = (): void => {
    captureReturnFocus(connectReturnFocusRef);
    setConnectOpen(true);
  };

  return (
    <div className="commerce-surface">
      <IntegrationSectionIntroduction
        canAdmin={canAdmin}
        error={err}
        onConnect={openConnect}
      />

      {administrationIntent && !routeConnectOpen ? (
        <CommerceAdministrationNotice
          intent={administrationIntent}
          target={administrationTarget}
          loading={rows === null}
          loadError={err}
          canAdmin={canAdmin}
          busy={
            storeOperation.active ||
            syncingId === administrationTarget?.id ||
            (pausing && pauseTarget?.id === administrationTarget?.id) ||
            (disconnecting && disconnectTarget?.id === administrationTarget?.id)
          }
          onDismiss={onAdministrationIntentResolved}
          onConnect={openConnect}
          onSync={() => {
            if (administrationTarget) {
              void resolveRouteIntentAfter(doSync(administrationTarget));
            }
          }}
          onPause={() => {
            if (administrationTarget) {
              captureReturnFocus(pauseReturnFocusRef);
              setPauseTarget(administrationTarget);
            }
          }}
          onDisconnect={() => {
            if (administrationTarget) {
              captureReturnFocus(disconnectReturnFocusRef);
              setDisconnectTarget(administrationTarget);
            }
          }}
        />
      ) : null}

      <CommerceIntegrationList
        rows={rows}
        err={err}
        canAdmin={canAdmin}
        activeBrowseId={browseTarget?.id ?? null}
        browsePanelId={browsePanelId}
        syncingId={syncingId}
        pausingId={pausing ? (pauseTarget?.id ?? null) : null}
        actionsBusy={storeOperation.active}
        onConnect={openConnect}
        onToggleBrowse={(integration) => {
          if (managedBrowseTarget?.id === integration.id) {
            closeBrowsePanel();
            return;
          }
          if (browseId === integration.id) {
            closeBrowsePanel();
          } else {
            setBrowseId(integration.id);
          }
        }}
        onSync={(integration) => void doSync(integration)}
        onPause={(integration) => {
          captureReturnFocus(pauseReturnFocusRef);
          setPauseTarget(integration);
        }}
        onDisconnect={(integration) => {
          captureReturnFocus(disconnectReturnFocusRef);
          setDisconnectTarget(integration);
        }}
      />

      {browseTarget ? (
        <IntegrationBrowsePanel
          key={browseTarget.id}
          id={browsePanelId}
          integration={browseTarget}
          onClose={closeBrowsePanel}
        />
      ) : null}

      {connectOpen || routeConnectOpen ? (
        <StoreConnectModal
          key={connectProvider ?? "manual"}
          initialProvider={connectProvider}
          returnFocusRef={connectReturnFocusRef}
          onClose={() => {
            setConnectOpen(false);
            if (routeConnectOpen) {
              window.setTimeout(onAdministrationIntentResolved, 0);
            }
          }}
          onConnected={onReload}
        />
      ) : null}

      <IntegrationAdministrationDialogs
        pauseTarget={pauseTarget}
        disconnectTarget={disconnectTarget}
        disconnectOutcome={disconnectOutcome}
        pausing={pausing}
        disconnecting={disconnecting}
        pauseReturnFocusRef={pauseReturnFocusRef}
        disconnectReturnFocusRef={disconnectReturnFocusRef}
        onConfirmPause={() =>
          resolveRouteIntentAfter(
            doPause(),
            administrationIntent?.task === "pause" &&
              pauseTarget?.id === administrationTarget?.id,
          )
        }
        onClosePause={closePauseConfirmation}
        onConfirmDisconnect={() =>
          resolveRouteIntentAfter(
            doDisconnect(),
            administrationIntent?.task === "disconnect" &&
              disconnectTarget?.id === administrationTarget?.id,
          )
        }
        onCloseDisconnect={closeDisconnectConfirmation}
        onCloseOutcome={() => setDisconnectOutcome(null)}
      />
    </div>
  );
}

function IntegrationAdministrationDialogs({
  pauseTarget,
  disconnectTarget,
  disconnectOutcome,
  pausing,
  disconnecting,
  pauseReturnFocusRef,
  disconnectReturnFocusRef,
  onConfirmPause,
  onClosePause,
  onConfirmDisconnect,
  onCloseDisconnect,
  onCloseOutcome,
}: {
  pauseTarget: CommerceIntegration | null;
  disconnectTarget: CommerceIntegration | null;
  disconnectOutcome: CommerceDisconnectResponse | null;
  pausing: boolean;
  disconnecting: boolean;
  pauseReturnFocusRef: RefObject<HTMLElement | null>;
  disconnectReturnFocusRef: RefObject<HTMLElement | null>;
  onConfirmPause: () => Promise<void>;
  onClosePause: () => void;
  onConfirmDisconnect: () => Promise<void>;
  onCloseDisconnect: () => void;
  onCloseOutcome: () => void;
}): ReactElement {
  return (
    <>
      {pauseTarget ? (
        <ConfirmModal
          open
          title="Pause store integration?"
          description={`Moosewave will stop scheduled provider syncs for ${pauseTarget.shop_domain || pauseTarget.provider}. Already-imported commerce data is kept.`}
          confirmLabel="Pause integration"
          danger
          busy={pausing}
          returnFocusRef={pauseReturnFocusRef}
          onConfirm={onConfirmPause}
          onClose={onClosePause}
        />
      ) : null}
      {disconnectTarget ? (
        <ConfirmModal
          open
          title="Disconnect store integration?"
          description={`Moosewave will stop syncing ${disconnectTarget.shop_domain || disconnectTarget.provider} and mark the connection disconnected. Already-imported customers, products, and orders are kept.`}
          confirmLabel="Disconnect"
          danger
          busy={disconnecting}
          returnFocusRef={disconnectReturnFocusRef}
          onConfirm={onConfirmDisconnect}
          onClose={onCloseDisconnect}
        />
      ) : null}
      {disconnectOutcome ? (
        <DisconnectOutcomeModal
          result={disconnectOutcome}
          onClose={onCloseOutcome}
        />
      ) : null}
    </>
  );
}

function IntegrationSectionIntroduction({
  canAdmin,
  error,
  onConnect,
}: {
  canAdmin: boolean;
  error: string | null;
  onConnect: () => void;
}): ReactElement {
  return (
    <>
      <SectionHeader
        title="Connected stores"
        description="Review recorded provider state, freshness, and imported data. Every provider remains certification-pending; pausing or disconnecting keeps previously imported commerce records."
        actions={
          canAdmin ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onConnect}
            >
              + Connect store
            </button>
          ) : undefined
        }
      />
      {error ? (
        <div className="notice" role="alert">
          <span>
            Store integrations could not be verified. Check your connection and
            retry from Commerce.
          </span>
        </div>
      ) : null}
      {!canAdmin ? (
        <p className="muted commerce-role-note" role="note">
          You have view-only access. An administrator can connect, sync, pause,
          or disconnect stores.
        </p>
      ) : null}
    </>
  );
}

function DisconnectOutcomeModal({
  result,
  onClose,
}: {
  result: CommerceDisconnectResponse;
  onClose: () => void;
}): ReactElement {
  const cleanup = result.provider_cleanup;
  const providerActions = cleanup?.provider_console_actions ?? [];
  const postwaveEffects = cleanup?.postwave_effects ?? [];
  const evidence = cleanup?.provider_cleanup_evidence ?? [];
  const cleanupComplete =
    cleanup?.managed_provider_cleanup &&
    cleanup.webhook_cleanup_status === "completed" &&
    cleanup.credential_cleanup_status === "completed";

  return (
    <Modal
      open
      onClose={onClose}
      title="Connection disconnected"
      description="Moosewave stopped this connection locally. Review the provider cleanup boundary before considering the store fully removed."
    >
      <div
        className={`commerce-disconnect-summary${cleanupComplete ? " is-complete" : " needs-action"}`}
        role="status"
      >
        <span aria-hidden="true" />
        <div>
          <strong>
            {cleanupComplete
              ? "Managed cleanup recorded"
              : "Provider-side cleanup may still be required"}
          </strong>
          <p>
            {cleanup
              ? `${cleanup.provider} reported webhook cleanup as ${cleanup.webhook_cleanup_status} and credential cleanup as ${cleanup.credential_cleanup_status}.`
              : "The server did not return provider cleanup evidence. Treat external webhooks and credentials as unverified until an administrator confirms them in the provider console."}
          </p>
        </div>
      </div>

      {postwaveEffects.length > 0 ? (
        <section
          className="commerce-outcome-section"
          aria-labelledby="commerce-disconnect-postwave"
        >
          <h3 id="commerce-disconnect-postwave">Recorded in Moosewave</h3>
          <ul>
            {postwaveEffects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {providerActions.length > 0 ? (
        <section
          className="commerce-outcome-section"
          aria-labelledby="commerce-disconnect-provider"
        >
          <h3 id="commerce-disconnect-provider">Confirm in provider console</h3>
          <ul>
            {providerActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {evidence.length > 0 ? (
        <details className="commerce-cleanup-evidence">
          <summary>Review cleanup evidence</summary>
          <ul>
            {evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="commerce-boundary-copy">
        Imported customers, products, orders, events, and lifecycle records can
        remain after disconnect. This result is not a privacy erasure receipt.
      </p>

      <ModalFooter>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </ModalFooter>
    </Modal>
  );
}

function CommerceIntegrationList({
  rows,
  err,
  canAdmin,
  activeBrowseId,
  browsePanelId,
  syncingId,
  pausingId,
  actionsBusy,
  onConnect,
  onToggleBrowse,
  onSync,
  onPause,
  onDisconnect,
}: {
  rows: CommerceIntegration[] | null;
  err: string | null;
  canAdmin: boolean;
  activeBrowseId: string | null;
  browsePanelId: string;
  syncingId: string | null;
  pausingId: string | null;
  actionsBusy: boolean;
  onConnect: () => void;
  onToggleBrowse: (integration: CommerceIntegration) => void;
  onSync: (integration: CommerceIntegration) => void;
  onPause: (integration: CommerceIntegration) => void;
  onDisconnect: (integration: CommerceIntegration) => void;
}): ReactElement {
  if (rows === null) return <p className="muted">Loading integrations…</p>;
  if (rows.length === 0) {
    if (err) {
      return (
        <div className="list-empty">
          <div className="empty-state">
            <div className="empty-state-icon">·</div>
            <h3>Couldn&apos;t load integrations</h3>
            <p>
              Store integrations could not be verified. Check your connection
              and retry from Commerce.
            </p>
          </div>
        </div>
      );
    }
    return (
      <HeroEmptyState
        tone="neutral"
        eyebrow="Commerce"
        title="Plug your store into your email engine."
        subtitle="Connect Shopify to sync customers, products, and orders — then power cart recovery, back-in-stock alerts, price-drop watches, and product feeds in campaigns."
        imageSrc={HERO.discounts}
        imageAlt="Price tags representing store products"
        primaryCta={
          canAdmin ? { label: "Connect store", onClick: onConnect } : undefined
        }
        meta="Shopify opens provider authorization. Other partial providers use vaulted credential references; review each readiness summary before connecting."
      />
    );
  }
  return (
    <div
      className="list commerce-list commerce-integrations-list"
      role="table"
      aria-label="Store integrations"
      aria-rowcount={rows.length + 1}
      tabIndex={0}
    >
      <div role="rowgroup">
        <div
          className="list-header"
          role="row"
          style={{ gridTemplateColumns: INTEGRATION_COLS }}
        >
          <div role="columnheader">Store</div>
          <div role="columnheader">Provider</div>
          <div role="columnheader">Status</div>
          <div role="columnheader">Last sync</div>
          <div role="columnheader">Actions</div>
        </div>
      </div>
      <div role="rowgroup">
        {rows.map((integration) => (
          <CommerceIntegrationRow
            key={integration.id}
            integration={integration}
            canAdmin={canAdmin}
            browsing={activeBrowseId === integration.id}
            browsePanelId={browsePanelId}
            syncing={syncingId === integration.id}
            pausing={pausingId === integration.id}
            actionsBusy={actionsBusy}
            onToggleBrowse={() => onToggleBrowse(integration)}
            onSync={() => onSync(integration)}
            onPause={() => onPause(integration)}
            onDisconnect={() => onDisconnect(integration)}
          />
        ))}
      </div>
    </div>
  );
}

function CommerceIntegrationRow({
  integration,
  canAdmin,
  browsing,
  browsePanelId,
  syncing,
  pausing,
  actionsBusy,
  onToggleBrowse,
  onSync,
  onPause,
  onDisconnect,
}: {
  integration: CommerceIntegration;
  canAdmin: boolean;
  browsing: boolean;
  browsePanelId: string;
  syncing: boolean;
  pausing: boolean;
  actionsBusy: boolean;
  onToggleBrowse: () => void;
  onSync: () => void;
  onPause: () => void;
  onDisconnect: () => void;
}): ReactElement {
  const actionHelpId = useId();
  const tone = integrationTone(integration);
  const syncText = integrationSyncStateText(integration);
  const syncTone = integrationSyncStateTone(integration);
  const disconnected = integration.status.toLowerCase() === "disconnected";
  return (
    <div
      className="list-row"
      role="row"
      style={{ gridTemplateColumns: INTEGRATION_COLS, cursor: "default" }}
    >
      <div role="cell" style={{ minWidth: 0 }}>
        <div className="commerce-value" style={{ fontWeight: 500 }}>
          {integration.shop_domain || integration.id}
        </div>
        <div className="commerce-detail mono">
          Integration ID: {integration.id}
        </div>
        {integration.error_message ? (
          <div className="commerce-inline-error" role="status">
            The provider reported an integration error. Review the sync state
            and retry when ready.
          </div>
        ) : null}
        {syncText ? (
          <div
            className={`badge${syncTone === "neutral" ? "" : ` ${syncTone}`}`}
            style={{ display: "inline-block", marginTop: 6 }}
          >
            {syncText}
          </div>
        ) : null}
        {integration.sync_state?.last_error ? (
          <div className="commerce-inline-error">
            The most recent provider sync did not complete.
          </div>
        ) : null}
      </div>
      <div
        role="cell"
        className="muted commerce-value"
        style={{ fontSize: 12 }}
      >
        {integration.provider}
      </div>
      <div role="cell">
        <span
          className={`badge${tone.tone === "neutral" ? "" : ` ${tone.tone}`}`}
        >
          {tone.label}
        </span>
      </div>
      <div role="cell" className="muted tabular" style={{ fontSize: 12 }}>
        <CommerceTime value={integration.last_sync_at} />
      </div>
      <div
        role="cell"
        className="commerce-row-actions"
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 6,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onToggleBrowse}
          aria-expanded={browsing}
          aria-controls={browsePanelId}
          aria-label={`${browsing ? "Hide" : "Browse"} data for ${integration.shop_domain || integration.provider}`}
        >
          {browsing ? "Hide data" : "Browse data"}
        </button>
        {canAdmin ? (
          <>
            {!disconnected ? (
              <button
                type="button"
                className="btn btn-sm"
                aria-disabled={actionsBusy || syncing || undefined}
                aria-describedby={actionHelpId}
                aria-busy={syncing || undefined}
                onClick={() => {
                  if (!actionsBusy && !syncing) onSync();
                }}
              >
                {syncing ? "Syncing…" : "Sync now"}
              </button>
            ) : null}
            {!disconnected && integration.status.toLowerCase() !== "paused" ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-disabled={actionsBusy || pausing || undefined}
                aria-describedby={actionHelpId}
                aria-busy={pausing || undefined}
                onClick={() => {
                  if (!actionsBusy && !pausing) onPause();
                }}
              >
                Pause
              </button>
            ) : null}
            {!disconnected ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-disabled={actionsBusy || syncing || undefined}
                aria-describedby={actionHelpId}
                onClick={() => {
                  if (!actionsBusy && !syncing) onDisconnect();
                }}
              >
                Disconnect
              </button>
            ) : null}
          </>
        ) : null}
        {canAdmin && !disconnected ? (
          <span id={actionHelpId} className="commerce-action-help">
            {actionsBusy
              ? "Another store action is running. Wait for it to finish."
              : "Sync pulls the latest provider data. Pause stops scheduled syncs. Disconnect keeps imported data."}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CommerceAdministrationNotice({
  intent,
  target,
  loading,
  loadError,
  canAdmin,
  busy,
  onDismiss,
  onConnect,
  onSync,
  onPause,
  onDisconnect,
}: {
  intent: CommerceAdministrationIntent;
  target: CommerceIntegration | null;
  loading: boolean;
  loadError: string | null;
  canAdmin: boolean;
  busy: boolean;
  onDismiss: () => void;
  onConnect: () => void;
  onSync: () => void;
  onPause: () => void;
  onDisconnect: () => void;
}): ReactElement {
  const actionReasonId = useId();
  const storeLabel = target?.shop_domain || target?.provider || intent.provider;
  const mutation = intent.task !== "manage";
  const alreadyPaused = target?.status.toLowerCase() === "paused";
  const disconnected = target?.status.toLowerCase() === "disconnected";
  let message: string;
  if (loading) {
    message = `Finding the ${intent.provider} store connection…`;
  } else if (loadError) {
    message = `Commerce couldn't load the ${intent.provider} connection required for this action.`;
  } else if (!canAdmin && mutation) {
    message = `Admin access is required to ${intent.task} ${storeLabel}. No store action has run.`;
  } else if (!target) {
    message = intent.integrationId
      ? `The requested ${intent.provider} store connection no longer exists or no longer matches this provider. No store action has run.`
      : `No ${intent.provider} store connection matches this request. Connect the provider here before managing it.`;
  } else if (intent.task === "manage") {
    message = `Store data and operational health for ${storeLabel} are open below on their canonical Commerce owner.`;
  } else if (intent.task === "connect") {
    message = `${storeLabel} is already connected. No duplicate connection dialog was opened.`;
  } else if (disconnected) {
    message = `${storeLabel} is already disconnected. No store action has run.`;
  } else if (intent.task === "pause" && alreadyPaused) {
    message = `${storeLabel} is already paused. No store action has run.`;
  } else {
    const action = intent.task === "backfill" ? "sync/backfill" : intent.task;
    message = `Ready to ${action} ${storeLabel}. Review and start the action here; opening this route never runs it automatically.`;
  }

  return (
    <div
      className="notice"
      role={loadError ? "alert" : "status"}
      aria-live="polite"
      style={{ marginBottom: 16 }}
    >
      <span>{message}</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {!loading &&
        !loadError &&
        !target &&
        !intent.integrationId &&
        canAdmin ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onConnect}
          >
            Connect {intent.provider}
          </button>
        ) : null}
        {target && canAdmin && mutation && !disconnected ? (
          intent.task === "sync" || intent.task === "backfill" ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              aria-disabled={busy || undefined}
              aria-describedby={busy ? actionReasonId : undefined}
              aria-busy={busy || undefined}
              onClick={() => {
                if (!busy) onSync();
              }}
            >
              {busy
                ? "Starting…"
                : intent.task === "backfill"
                  ? "Start sync/backfill"
                  : "Sync now"}
            </button>
          ) : intent.task === "pause" && !alreadyPaused ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              aria-disabled={busy || undefined}
              aria-describedby={busy ? actionReasonId : undefined}
              onClick={() => {
                if (!busy) onPause();
              }}
            >
              Review pause
            </button>
          ) : intent.task === "disconnect" ? (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              aria-disabled={busy || undefined}
              aria-describedby={busy ? actionReasonId : undefined}
              onClick={() => {
                if (!busy) onDisconnect();
              }}
            >
              Review disconnect
            </button>
          ) : null
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-disabled={busy || undefined}
          aria-describedby={busy ? actionReasonId : undefined}
          onClick={() => {
            if (!busy) onDismiss();
          }}
        >
          Dismiss
        </button>
        {busy ? (
          <span id={actionReasonId} className="commerce-action-help">
            Wait for the active store request to finish.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- Provider connect ---------- */

function providerSelectionError(
  providers: CommerceProviderSpec[] | null,
): string {
  return providers === null
    ? "Providers are still loading."
    : "Choose an available commerce provider.";
}

function providerPlaceholder(providers: CommerceProviderSpec[] | null): string {
  return providers === null ? "Loading providers..." : "No providers available";
}

function normalizeShopifyDomain(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  if (!candidate || /[/?#@]/u.test(candidate)) return null;
  try {
    const parsed = new URL(`https://${candidate}`);
    if (
      parsed.port ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname.endsWith(".myshopify.com") ||
      parsed.hostname === "myshopify.com"
    ) {
      return null;
    }
    return parsed.hostname;
  } catch {
    return null;
  }
}

function verifiedShopifyAuthorizationUrl(
  value: string,
  shopDomain: string,
): string | null {
  try {
    const parsed = new URL(value);
    const approvedHost =
      parsed.hostname === shopDomain ||
      parsed.hostname === "accounts.shopify.com" ||
      parsed.hostname.endsWith(".shopify.com");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !approvedHost
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function StoreConnectModal({
  onClose,
  onConnected,
  initialProvider,
  returnFocusRef,
}: {
  onClose: () => void;
  onConnected: () => Promise<void>;
  initialProvider?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}): ReactElement {
  const [providerKey, setProviderKey] = useState(
    initialProvider?.trim() || "shopify",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [providerSwitchTarget, setProviderSwitchTarget] = useState<
    string | null
  >(null);
  const providerRetryRef = useRef<Promise<void> | null>(null);
  const providerResource = useRemoteResource<CommerceProviderSpec[]>(
    async () => {
      const result = await commerceApi.listProviders();
      if (result.error) return { error: result.error };
      const items = result.data?.items;
      if (!Array.isArray(items)) {
        return {
          error: { message: "Invalid provider registry", kind: "parse" },
        };
      }
      return { data: items };
    },
    { identity: "commerce-provider-registry" },
  );
  const providers =
    providerResource.data ??
    (providerResource.transport === "error" ? [] : null);
  const lifecycle = useCredentialDraftLifecycle({
    ownerId: "commerce-store-connect",
    label: "Store connection credentials",
    values,
    setValues,
    busy,
    onClose,
  });

  useEffect(() => {
    const items = providerResource.data;
    if (!items) return;
    setProviderKey((current) => {
      if (items.some((provider) => provider.provider === current)) {
        return current;
      }
      if (initialProvider) {
        setErr(
          `${initialProvider} isn't available in the Commerce provider registry. Choose another provider or close this dialog.`,
        );
        setErrorField("provider");
        return current;
      }
      return items[0]?.provider ?? current;
    });
  }, [initialProvider, providerResource.data]);

  const retryProviders = (): void => {
    if (providerRetryRef.current) return;
    setErr(null);
    setErrorField(null);
    const request = providerResource.reload();
    providerRetryRef.current = request;
    void request.finally(() => {
      if (providerRetryRef.current === request) providerRetryRef.current = null;
    });
  };

  const providerOptions = providers ?? [];
  const selected =
    providerOptions.find((provider) => provider.provider === providerKey) ??
    null;
  const formFields = selected
    ? [...selected.required_settings, ...(selected.optional_settings ?? [])]
    : [];
  const isFoundation = selected?.sync_model === "postwave_commerce_ingest";
  const providerLoading = providerResource.transport === "loading";
  const providerUnavailable =
    selected?.runtime_status === "planned" ||
    selected?.runtime_status === "unavailable";
  const operationReasonId = useId();

  const fieldValue = (key: string): string => values[key] ?? "";
  const setValue = (key: string, value: string): void => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const connect = async (): Promise<void> => {
    if (providerLoading) {
      setErr("Wait for the provider registry to finish loading.");
      setErrorField("provider");
      return;
    }
    if (!selected) {
      setErr(providerSelectionError(providers));
      setErrorField("provider");
      return;
    }
    if (providerUnavailable) {
      setErr(
        `${selected.name} cannot be connected while its runtime is ${selected.runtime_status}.`,
      );
      setErrorField("provider");
      return;
    }
    let shopDomain = "";
    const settings: Record<string, unknown> = {};
    if (selected.provider === "shopify") {
      const normalizedDomain = normalizeShopifyDomain(
        fieldValue("shop_domain"),
      );
      if (!normalizedDomain) {
        setErr(
          "Enter a valid *.myshopify.com shop domain without a scheme, path, or credentials.",
        );
        setErrorField("shop_domain");
        return;
      }
      shopDomain = normalizedDomain;
    } else {
      for (const field of formFields) {
        const value = fieldValue(field.key).trim();
        if (field.required && !value) {
          setErr(`${field.label} is required.`);
          setErrorField(field.key);
          return;
        }
        if (value) settings[field.key] = value;
      }
    }

    if (!lifecycle.beginOperation()) return;
    setBusy(true);
    setErr(null);
    setErrorField(null);
    let success: "oauth" | "connected" | null = null;
    let refreshFailed = false;
    try {
      if (selected.provider === "shopify") {
        const res = await commerceApi.startShopifyOAuth(shopDomain);
        if (res.error) {
          setErr(safeCommerceFailure(res.error));
          return;
        }
        const url = res.data?.authorize_url;
        if (!url) {
          setErr("The server didn't return an authorize URL.");
          return;
        }
        const verifiedUrl = verifiedShopifyAuthorizationUrl(url, shopDomain);
        if (!verifiedUrl) {
          setErr(
            "The authorization destination failed the Shopify safety check. No browser was opened.",
          );
          return;
        }
        await tauriApi.openUrl(verifiedUrl);
        success = "oauth";
      } else {
        const credentialRef = String(settings.credential_ref ?? "").trim();
        const res = await commerceApi.createIntegration({
          provider: selected.provider,
          settings,
          credential_ref: credentialRef || undefined,
        });
        if (res.error) {
          setErr(safeCommerceFailure(res.error));
          return;
        }
        success = "connected";
        try {
          await onConnected();
        } catch {
          refreshFailed = true;
        }
      }
    } catch {
      setErr(
        "The store connection couldn't be completed. Check your connection and retry.",
      );
    } finally {
      lifecycle.finishOperation();
      setBusy(false);
    }
    if (!success) return;
    try {
      if (success === "oauth") {
        toast.info(
          "Shopify authorization opened in your browser. The integration appears here after approval.",
        );
      } else {
        toast.success(`${selected.name} connection saved.`);
      }
      if (refreshFailed) {
        toast.info(
          "The connection succeeded, but this list couldn't refresh. Reopen the page to verify it.",
        );
      }
    } finally {
      lifecycle.closeAfterSuccess();
    }
  };

  return (
    <>
      <StoreConnectDialog
        providers={providers}
        providerOptions={providerOptions}
        providerKey={providerKey}
        selected={selected}
        formFields={formFields}
        isFoundation={isFoundation}
        providerLoading={providerLoading}
        providerUnavailable={providerUnavailable}
        providerFailure={providerResource.failure !== null}
        busy={busy}
        err={err}
        errorField={errorField}
        operationReasonId={operationReasonId}
        operationActive={lifecycle.operationActive}
        fieldValue={fieldValue}
        returnFocusRef={returnFocusRef}
        onClose={lifecycle.requestClose}
        onRetryProviders={retryProviders}
        onSubmit={connect}
        onProviderChange={(nextProvider) => {
          if (lifecycle.dirty) {
            setProviderSwitchTarget(nextProvider);
            return;
          }
          setProviderKey(nextProvider);
          setErr(null);
          setErrorField(null);
        }}
        onFieldChange={(fieldKey, value) => {
          setValue(fieldKey, value);
          if (errorField === fieldKey) {
            setErr(null);
            setErrorField(null);
          }
        }}
      />
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard store credentials?"
        description="Every unsaved credential and reference in this dialog will be cleared from memory."
        confirmLabel="Discard credentials"
        cancelLabel="Keep editing"
        danger
        busy={lifecycle.operationActive}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
      <ConfirmModal
        open={providerSwitchTarget !== null}
        title="Discard credentials and switch provider?"
        description="Switching providers clears every unsaved credential and reference in this dialog."
        confirmLabel="Discard and switch"
        cancelLabel="Keep editing"
        danger
        busy={lifecycle.operationActive}
        onConfirm={() => {
          if (!providerSwitchTarget || lifecycle.operationActive) return;
          setValues({});
          setProviderKey(providerSwitchTarget);
          setProviderSwitchTarget(null);
          setErr(null);
          setErrorField(null);
        }}
        onClose={() => setProviderSwitchTarget(null)}
      />
    </>
  );
}

function StoreConnectDialog({
  providers,
  providerOptions,
  providerKey,
  selected,
  formFields,
  isFoundation,
  providerLoading,
  providerUnavailable,
  providerFailure,
  busy,
  err,
  errorField,
  operationReasonId,
  operationActive,
  fieldValue,
  returnFocusRef,
  onClose,
  onRetryProviders,
  onSubmit,
  onProviderChange,
  onFieldChange,
}: {
  providers: CommerceProviderSpec[] | null;
  providerOptions: CommerceProviderSpec[];
  providerKey: string;
  selected: CommerceProviderSpec | null;
  formFields: CommerceProviderField[];
  isFoundation: boolean;
  providerLoading: boolean;
  providerUnavailable: boolean;
  providerFailure: boolean;
  busy: boolean;
  err: string | null;
  errorField: string | null;
  operationReasonId: string;
  operationActive: boolean;
  fieldValue: (key: string) => string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onRetryProviders: () => void;
  onSubmit: () => Promise<void>;
  onProviderChange: (provider: string) => void;
  onFieldChange: (field: string, value: string) => void;
}): ReactElement {
  const unavailable =
    busy || providerLoading || providerUnavailable || !selected;
  return (
    <Modal
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      closeOnBackdrop={!operationActive}
      closeOnEscape={!operationActive}
      title="Connect store"
      description="Choose a partial, certification-pending provider. Shopify opens provider authorization; other providers use vaulted credential references for the capabilities listed below."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!unavailable) void onSubmit();
        }}
      >
        {providerFailure ? (
          <div className="notice commerce-resource-notice" role="alert">
            <span>
              Store provider setup couldn&apos;t be loaded. Check your
              connection and retry.
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onRetryProviders}
            >
              Retry providers
            </button>
          </div>
        ) : null}
        {err && errorField === null ? (
          <div className="notice" role="alert">
            <span>{err}</span>
          </div>
        ) : null}
        <FormField
          label="Provider"
          required
          error={errorField === "provider" ? err : null}
          help={
            providerLoading
              ? "Loading the provider registry…"
              : `${providerOptions.length.toLocaleString()} provider record${providerOptions.length === 1 ? "" : "s"} in this environment. Every current provider remains partial and certification-pending.`
          }
        >
          <select
            value={providerKey}
            onChange={(event) => onProviderChange(event.target.value)}
            disabled={busy || providerLoading}
          >
            {providerOptions.length === 0 ? (
              <option value={providerKey}>
                {providerPlaceholder(providers)}
              </option>
            ) : (
              <>
                {!selected ? (
                  <option value={providerKey} disabled>
                    {providerKey} unavailable
                  </option>
                ) : null}
                {providerOptions.map((provider) => (
                  <option key={provider.provider} value={provider.provider}>
                    {provider.name}
                  </option>
                ))}
              </>
            )}
          </select>
        </FormField>
        {selected ? (
          <>
            <ProviderRuntimeSummary
              provider={selected}
              isFoundation={isFoundation}
            />
            {providerUnavailable ? (
              <div className="notice" role="status">
                <span>
                  {selected.name} is marked {selected.runtime_status} in this
                  environment and cannot be connected yet.
                </span>
              </div>
            ) : null}
            {formFields.map((field) => (
              <ProviderFieldInput
                key={field.key}
                field={field}
                value={fieldValue(field.key)}
                busy={busy}
                error={errorField === field.key ? err : null}
                onChange={(value) => onFieldChange(field.key, value)}
              />
            ))}
          </>
        ) : null}
        <p
          id={operationReasonId}
          className="muted commerce-operation-status"
          role="status"
          aria-live="polite"
        >
          {busy
            ? "Connection request in progress. Fields and dismissal stay locked until it finishes."
            : providerUnavailable
              ? "Choose a provider whose runtime is available or partial."
              : "This creates a partial, certification-pending connection. Credentials remain in memory only until you save or explicitly discard this draft."}
        </p>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            aria-disabled={busy || undefined}
            aria-describedby={operationReasonId}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            aria-disabled={unavailable || undefined}
            aria-describedby={operationReasonId}
            aria-busy={busy || undefined}
          >
            {busy
              ? "Connecting..."
              : selected?.provider === "shopify"
                ? "Open Shopify authorization"
                : "Save connection"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function ProviderRuntimeSummary({
  provider,
  isFoundation,
}: {
  provider: CommerceProviderSpec;
  isFoundation: boolean;
}): ReactElement {
  return (
    <div className="stat-grid" style={{ marginBottom: 12 }}>
      <div className="stat-card">
        <div className="stat-label">Readiness</div>
        <div className="stat-value commerce-value" style={{ fontSize: 16 }}>
          {provider.runtime_status === "partial"
            ? "Partial · certification pending"
            : provider.runtime_status}
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          {isFoundation ? "Import objects" : "Objects"}
        </div>
        <div className="stat-value commerce-value" style={{ fontSize: 18 }}>
          {provider.sync_objects.join(", ") || "None declared"}
        </div>
      </div>
      {provider.verification_mode ? (
        <div className="stat-card">
          <div className="stat-label">Verification</div>
          <div className="stat-value commerce-value" style={{ fontSize: 18 }}>
            {provider.verification_mode}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProviderFieldInput({
  field,
  value,
  busy,
  error,
  onChange,
}: {
  field: CommerceProviderField;
  value: string;
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <FormField
      label={field.label}
      required={field.required}
      help={field.help}
      error={error}
    >
      <input
        type={field.secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy}
        autoComplete={field.secret ? "new-password" : "off"}
        autoCapitalize="none"
        spellCheck={false}
      />
    </FormField>
  );
}

/* ---------- browse: analytics + customers/products/orders/events ---------- */
