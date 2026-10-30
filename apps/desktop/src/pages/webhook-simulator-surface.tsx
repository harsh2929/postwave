import { type ReactElement, type RefObject, useId } from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { InlineHelp } from "../components/InlineHelp";
import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { SectionHeader } from "../components/SectionHeader";
import { ValuePropCard } from "../components/ValuePropCard";
import {
  RecentFiresPanel,
  type RecentFire,
} from "../components/webhook-simulator/RecentFiresPanel";
import {
  ResponseInspector,
  sanitizeInspectableUrl,
  type FireResponse,
} from "../components/webhook-simulator/ResponseInspector";
import { SavedPayloadsPanel } from "../components/webhook-simulator/SavedPayloadsPanel";
import { VerificationSnippetDialog } from "../components/webhooks/VerificationSnippetDialog";
import type {
  OutboundWebhook,
  WebhookPlaygroundFireReceipt,
} from "../lib/api-client";
import { HERO } from "../lib/heroAssets";
import { setSection } from "../lib/store";

export interface EventCatalogEntry {
  event_type: string;
  sample_payload: Record<string, unknown>;
}

export interface FireSnapshot {
  fireID: string;
  idempotencyKey: string;
  webhookID: string;
  webhookConfigVersion: number;
  webhookURL: string;
  eventType: string;
  payload: string;
}

export type FireReconciliationPhase =
  | "unknown"
  | "not_registered"
  | "pending"
  | "recoverable"
  | "ambiguous"
  | "receipt_expired"
  | "checkpoint_cleanup";

export interface FireReconciliation {
  snapshot: FireSnapshot;
  phase: FireReconciliationPhase;
  detail: string;
  receipt: WebhookPlaygroundFireReceipt | null;
}

export interface PayloadReplacement {
  source: string;
  payload: string;
  eventType: string;
  webhookID?: string;
}

export const MAX_RECENT_FIRES = 8;
export const MAX_SIMULATOR_PAYLOAD_BYTES = 256 * 1024;
const simulatorTextEncoder = new TextEncoder();

export function simulatorPayloadBytes(payload: string): number {
  return simulatorTextEncoder.encode(payload).byteLength;
}

interface WebhookSimulatorToolbarProps {
  webhooks: OutboundWebhook[];
  events: EventCatalogEntry[];
  webhookID: string;
  eventType: string;
  payloadEmpty: boolean;
  payloadBytes: number;
  sending: boolean;
  checkingReceipt: boolean;
  unresolvedFire: boolean;
  recoveryUnavailableReason: string | null;
  catalogReady: boolean;
  moreTargetsAvailable: boolean;
  loadingMoreTargets: boolean;
  targetLoadError: string | null;
  selectedWebhook: OutboundWebhook | undefined;
  verifyOpen: boolean;
  onWebhookChange: (id: string) => void;
  onEventChange: (eventType: string) => void;
  onFire: () => void;
  onCancel: () => void;
  onVerify: () => void;
  onLoadMoreTargets: () => void;
}

function signingAlgorithmLabel(
  algorithm: OutboundWebhook["signing_algorithm"] | undefined,
): string {
  switch (algorithm) {
    case "ecdsa_p256":
      return "ECDSA P-256";
    case "ed25519":
      return "Ed25519";
    case "hmac_sha256":
    default:
      return "HMAC-SHA256";
  }
}

export function webhookFireReadinessReason(
  webhook: OutboundWebhook | undefined,
): string | null {
  if (!webhook) return "Add an outbound webhook before firing an event.";
  if (!webhook.active) return "Resume this paused webhook before firing.";
  if (webhook.url_status !== "ready") {
    return "Repair the destination URL before firing.";
  }
  if (webhook.auth_config_status !== "ready") {
    return "Finish securing receiver authentication before firing.";
  }
  if (webhook.delivery_policy_status !== "ready") {
    return "Repair the delivery filter or transform before firing.";
  }
  return null;
}

