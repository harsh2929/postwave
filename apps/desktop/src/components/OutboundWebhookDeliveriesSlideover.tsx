/**
 * Canonical outbound-webhook delivery history. Every state shown here comes
 * directly from `/api/v1/outbound-webhooks`; the UI never guesses whether a
 * delivery is still retrying or exhausted.
 */

import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  listOutboundWebhookDeliveries,
  replayOutboundWebhookDelivery,
  type OutboundWebhook,
  type OutboundWebhookDelivery,
  type OutboundWebhookDeliveryStatus,
} from "../lib/api-client";
import { newUUIDv7 } from "../lib/http-fetch";
import { useCanAdmin } from "../lib/store";
import {
  sanitizeInspectableText,
  sanitizeInspectableUrl,
} from "./webhook-simulator/ResponseInspector";
import { ConfirmModal } from "./ConfirmModal";
import { Notice } from "./Notice";
import { SlideoverShell } from "./SlideoverShell";
import { toast } from "./Toast";
import { VerificationSnippetDialog } from "./webhooks/VerificationSnippetDialog";
import { WebhookHealthCard } from "./webhooks/WebhookHealthCard";

interface Props {
  subscription: OutboundWebhook;
  onClose: () => void;
  onRetried: () => void;
}

function OutboundDetailShell({
  busy = false,
  children,
  onClose,
  subtitle,
  title,
}: {
  busy?: boolean;
  children: ReactNode;
  onClose: () => void;
  subtitle?: ReactNode;
  title: ReactNode;
}): ReactElement {
  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="lg"
      eyebrow="Outbound webhook"
      title={title}
      subtitle={subtitle}
      closeOnBackdrop={!busy}
      busy={busy}
      className="wh-outbound-delivery-slideover"
    >
      {children}
    </SlideoverShell>
  );
}

const DELIVERY_LIMIT = 50;

function exactTime(value: string | undefined): ReactElement | string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return (
    <time dateTime={parsed.toISOString()} className="tabular">
      {parsed.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "long",
      })}
    </time>
  );
}

const STATUS_COPY: Record<
  OutboundWebhookDeliveryStatus,
  { label: string; badge: string }
> = {
  pending: { label: "Pending", badge: "badge warning" },
  delivered: { label: "Delivered", badge: "badge success" },
  exhausted: { label: "Retries exhausted", badge: "badge danger" },
  skipped: { label: "Cancelled by deletion", badge: "badge" },
};

function failureRollup(deliveries: OutboundWebhookDelivery[]): string | null {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const failures = deliveries.filter((delivery) => {
    const created = Date.parse(delivery.created_at);
    return (
      Number.isFinite(created) &&
      created >= cutoff &&
      delivery.status === "exhausted"
    );
  }).length;
  return failures > 0
    ? `${failures} terminal failure${failures === 1 ? "" : "s"} in the loaded trailing 24-hour window.`
    : null;
}

function replayUnavailableReason(subscription: OutboundWebhook): string | null {
  if (!subscription.active) {
    return "Activate this destination before replaying deliveries.";
  }
  if (
    subscription.url_status === "legacy_pending" ||
    subscription.url_status === "invalid"
  ) {
    return "Replace the complete destination URL before replaying.";
  }
  if (
    subscription.auth_config_status === "legacy_pending" ||
    subscription.auth_config_status === "invalid"
  ) {
    return "Repair or clear receiver authentication before replaying.";
  }
  if (subscription.delivery_policy_status === "invalid") {
    return "Repair the event filter or payload transform before replaying.";
  }
  return null;
}

function safeDeliveryOutput(delivery: OutboundWebhookDelivery): {
  text: string;
  redacted: number;
} {
  const raw =
    delivery.last_error || delivery.last_response_body_truncated || "—";
  const sanitized = sanitizeInspectableText(raw);
  return { text: sanitized.text, redacted: sanitized.redactedCount };
}

function receiverAuthDetails(subscription: OutboundWebhook): string[] {
  const auth = subscription.auth_config;
  if (!auth || !auth.secret_redacted) return ["No receiver authentication"];
  const details: string[] = [];
  if (auth.bearer_configured) details.push("Bearer token configured");
  if ((auth.header_names?.length ?? 0) > 0) {
    details.push(`Custom headers: ${auth.header_names!.join(", ")}`);
  }
  if (auth.mtls_configured) details.push("mTLS certificate configured");
  return details.length > 0 ? details : ["Receiver authentication configured"];
}