function WebhookSimulatorToolbar({
  webhooks,
  events,
  webhookID,
  eventType,
  payloadEmpty,
  payloadBytes,
  sending,
  checkingReceipt,
  unresolvedFire,
  recoveryUnavailableReason,
  catalogReady,
  moreTargetsAvailable,
  loadingMoreTargets,
  targetLoadError,
  selectedWebhook,
  verifyOpen,
  onWebhookChange,
  onEventChange,
  onFire,
  onCancel,
  onVerify,
  onLoadMoreTargets,
}: WebhookSimulatorToolbarProps): ReactElement {
  const fireReasonId = useId();
  const verifyHelpId = useId();
  const targetReadinessReason = webhookFireReadinessReason(selectedWebhook);
  const fireUnavailableReason = sending
    ? checkingReceipt
      ? "Wait for the current receipt check to finish."
      : "Wait for the current test delivery to finish."
    : unresolvedFire
      ? "Resolve the previous logical fire before creating another."
      : recoveryUnavailableReason
        ? recoveryUnavailableReason
        : !catalogReady
          ? "Refresh the simulator catalog successfully before firing."
          : targetReadinessReason
            ? targetReadinessReason
            : !eventType
              ? "Choose an event type before firing."
              : payloadEmpty
                ? "Enter a JSON object in the payload editor before firing."
                : payloadBytes > MAX_SIMULATOR_PAYLOAD_BYTES
                  ? "Reduce the payload to 262,144 UTF-8 bytes or fewer before firing."
                  : null;
  return (
    <>
      <div
        className="mcp-filter-row wh-simulator-toolbar"
        role="group"
        aria-label="Webhook simulator controls"
      >
        <label>
          <span
            className="muted small"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            Target webhook
            <InlineHelp text="The outbound subscription that will receive this synthetic event. Its configured HMAC or asymmetric signing key produces the X-Postwave-Signature header." />
          </span>
          <select
            value={webhookID}
            onChange={(event) => onWebhookChange(event.target.value)}
            disabled={sending || !catalogReady || webhooks.length === 0}
          >
            {webhooks.length === 0 ? (
              <option value="">(no webhooks configured)</option>
            ) : null}
            {webhooks.map((webhook) => (
              <option key={webhook.id} value={webhook.id}>
                {webhook.description || sanitizeInspectableUrl(webhook.url).url}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span
            className="muted small"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            Event type
            <InlineHelp text="Picking an event type fills the payload editor with a sample payload where one is registered. Some events have no representative sample yet — craft those to match your event contract before firing." />
          </span>
          <select
            value={eventType}
            onChange={(event) => onEventChange(event.target.value)}
            disabled={sending || !catalogReady || events.length === 0}
          >
            {events.map((event) => (
              <option key={event.event_type} value={event.event_type}>
                {event.event_type}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (!fireUnavailableReason) onFire();
          }}
          aria-disabled={fireUnavailableReason ? "true" : "false"}
          aria-describedby={fireReasonId}
          aria-busy={sending ? "true" : undefined}
        >
          {checkingReceipt
            ? "Checking receipt…"
            : sending
              ? "Firing…"
              : "Fire event"}
        </button>
        {sending ? (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {checkingReceipt
              ? "Stop receipt check"
              : "Stop waiting & reconcile"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onVerify}
          aria-haspopup="dialog"
          aria-expanded={verifyOpen ? "true" : "false"}
          aria-describedby={verifyHelpId}
          disabled={!catalogReady || !selectedWebhook || sending}
        >
          Verify signature →
        </button>
        {moreTargetsAvailable ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onLoadMoreTargets}
            disabled={!catalogReady || sending || loadingMoreTargets}
          >
            {loadingMoreTargets
              ? "Loading targets…"
              : targetLoadError
                ? "Retry more targets"
                : "Load more targets"}
          </button>
        ) : null}
      </div>

      <p id={fireReasonId} className="muted small" style={{ margin: 0 }}>
        {fireUnavailableReason ??
          `Fires one real ${signingAlgorithmLabel(selectedWebhook?.signing_algorithm)}-signed POST. The receiver may execute real side effects.`}
      </p>
      {targetLoadError ? (
        <p className="field-error" role="alert" style={{ margin: 0 }}>
          Couldn&apos;t load more webhook targets: {targetLoadError}
        </p>
      ) : null}
      <p id={verifyHelpId} className="sr-only">
        Open signature-verification examples for three programming languages.
      </p>

      {selectedWebhook ? (
        <p className="muted small" style={{ margin: 0 }}>
          Target:{" "}
          <code style={{ overflowWrap: "anywhere" }}>
            {sanitizeInspectableUrl(selectedWebhook.url).url}
          </code>
          {" · "}
          Signing: {signingAlgorithmLabel(selectedWebhook.signing_algorithm)}
          {" · "}
          {selectedWebhook.active ? "Active" : "Paused"}
        </p>
      ) : null}
    </>
  );
}

export function SimulatorIntro({
  webhooks,
  eventCount,
  loading,
  error,
  sending,
  checkingReceipt,
  actionStatus,
  onLoad,
}: {
  webhooks: OutboundWebhook[];
  eventCount: number;
  loading: boolean;
  error: string | null;
  sending: boolean;
  checkingReceipt: boolean;
  actionStatus: string | null;
  onLoad: () => void;
}): ReactElement {
  const statusId = useId();
  return (
    <>
      <PageHeader
        eyebrow="Developer"
        title="Webhook Simulator"
        subtitle="Pick a webhook, review one real signed request, and inspect its durable outcome. Copy a non-executable verification scaffold or verify the exact signature bytes your handler should check."
        actions={[
          {
            label: loading ? "Refreshing…" : "Refresh catalog",
            onClick: onLoad,
            variant: "ghost",
            disabled: loading || sending,
            title: sending
              ? checkingReceipt
                ? "Wait for the current receipt check to finish."
                : "Wait for the current test delivery to finish."
              : loading
                ? "The webhook and event catalogs are already refreshing."
                : "Reload webhook targets and event samples from the server.",
          },
        ]}
      />
      <p className="muted small" style={{ margin: "0 0 12px" }}>
        <strong>Use synthetic data only.</strong> Do not paste customer personal
        data or secrets. Simulator fires make a real receiver request; the
        inspectable request and bounded receiver response are stored in an
        envelope-encrypted private receipt under your webhook-delivery retention
        policy. Retention cryptoshreds the ledger receipt. Email lookup is
        limited to the newest 100 matches for one literal address, with no alias
        expansion or continuation. A direct-ledger erasure helper can match
        current known aliases, but public erasure remains coverage-gated and
        unavailable. A name, phone, or ID without that email is not
        discoverable, and access-bundle copies are outside this receipt
        lifecycle. A payload-free fire identity remains to prevent redispatch.
      </p>
      <div id={statusId} className="sr-only" role="status" aria-live="polite">
        {actionStatus}
      </div>
      {error ? (
        <Notice
          tone="danger"
          announcement="assertive"
          style={{ marginBottom: 12 }}
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={onLoad}
              aria-disabled={loading ? "true" : "false"}
            >
              {loading ? "Retrying…" : "Retry"}
            </button>
          }
        >
          Couldn&apos;t load simulator data: {error}
        </Notice>
      ) : null}
      {loading && webhooks.length === 0 && eventCount === 0 ? (
        <Notice
          tone="neutral"
          announcement="polite"
          style={{ marginBottom: 12 }}
        >
          Loading webhook targets and event samples…
        </Notice>
      ) : null}
      {webhooks.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <ValuePropCard
            title="Real signatures and bytes — explicit test marker"
            body="The Simulator uses each destination's configured HMAC-SHA256, ECDSA P-256, or Ed25519 signer and sends X-Postwave-Test: true. That marker is advisory: the exact transformed body and signature use the live path, and the receiver can still execute real side effects."
          />
        </div>
      ) : !loading && !error ? (
        <div style={{ marginBottom: 16 }}>
          <HeroEmptyState
            tone="sand"
            eyebrow="Developer"
            title="No outbound webhooks configured yet"
            subtitle="You can still preview the event catalog and craft payloads below. To actually fire a signed POST at your handler, add an outbound webhook first."
            imageSrc={HERO.webhookSimulator}
            imageAlt="A glass laboratory flask with teal liquid"
            primaryCta={{
              label: "Add outbound webhook",
              onClick: () => setSection("webhooks"),
            }}
          />
        </div>
      ) : null}
      {!loading && eventCount === 0 ? (
        <Notice
          tone="warning"
          announcement="assertive"
          style={{ marginBottom: 12 }}
        >
          No event samples are available. Refresh after the server event catalog
          is configured; firing is unavailable until then.
        </Notice>
      ) : null}
    </>
  );
}

function FireReconciliationNotice({
  reconciliation,
  acknowledged,
  busy,
  onCheck,
  onRecover,
  onSettle,
  onAcknowledgedChange,
  onRelease,
}: {
  reconciliation: FireReconciliation;
  acknowledged: boolean;
  busy: boolean;
  onCheck: () => void;
  onRecover: () => void;
  onSettle: () => void;
  onAcknowledgedChange: (checked: boolean) => void;
  onRelease: () => void;
}): ReactElement {
  const isTerminalAmbiguity = reconciliation.phase === "ambiguous";
  const isCheckpointCleanup = reconciliation.phase === "checkpoint_cleanup";
  const isReceiptExpired = reconciliation.phase === "receipt_expired";
  const canRecover =
    reconciliation.phase === "not_registered" ||
    reconciliation.phase === "recoverable";
  const action =
    isCheckpointCleanup || isReceiptExpired ? (
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        onClick={onSettle}
      >
        {isReceiptExpired
          ? "Clear local recovery checkpoint"
          : "Retry encrypted cleanup"}
      </button>
    ) : isTerminalAmbiguity ? (
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy || !acknowledged}
        onClick={onRelease}
      >
        Allow a new logical fire
      </button>
    ) : canRecover ? (
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        onClick={onRecover}
      >
        {reconciliation.phase === "recoverable"
          ? "Restore retained response"
          : "Continue this same fire"}
      </button>
    ) : (
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        onClick={onCheck}
      >
        {busy ? "Checking receipt…" : "Check server receipt"}
      </button>
    );
  return (
    <Notice
      tone={
        isTerminalAmbiguity || isCheckpointCleanup || isReceiptExpired
          ? "danger"
          : "warning"
      }
      announcement="assertive"
      action={action}
    >
      <strong>
        {isCheckpointCleanup
          ? "The local recovery fence could not be cleared."
          : isReceiptExpired
            ? "Private receipt details have expired."
            : isTerminalAmbiguity
              ? "Receiver outcome needs human verification."
              : "This logical fire is awaiting reconciliation."}
      </strong>{" "}
      {reconciliation.detail} No automatic or new-identity retry will run.
      <div className="wh-simulator-fire-identity">
        Fire ID: <code>{reconciliation.snapshot.fireID}</code>
      </div>
      {isTerminalAmbiguity ? (
        <label className="wh-simulator-ambiguity-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={(event) =>
              onAcknowledgedChange(event.currentTarget.checked)
            }
          />
          I checked the receiver and accept that its side effect may already
          have happened.
        </label>
      ) : null}
    </Notice>
  );
}

export function SimulatorWorkspace({
  webhooks,
  events,
  webhookID,
  eventType,
  payload,
  payloadDirty,
  payloadError,
  fireError,
  fireRequiresRefresh,
  reconciliation,
  reconciliationAcknowledged,
  response,
  responseContext,
  recentFires,
  sending,
  checkingReceipt,
  recoveryUnavailableReason,
  catalogReady,
  moreTargetsAvailable,
  loadingMoreTargets,
  targetLoadError,
  selectedWebhook,
  samplePlaceholder,
  verifyOpen,
  payloadEditorRef,
  responseRegionRef,
  onWebhookChange,
  onEventChange,
  onPayloadChange,
  onFire,
  onCancelFire,
  onCheckReceipt,
  onRecoverFire,
  onSettleFire,
  onReconciliationAcknowledgedChange,
  onReleaseAmbiguousFire,
  onRefreshCatalog,
  onVerify,
  onLoadMoreTargets,
  onRetryRecovery,
  onApplySaved,
  onApplyRecent,
  onRequestClearHistory,
}: {
  webhooks: OutboundWebhook[];
  events: EventCatalogEntry[];
  webhookID: string;
  eventType: string;
  payload: string;
  payloadDirty: boolean;
  payloadError: string | null;
  fireError: string | null;
  fireRequiresRefresh: boolean;
  reconciliation: FireReconciliation | null;
  reconciliationAcknowledged: boolean;
  response: FireResponse | null;
  responseContext: FireSnapshot | null;
  recentFires: RecentFire[];
  sending: boolean;
  checkingReceipt: boolean;
  recoveryUnavailableReason: string | null;
  catalogReady: boolean;
  moreTargetsAvailable: boolean;
  loadingMoreTargets: boolean;
  targetLoadError: string | null;
  selectedWebhook: OutboundWebhook | undefined;
  samplePlaceholder: boolean;
  verifyOpen: boolean;
  payloadEditorRef: RefObject<HTMLTextAreaElement | null>;
  responseRegionRef: RefObject<HTMLDivElement | null>;
  onWebhookChange: (id: string) => void;
  onEventChange: (eventType: string) => void;
  onPayloadChange: (payload: string) => void;
  onFire: () => void;
  onCancelFire: () => void;
  onCheckReceipt: () => void;
  onRecoverFire: () => void;
  onSettleFire: () => void;
  onReconciliationAcknowledgedChange: (checked: boolean) => void;
  onReleaseAmbiguousFire: () => void;
  onRefreshCatalog: () => void;
  onVerify: () => void;
  onLoadMoreTargets: () => void;
  onRetryRecovery: () => void;
  onApplySaved: (payload: string, eventType: string) => void;
  onApplyRecent: (fire: RecentFire) => void;
  onRequestClearHistory: () => void;
}): ReactElement {
  const payloadErrorId = useId();
  const payloadLimitId = useId();
  const payloadDirtyId = useId();
  const sampleWarningId = useId();
  const payloadDescriptions = [
    payloadLimitId,
    payloadError ? payloadErrorId : null,
    payloadDirty ? payloadDirtyId : null,
    samplePlaceholder ? sampleWarningId : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="wh-simulator-layout">
      <div className="wh-simulator-main">
        <WebhookSimulatorToolbar
          webhooks={webhooks}
          events={events}
          webhookID={webhookID}
          eventType={eventType}
          payloadEmpty={payload.trim().length === 0}
          payloadBytes={simulatorPayloadBytes(payload)}
          sending={sending}
          checkingReceipt={checkingReceipt}
          unresolvedFire={reconciliation !== null}
          recoveryUnavailableReason={recoveryUnavailableReason}
          catalogReady={catalogReady}
          moreTargetsAvailable={moreTargetsAvailable}
          loadingMoreTargets={loadingMoreTargets}
          targetLoadError={targetLoadError}
          selectedWebhook={selectedWebhook}
          verifyOpen={verifyOpen}
          onWebhookChange={onWebhookChange}
          onEventChange={onEventChange}
          onFire={onFire}
          onCancel={onCancelFire}
          onVerify={onVerify}
          onLoadMoreTargets={onLoadMoreTargets}
        />
        {recoveryUnavailableReason ? (
          <Notice
            tone="warning"
            announcement="assertive"
            action={
              <button
                type="button"
                className="btn btn-sm"
                onClick={onRetryRecovery}
                disabled={sending}
              >
                Retry encrypted recovery check
              </button>
            }
          >
            <strong>Fire recovery is not ready.</strong>{" "}
            {recoveryUnavailableReason}
          </Notice>
        ) : null}
        <fieldset className="api-playground-form" style={{ padding: 0 }}>
          <legend
            className="mcp-subhead"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            Payload (JSON)
            <InlineHelp text="The event data Moosewave places inside the signed delivery envelope. It must be a JSON object. Switching event type replaces it with a sample template." />
          </legend>
          <textarea
            ref={payloadEditorRef}
            aria-label="Payload JSON"
            aria-invalid={payloadError ? "true" : undefined}
            aria-describedby={payloadDescriptions}
            className="api-playground-body"
            rows={14}
            value={payload}
            onChange={(event) => onPayloadChange(event.target.value)}
            disabled={sending}
          />
          <p
            id={payloadLimitId}
            className="muted small wh-simulator-payload-meta"
          >
            {simulatorPayloadBytes(payload).toLocaleString()} /{" "}
            {MAX_SIMULATOR_PAYLOAD_BYTES.toLocaleString()} UTF-8 bytes
          </p>
          {payloadError ? (
            <p id={payloadErrorId} className="field-error" role="alert">
              Payload can&apos;t be fired: {payloadError}
            </p>
          ) : null}
          {payloadDirty ? (
            <p
              id={payloadDirtyId}
              className="muted small wh-simulator-payload-meta"
            >
              Edited payload — choosing another sample, saved payload, or recent
              fire will ask before replacing these changes.
            </p>
          ) : null}
          {samplePlaceholder ? (
            <p
              id={sampleWarningId}
              className="small"
              style={{ margin: "6px 0 0", color: "var(--pw-warning)" }}
            >
              No representative sample is registered for{" "}
              <code>{eventType}</code> yet — the pre-filled body is a
              placeholder, not what your handler receives in production. Replace
              it with a payload matching your event contract before firing.
            </p>
          ) : null}
        </fieldset>
        {reconciliation ? (
          <FireReconciliationNotice
            reconciliation={reconciliation}
            acknowledged={reconciliationAcknowledged}
            busy={sending}
            onCheck={onCheckReceipt}
            onRecover={onRecoverFire}
            onSettle={onSettleFire}
            onAcknowledgedChange={onReconciliationAcknowledgedChange}
            onRelease={onReleaseAmbiguousFire}
          />
        ) : null}
        {fireError ? (
          <Notice
            tone="danger"
            announcement="assertive"
            action={
              reconciliation ? undefined : (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={fireRequiresRefresh ? onRefreshCatalog : onFire}
                  aria-disabled={sending ? "true" : "false"}
                >
                  {sending
                    ? "Working…"
                    : fireRequiresRefresh
                      ? "Refresh target"
                      : "Start a new logical fire"}
                </button>
              )
            }
          >
            Test delivery failed: {fireError}
          </Notice>
        ) : null}
        {response && responseContext ? (
          <div
            ref={responseRegionRef}
            className="wh-simulator-response-region"
            tabIndex={-1}
            aria-live="polite"
          >
            <SectionHeader
              title="Response"
              description={
                response.filtered
                  ? `${responseContext.eventType} was evaluated for ${responseContext.webhookURL}, but the destination filter prevented a receiver request.`
                  : response.ambiguous
                    ? `${responseContext.eventType} crossed the outbound transport boundary for ${responseContext.webhookURL}, but no receiver status was observed. This is not proof that the receiver did nothing.`
                    : `Response to ${responseContext.eventType} sent to ${responseContext.webhookURL}. The inspector and safe cURL scaffold refer to this immutable request snapshot.`
              }
              helpText="Status code and timing are captured from your endpoint. Credential-bearing request details and echoed secrets are redacted before headers, URLs, bodies, errors, or cURL content are shown. The retry schedule below applies on failure when this is fired through the real outbox pipeline."
            />
            <ResponseInspector response={response} />
          </div>
        ) : null}
      </div>
      <aside
        className="wh-simulator-sidebar"
        aria-label="Simulator payload library and session history"
      >
        <SavedPayloadsPanel
          currentPayload={payload}
          currentEventType={eventType}
          onApply={onApplySaved}
          disabled={sending}
        />
        <RecentFiresPanel
          fires={recentFires}
          onApply={onApplyRecent}
          onClear={onRequestClearHistory}
          disabled={sending}
        />
      </aside>
    </div>
  );
}