interface DeliveryHistoryState {
  rows: OutboundWebhookDelivery[] | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  staleRemoved: boolean;
  nextCursor: string;
  load: (cursor?: string) => Promise<void>;
}

interface DeliveryPageValidation {
  pageIds: Set<string>;
  issue: string | null;
}

function ownsDeliveryLoad({
  active,
  aborted,
  sequence,
  currentSequence,
  subscriptionId,
  currentSubscriptionId,
}: {
  active: boolean;
  aborted: boolean;
  sequence: number;
  currentSequence: number;
  subscriptionId: string;
  currentSubscriptionId: string;
}): boolean {
  return (
    active &&
    !aborted &&
    sequence === currentSequence &&
    subscriptionId === currentSubscriptionId
  );
}

function validateDeliveryPage({
  deliveries,
  nextCursor,
  requestedCursor,
  append,
  loadedCursors,
  loadedDeliveryIds,
}: {
  deliveries: OutboundWebhookDelivery[];
  nextCursor: string;
  requestedCursor: string;
  append: boolean;
  loadedCursors: Set<string>;
  loadedDeliveryIds: Set<string>;
}): DeliveryPageValidation {
  const pageIds = new Set<string>();
  if (
    nextCursor &&
    (nextCursor === requestedCursor ||
      (append && loadedCursors.has(nextCursor)))
  ) {
    return {
      pageIds,
      issue:
        "Moosewave repeated a delivery-history cursor. Pagination stopped safely without adding duplicate rows.",
    };
  }
  if (
    deliveries.some((delivery) => {
      if (pageIds.has(delivery.id)) return true;
      pageIds.add(delivery.id);
      return false;
    })
  ) {
    return {
      pageIds,
      issue:
        "Moosewave returned duplicate deliveries in one page. The unverified page was not shown.",
    };
  }
  if (
    append &&
    deliveries.some((delivery) => loadedDeliveryIds.has(delivery.id))
  ) {
    return {
      pageIds,
      issue:
        "Moosewave returned a duplicate delivery on a later page. The duplicate was not added.",
    };
  }
  return { pageIds, issue: null };
}