export function SimulatorDialogs({
  verifyOpen,
  signingAlgorithm,
  productionOpen,
  productionDescription,
  sending,
  fireError,
  pendingReplacement,
  clearHistoryOpen,
  onCloseVerify,
  onConfirmProduction,
  onCloseProduction,
  onConfirmReplacement,
  onCloseReplacement,
  onConfirmClearHistory,
  onCloseClearHistory,
}: {
  verifyOpen: boolean;
  signingAlgorithm: OutboundWebhook["signing_algorithm"];
  productionOpen: boolean;
  productionDescription: string;
  sending: boolean;
  fireError: string | null;
  pendingReplacement: PayloadReplacement | null;
  clearHistoryOpen: boolean;
  onCloseVerify: () => void;
  onConfirmProduction: () => Promise<void>;
  onCloseProduction: () => void;
  onConfirmReplacement: () => void;
  onCloseReplacement: () => void;
  onConfirmClearHistory: () => void;
  onCloseClearHistory: () => void;
}): ReactElement {
  return (
    <>
      <VerificationSnippetDialog
        open={verifyOpen}
        onClose={onCloseVerify}
        signingAlgorithm={signingAlgorithm}
      />
      <ConfirmModal
        open={productionOpen}
        title="Send a real signed webhook request?"
        description={productionDescription}
        danger
        confirmLabel="Send this one logical fire"
        cancelLabel="Cancel"
        busy={sending}
        onConfirm={onConfirmProduction}
        onClose={onCloseProduction}
      >
        {fireError ? (
          <p className="field-error" role="alert">
            {fireError}
          </p>
        ) : null}
      </ConfirmModal>
      <ConfirmModal
        open={pendingReplacement !== null}
        title="Replace the edited payload?"
        description={
          pendingReplacement
            ? `${pendingReplacement.source} will replace the JSON currently in the editor. The edited payload has not been saved to the payload library.`
            : ""
        }
        confirmLabel="Replace payload"
        cancelLabel="Keep editing"
        onConfirm={onConfirmReplacement}
        onClose={onCloseReplacement}
      />
      <ConfirmModal
        open={clearHistoryOpen}
        title="Clear recent simulator fires?"
        description="This removes the session-only fire history from the sidebar. It does not delete delivery logs on the server."
        confirmLabel="Clear session history"
        cancelLabel="Keep history"
        onConfirm={onConfirmClearHistory}
        onClose={onCloseClearHistory}
      />
    </>
  );
}