function useOutboundDeliveryHistory(
  subscriptionId: string,
): DeliveryHistoryState {
  const [rows, setRows] = useState<OutboundWebhookDelivery[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleRemoved, setStaleRemoved] = useState(false);
  const [nextCursor, setNextCursor] = useState("");
  const activeRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadedCursorsRef = useRef<Set<string>>(new Set());
  const loadedDeliveryIdsRef = useRef<Set<string>>(new Set());
  const currentSubscriptionRef = useRef(subscriptionId);
  currentSubscriptionRef.current = subscriptionId;

  const ownsRequest = useCallback(
    (controller: AbortController, sequence: number, ownerId: string) =>
      ownsDeliveryLoad({
        active: activeRef.current,
        aborted: controller.signal.aborted,
        sequence,
        currentSequence: loadSequenceRef.current,
        subscriptionId: ownerId,
        currentSubscriptionId: currentSubscriptionRef.current,
      }),
    [],
  );

  const load = useCallback(
    async (cursor = ""): Promise<void> => {
      const sequence = ++loadSequenceRef.current;
      const ownerId = subscriptionId;
      const append = cursor !== "";
      loadControllerRef.current?.abort();
      const controller = new AbortController();
      loadControllerRef.current = controller;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setStaleRemoved(false);
      }
      setError(null);
      try {
        const result = await listOutboundWebhookDeliveries(
          ownerId,
          DELIVERY_LIMIT,
          {
            signal: controller.signal,
            requireOnline: true,
            ...(cursor ? { cursor } : {}),
          },
        );
        if (!ownsRequest(controller, sequence, ownerId)) return;
        if (result.error) {
          if (!append && result.error.code === "not_found") {
            setStaleRemoved(true);
            setRows(null);
            setNextCursor("");
            loadedCursorsRef.current = new Set();
            loadedDeliveryIdsRef.current = new Set();
          } else if (result.error.code !== "aborted") {
            setError(sanitizeInspectableText(result.error.message).text);
          }
          return;
        }
        const validation = validateDeliveryPage({
          deliveries: result.data.deliveries,
          nextCursor: result.data.next_cursor,
          requestedCursor: cursor,
          append,
          loadedCursors: loadedCursorsRef.current,
          loadedDeliveryIds: loadedDeliveryIdsRef.current,
        });
        if (validation.issue) {
          setError(validation.issue);
          setNextCursor("");
          return;
        }
        if (append) {
          result.data.deliveries.forEach((delivery) =>
            loadedDeliveryIdsRef.current.add(delivery.id),
          );
          if (cursor) loadedCursorsRef.current.add(cursor);
          if (result.data.next_cursor) {
            loadedCursorsRef.current.add(result.data.next_cursor);
          }
          setRows((current) => [...(current ?? []), ...result.data.deliveries]);
        } else {
          loadedDeliveryIdsRef.current = validation.pageIds;
          loadedCursorsRef.current = new Set(
            result.data.next_cursor ? [result.data.next_cursor] : [],
          );
          setRows(result.data.deliveries);
        }
        setNextCursor(result.data.next_cursor);
      } catch (caught) {
        if (ownsRequest(controller, sequence, ownerId)) {
          setError(
            sanitizeInspectableText(
              caught instanceof Error
                ? caught.message
                : "The delivery history request failed.",
            ).text,
          );
        }
      } finally {
        if (ownsRequest(controller, sequence, ownerId)) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [ownsRequest, subscriptionId],
  );

  useEffect(() => {
    activeRef.current = true;
    setRows(null);
    setNextCursor("");
    void load();
    return () => {
      activeRef.current = false;
      loadSequenceRef.current += 1;
      loadControllerRef.current?.abort();
    };
  }, [load, subscriptionId]);

  return {
    rows,
    loading,
    loadingMore,
    error,
    staleRemoved,
    nextCursor,
    load,
  };
}

interface DeliveryReplayState {
  replayTarget: OutboundWebhookDelivery | null;
  replaying: boolean;
  replayBlocked: string | null;
  healthRevision: number;
  beginReplay: (delivery: OutboundWebhookDelivery) => void;
  cancelReplay: () => void;
  replay: () => Promise<void>;
}

function useOutboundDeliveryReplay({
  subscription,
  reload,
  onRetried,
}: {
  subscription: OutboundWebhook;
  reload: () => Promise<void>;
  onRetried: () => void;
}): DeliveryReplayState {
  const [replayTarget, setReplayTarget] =
    useState<OutboundWebhookDelivery | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [healthRevision, setHealthRevision] = useState(0);
  const activeRef = useRef(true);
  const currentSubscriptionRef = useRef(subscription.id);
  const replayFlightRef = useRef<Promise<unknown> | null>(null);
  const replayIdempotencyKeyRef = useRef<string | null>(null);
  const replayBlocked = replayUnavailableReason(subscription);
  currentSubscriptionRef.current = subscription.id;

  useEffect(() => {
    activeRef.current = true;
    setReplayTarget(null);
    setReplaying(false);
    setHealthRevision(0);
    replayFlightRef.current = null;
    replayIdempotencyKeyRef.current = null;
    return () => {
      activeRef.current = false;
    };
  }, [subscription.id]);

  const beginReplay = useCallback((delivery: OutboundWebhookDelivery) => {
    replayIdempotencyKeyRef.current = newUUIDv7();
    setReplayTarget(delivery);
  }, []);

  const cancelReplay = useCallback(() => {
    if (replayFlightRef.current) return;
    replayIdempotencyKeyRef.current = null;
    setReplayTarget(null);
  }, []);

  const replay = useCallback(async (): Promise<void> => {
    const target = replayTarget;
    const ownerId = subscription.id;
    if (!target || replayFlightRef.current || replayBlocked) return;
    const idempotencyKey =
      replayIdempotencyKeyRef.current ??
      (replayIdempotencyKeyRef.current = newUUIDv7());
    const request = replayOutboundWebhookDelivery(target.id, {
      idempotencyKey,
    });
    replayFlightRef.current = request;
    setReplaying(true);
    const ownsRequest = (): boolean =>
      activeRef.current &&
      replayFlightRef.current === request &&
      currentSubscriptionRef.current === ownerId;
    try {
      const result = await request;
      if (!ownsRequest()) return;
      if (result.error) {
        toast.error(
          `Replay failed: ${sanitizeInspectableText(result.error.message).text}`,
        );
        return;
      }
      toast.success(`Delivery ${result.data.delivery_id} queued`);
      setReplayTarget(null);
      replayIdempotencyKeyRef.current = null;
      await reload();
      if (ownsRequest()) {
        setHealthRevision((revision) => revision + 1);
        onRetried();
      }
    } catch (caught) {
      if (ownsRequest()) {
        toast.error(
          `Replay failed: ${
            sanitizeInspectableText(
              caught instanceof Error
                ? caught.message
                : "The replay request failed.",
            ).text
          }`,
        );
      }
    } finally {
      if (replayFlightRef.current === request) replayFlightRef.current = null;
      if (activeRef.current && currentSubscriptionRef.current === ownerId) {
        setReplaying(false);
      }
    }
  }, [onRetried, reload, replayBlocked, replayTarget, subscription.id]);

  return {
    replayTarget,
    replaying,
    replayBlocked,
    healthRevision,
    beginReplay,
    cancelReplay,
    replay,
  };
}

function OutboundDestinationNotices({
  subscription,
  redactedURL,
  staleRemoved,
  rollup,
}: {
  subscription: OutboundWebhook;
  redactedURL: boolean;
  staleRemoved: boolean;
  rollup: string | null;
}): ReactElement {
  return (
    <>
      {redactedURL ? (
        <p className="muted small">
          Credential-bearing URL details are redacted in this view.
        </p>
      ) : null}
      {staleRemoved ? (
        <Notice tone="warning">
          This destination was permanently removed after this view opened.
          Per-endpoint history is no longer available here; retained
          cancellation evidence remains in tenant-wide delivery diagnostics.
          Close this panel and refresh the destination list.
        </Notice>
      ) : null}
      {subscription.url_status === "legacy_pending" ? (
        <Notice tone="warning">
          This legacy destination is awaiting encrypted URL migration. Testing,
          activation, and replay stay blocked until it is ready.
        </Notice>
      ) : null}
      {subscription.url_status === "invalid" ? (
        <Notice tone="danger">
          The stored destination is unavailable. Use Edit and enter a complete
          replacement URL before testing, activation, or replay.
        </Notice>
      ) : null}
      {subscription.delivery_policy_status === "invalid" ? (
        <Notice tone="danger">
          The stored event filter or payload transform is invalid. Repair the
          delivery policy in Edit before testing, activation, or replay.
        </Notice>
      ) : null}
      {rollup ? <div className="notice">{rollup}</div> : null}
    </>
  );
}

function OutboundSigningConfiguration({
  subscription,
  replaying,
  verifyOpen,
  onOpenVerification,
  onCloseVerification,
}: {
  subscription: OutboundWebhook;
  replaying: boolean;
  verifyOpen: boolean;
  onOpenVerification: () => void;
  onCloseVerification: () => void;
}): ReactElement {
  return (
    <section style={{ marginTop: 12 }} aria-label="Signing configuration">
      <div className="label">Signing</div>
      <p className="muted small" style={{ marginBlock: 4 }}>
        {subscription.signing_algorithm}
        {subscription.secondary_expires_at
          ? " · dual-signing during key rotation until "
          : ""}
        {subscription.secondary_expires_at
          ? exactTime(subscription.secondary_expires_at)
          : null}
      </p>
      {subscription.signing_public_key ? (
        <details>
          <summary>Public verification key</summary>
          <pre className="wh-verification-snippet" style={{ marginTop: 8 }}>
            <code>{subscription.signing_public_key}</code>
          </pre>
        </details>
      ) : null}
      <button
        type="button"
        className="btn btn-sm"
        disabled={replaying}
        onClick={onOpenVerification}
        style={{ marginTop: 8 }}
      >
        Show verification snippet
      </button>
      <VerificationSnippetDialog
        open={verifyOpen}
        onClose={onCloseVerification}
        signingAlgorithm={subscription.signing_algorithm}
        secretHint={
          subscription.signing_algorithm === "hmac_sha256"
            ? "the shared secret shown once at create or rotation time"
            : "the public key shown here and returned by the API"
        }
      />
    </section>
  );
}

function OutboundDeliveryPolicySummary({
  subscription,
}: {
  subscription: OutboundWebhook;
}): ReactElement {
  const mappings = Object.entries(subscription.transform_template ?? {});
  return (
    <section
      className="wh-delivery-policy-summary"
      style={{ marginTop: 16 }}
      aria-label="Delivery policy"
    >
      <div className="label">Delivery policy</div>
      <dl className="wh-policy-summary-list">
        <div>
          <dt>Filter</dt>
          <dd className="mono">
            {subscription.filter_expression || "All selected events"}
          </dd>
        </div>
        <div>
          <dt>Payload</dt>
          <dd>
            {mappings.length > 0
              ? `${mappings.length} projected output field${mappings.length === 1 ? "" : "s"}`
              : "Original event payload"}
          </dd>
        </div>
      </dl>
      {mappings.length > 0 ? (
        <details>
          <summary>View output-field mappings</summary>
          <dl className="wh-policy-mappings">
            {mappings.map(([field, pointer]) => (
              <div key={field}>
                <dt className="mono">{field}</dt>
                <dd className="mono">{pointer || "(document root)"}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </section>
  );
}

function OutboundReceiverAuthSummary({
  subscription,
}: {
  subscription: OutboundWebhook;
}): ReactElement {
  return (
    <section
      className="wh-receiver-auth-summary"
      style={{ marginTop: 16 }}
      aria-label="Receiver authentication"
    >
      <div className="label">Receiver authentication</div>
      <ul className="muted small" style={{ marginBlock: 6 }}>
        {receiverAuthDetails(subscription).map((detail) => (
          <li key={detail}>{detail}</li>
        ))}
      </ul>
      {subscription.auth_config_status === "legacy_pending" ? (
        <Notice tone="warning">
          Existing receiver credentials are being migrated to encrypted storage.
          Delivery is held until migration completes.
        </Notice>
      ) : null}
      {subscription.auth_config_status === "invalid" ? (
        <Notice tone="danger">
          Receiver credentials are invalid and delivery is blocked. Replace or
          clear them from Edit before sending more events.
        </Notice>
      ) : null}
      <p className="muted small" style={{ marginBottom: 0 }}>
        Secret values are write-only and never returned to this view.
      </p>
    </section>
  );
}

function DeliveryHistoryRow({
  delivery,
  replaying,
  loadingMore,
  replayBlocked,
  onReplay,
}: {
  delivery: OutboundWebhookDelivery;
  replaying: boolean;
  loadingMore: boolean;
  replayBlocked: string | null;
  onReplay: (delivery: OutboundWebhookDelivery) => void;
}): ReactElement {
  const status = STATUS_COPY[delivery.status];
  const output = safeDeliveryOutput(delivery);
  return (
    <tr
      className="list-row wh-delivery-row"
      style={{
        cursor: "default",
        gridTemplateColumns:
          "minmax(9rem, 1fr) minmax(7rem, auto) minmax(8rem, 1fr) minmax(10rem, 1.2fr) auto",
      }}
    >
      <td data-label="Event">
        <div className="mono">{delivery.event_type}</div>
        <div className="muted small mono">{delivery.id}</div>
      </td>
      <td data-label="State">
        <span className={status.badge}>{status.label}</span>
      </td>
      <td data-label="Attempt">
        <span className="tabular">{delivery.attempt_count}</span>
        <div className="muted small">
          Created {exactTime(delivery.created_at)}
        </div>
      </td>
      <td data-label="Outcome and schedule">
        <div>HTTP {delivery.last_status_code ?? "no response"}</div>
        <div className="muted wh-delivery-excerpt">
          {output.text}
          {output.redacted > 0 ? " · sensitive value redacted" : ""}
        </div>
        {delivery.delivered_at ? (
          <div className="muted small">
            Delivered {exactTime(delivery.delivered_at)}
          </div>
        ) : null}
        {delivery.next_attempt_at ? (
          <div className="muted small">
            Next retry {exactTime(delivery.next_attempt_at)}
          </div>
        ) : null}
      </td>
      <td data-label="Action">
        {delivery.status !== "pending" ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={replaying || loadingMore || Boolean(replayBlocked)}
            title={replayBlocked ?? undefined}
            onClick={() => onReplay(delivery)}
          >
            Replay
          </button>
        ) : (
          <span className="muted small">Queued by server</span>
        )}
      </td>
    </tr>
  );
}

function DeliveryHistoryTable({
  rows,
  safeURL,
  replaying,
  loadingMore,
  replayBlocked,
  onReplay,
}: {
  rows: OutboundWebhookDelivery[];
  safeURL: string;
  replaying: boolean;
  loadingMore: boolean;
  replayBlocked: string | null;
  onReplay: (delivery: OutboundWebhookDelivery) => void;
}): ReactElement {
  return (
    <table
      className="list wh-webhook-list"
      style={{ display: "block", width: "100%", marginTop: 8 }}
    >
      <caption className="sr-only">
        Canonical delivery history for {safeURL}
      </caption>
      <thead
        className="list-header"
        style={{
          gridTemplateColumns:
            "minmax(9rem, 1fr) minmax(7rem, auto) minmax(8rem, 1fr) minmax(10rem, 1.2fr) auto",
        }}
      >
        <tr style={{ display: "contents" }}>
          <th scope="col">Event</th>
          <th scope="col">State</th>
          <th scope="col">Attempt</th>
          <th scope="col">Outcome and schedule</th>
          <th scope="col">Action</th>
        </tr>
      </thead>
      <tbody style={{ display: "contents" }}>
        {rows.map((delivery) => (
          <DeliveryHistoryRow
            key={delivery.id}
            delivery={delivery}
            replaying={replaying}
            loadingMore={loadingMore}
            replayBlocked={replayBlocked}
            onReplay={onReplay}
          />
        ))}
      </tbody>
    </table>
  );
}

function DeliveryHistorySection({
  history,
  safeURL,
  replaying,
  replayBlocked,
  onReplay,
}: {
  history: DeliveryHistoryState;
  safeURL: string;
  replaying: boolean;
  replayBlocked: string | null;
  onReplay: (delivery: OutboundWebhookDelivery) => void;
}): ReactElement {
  const titleId = useId();
  const { rows, loading, loadingMore, error, nextCursor, load } = history;
  let content: ReactElement;
  if (loading) {
    content = (
      <div style={{ padding: 12 }} role="status" aria-live="polite">
        Loading delivery history…
      </div>
    );
  } else if (error && !rows) {
    content = (
      <div className="field-error" role="alert">
        <p>Couldn&apos;t load deliveries: {error}</p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void load()}
        >
          Retry loading deliveries
        </button>
      </div>
    );
  } else if (!rows || rows.length === 0) {
    content = (
      <div className="muted small" style={{ padding: 12 }}>
        No deliveries have been recorded for this destination.
      </div>
    );
  } else {
    content = (
      <>
        {error ? (
          <div className="field-error" role="alert">
            Couldn&apos;t refresh deliveries: {error} Previously verified
            deliveries remain visible and may be stale.
          </div>
        ) : null}
        <p className="muted small" aria-live="polite">
          {rows.length.toLocaleString()}{" "}
          {rows.length === 1 ? "delivery" : "deliveries"} loaded newest first.
        </p>
        <DeliveryHistoryTable
          rows={rows}
          safeURL={safeURL}
          replaying={replaying}
          loadingMore={loadingMore}
          replayBlocked={replayBlocked}
          onReplay={onReplay}
        />
        {nextCursor ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={loadingMore || replaying}
            onClick={() => void load(nextCursor)}
            style={{ marginTop: 12 }}
          >
            {loadingMore ? "Loading older…" : "Load older deliveries"}
          </button>
        ) : error ? (
          <p className="muted small">
            Previously loaded deliveries remain visible. History completeness is
            unknown until a fresh request succeeds.
          </p>
        ) : (
          <p className="muted small">All available deliveries are loaded.</p>
        )}
      </>
    );
  }
  return (
    <section
      style={{ marginTop: 16 }}
      aria-labelledby={titleId}
      aria-busy={loading || loadingMore ? "true" : undefined}
    >
      <h3 id={titleId} className="label">
        Recent deliveries
      </h3>
      {content}
    </section>
  );
}

function OutboundWebhookAdminRequired({
  onClose,
}: Pick<Props, "onClose">): ReactElement {
  return (
    <OutboundDetailShell
      onClose={onClose}
      title="Admin access required"
      subtitle="Outbound delivery evidence is restricted."
    >
      <Notice tone="warning" title="Admin access required">
        Destination configuration, receiver authentication metadata, health
        evidence, retained responses, and replay controls are restricted to
        workspace admins. No delivery history was requested.
      </Notice>
    </OutboundDetailShell>
  );
}

export function OutboundWebhookDeliveriesSlideover(props: Props): ReactElement {
  const canAdmin = useCanAdmin();
  if (!canAdmin) {
    return <OutboundWebhookAdminRequired onClose={props.onClose} />;
  }
  return <OutboundWebhookDeliveriesAdmin {...props} />;
}

function OutboundWebhookDeliveriesAdmin({
  subscription,
  onClose,
  onRetried,
}: Props): ReactElement {
  const [verifyOpen, setVerifyOpen] = useState(false);
  const history = useOutboundDeliveryHistory(subscription.id);
  const replayState = useOutboundDeliveryReplay({
    subscription,
    reload: history.load,
    onRetried,
  });
  const { rows, staleRemoved } = history;
  const {
    replayTarget,
    replaying,
    replayBlocked,
    healthRevision,
    beginReplay,
    cancelReplay,
    replay,
  } = replayState;
  useEffect(() => {
    setVerifyOpen(false);
  }, [subscription.id]);

  const rollup = useMemo(() => (rows ? failureRollup(rows) : null), [rows]);
  const safeURL = sanitizeInspectableUrl(subscription.url);

  return (
    <>
      <OutboundDetailShell
        onClose={() => {
          if (!replaying) onClose();
        }}
        title="Recent deliveries"
        subtitle={<span className="mono">{safeURL.url}</span>}
        busy={replaying}
      >
        <OutboundDestinationNotices
          subscription={subscription}
          redactedURL={safeURL.redactedCount > 0}
          staleRemoved={staleRemoved}
          rollup={rollup}
        />

        {!staleRemoved ? (
          <div style={{ marginTop: 12 }}>
            <WebhookHealthCard
              key={`${subscription.id}:${healthRevision}`}
              webhookId={subscription.id}
            />
          </div>
        ) : null}

        <OutboundSigningConfiguration
          subscription={subscription}
          replaying={replaying}
          verifyOpen={verifyOpen}
          onOpenVerification={() => setVerifyOpen(true)}
          onCloseVerification={() => setVerifyOpen(false)}
        />

        <OutboundDeliveryPolicySummary subscription={subscription} />

        <OutboundReceiverAuthSummary subscription={subscription} />

        {!staleRemoved ? (
          <DeliveryHistorySection
            history={history}
            safeURL={safeURL.url}
            replaying={replaying}
            replayBlocked={replayBlocked}
            onReplay={beginReplay}
          />
        ) : null}
      </OutboundDetailShell>

      <ConfirmModal
        open={replayTarget !== null && !replayBlocked}
        title="Replay this live delivery?"
        description={
          replayTarget
            ? `This queues ${replayTarget.event_type} to ${safeURL.url} with a new delivery ID and the same event identity metadata. The signature authenticates the body only: receivers may safely deduplicate only an identity retained inside that signed body. Otherwise side effects may repeat.`
            : ""
        }
        confirmLabel={replaying ? "Replaying…" : "Replay delivery"}
        cancelLabel="Cancel"
        danger
        busy={replaying}
        onConfirm={replay}
        onClose={cancelReplay}
      >
        {replayTarget ? (
          <p className="muted small mono">
            Original delivery: {replayTarget.id}
          </p>
        ) : null}
      </ConfirmModal>
    </>
  );
}
