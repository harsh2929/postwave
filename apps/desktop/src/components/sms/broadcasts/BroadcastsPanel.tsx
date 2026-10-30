/**
 * BroadcastsPanel — the "Broadcasts" mode of the SMS Inbox page.
 *
 * One-to-many SMS sends over `smsBroadcastsApi` (apps/api/internal/
 * sms/{broadcasts,broadcast_handlers}.go):
 *
 *   - List: name, status badge, audience summary (lists | segment |
 *     tag — exactly one), sent/failed/held counters,
 *     segments_per_message, scheduled time.
 *   - Send now / Schedule both POST /send: the server enqueues
 *     immediately when scheduled_at is empty or past-due, and flips
 *     the row to `scheduled` (worker due-sweep delivers later) when
 *     it's in the future. The ConfirmModal quotes the audience, the
 *     recipient-cap behaviour, and the quiet-hours hold semantics
 *     (held messages deliver when the window ends — they are not
 *     failures).
 *   - Cancel (scheduled|sending): still-queued recipients, including
 *     quiet-hours holds, are marked cancelled.
 *   - Delete: draft-only in the UI.
 *   - Progress drilldown: GET /{id}/progress rendered verbatim
 *     (sent / failed / held / total), polled every 5s via usePoller
 *     while the expanded broadcast is `sending`. The progress call
 *     also lazily finalises sending → sent server-side.
 *
 * Honest states: typed errors surface via describeBroadcastError
 * (audience_too_large with the cap, no_consented_recipients, …); all
 * mutations are admin-scoped per the manifest, so non-admins see
 * disabled buttons with the reason; the empty state explains that
 * only opted-in, non-suppressed numbers receive sends.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type SmsBroadcast,
  type SmsBroadcastProgress,
  smsBroadcastsApi,
} from "../../../lib/api-client";
import { fmtDateTime } from "../../../lib/format-date";
import { type SmsList, listSmsLists } from "../../../lib/sms-a2p-api";
import { useCanAdmin } from "../../../lib/store";
import { usePoller } from "../../../hooks/usePoller";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../../ConfirmModal";
import { Notice } from "../../Notice";
import { type Segment, segmentsClient } from "../../segments/segmentsClient";
import { toast } from "../../Toast";
import { useSMSDocumentVisible } from "../sms-page-activity";
import { BroadcastComposerModal } from "./BroadcastComposerModal";
import {
  type AudienceNameLookup,
  audienceSummary,
  broadcastStatusBadge,
  canCancelBroadcast,
  canDeleteBroadcast,
  canEditBroadcast,
  canSendBroadcast,
  describeBroadcastError,
  progressPct,
} from "./broadcast-helpers";
import "../../../styles-action-availability.css";

const LIST_REFRESH_MS = 30_000;
const PROGRESS_REFRESH_MS = 5_000;

const DISPATCH_RELEASE_HOLD_REASON =
  "SMS broadcast dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. Drafts remain editable, but no provider send or schedule request can be started.";

function dispatchHoldCopy(reason: string | null | undefined): string {
  if (reason === "sms_broadcast_dispatch_release_held") {
    return DISPATCH_RELEASE_HOLD_REASON;
  }
  if (reason === "sms_financial_reservation_unavailable") {
    return "SMS broadcast dispatch is unavailable because durable financial reservation is unavailable. Drafts remain editable, but no provider send or schedule request can be started.";
  }
  return "SMS broadcast dispatch is unavailable. Drafts remain editable, but no provider send or schedule request can be started.";
}

function useBroadcastOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const onOnline = (): void => setOnline(true);
    const onOffline = (): void => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  return online;
}

interface BroadcastListSurfaceProps {
  canAdmin: boolean;
  broadcasts: SmsBroadcast[] | null;
  error: string | null;
  nameLookup: AudienceNameLookup;
  expandedId: string | null;
  progress: SmsBroadcastProgress | null;
  progressError: string | null;
  lookupError: string | null;
  online: boolean;
  refreshing: boolean;
  lastRefreshedAt: number | null;
  snapshotAt: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  actionBusy: boolean;
  dispatchAvailable: boolean | null;
  dispatchUnavailableReason?: string;
  onRefresh: () => void;
  onLoadMore: () => void;
  onCreate: () => void;
  onEdit: (broadcast: SmsBroadcast) => void;
  onSend: (broadcast: SmsBroadcast) => void;
  onCancel: (broadcast: SmsBroadcast) => void;
  onDelete: (broadcast: SmsBroadcast) => void;
  onToggleProgress: (id: string) => void;
}

function BroadcastListSurface({
  canAdmin,
  broadcasts,
  error,
  nameLookup,
  expandedId,
  progress,
  progressError,
  lookupError,
  online,
  refreshing,
  lastRefreshedAt,
  snapshotAt,
  hasMore,
  loadingMore,
  actionBusy,
  dispatchAvailable,
  dispatchUnavailableReason,
  onRefresh,
  onLoadMore,
  onCreate,
  onEdit,
  onSend,
  onCancel,
  onDelete,
  onToggleProgress,
}: BroadcastListSurfaceProps): ReactElement {
  const rows = broadcasts ?? [];
  if (!canAdmin) {
    return (
      <section
        className="sms-broadcasts"
        aria-labelledby="sms-broadcasts-title"
      >
        <div className="sms-broadcasts-toolbar">
          <div>
            <span className="sms-kicker">Delivery operations</span>
            <h2 id="sms-broadcasts-title">Broadcasts</h2>
          </div>
        </div>
        <Notice tone="warning" announcement="polite">
          SMS broadcasts expose recipient audiences and delivery operations.
          Your current role cannot read or change them; no protected broadcast
          requests were started.
        </Notice>
      </section>
    );
  }
  return (
    <section className="sms-broadcasts" aria-labelledby="sms-broadcasts-title">
      <div className="sms-broadcasts-toolbar">
        <div>
          <span className="sms-kicker">Delivery operations</span>
          <h2 id="sms-broadcasts-title">Broadcasts</h2>
          <p className="muted small">
            {dispatchAvailable === false
              ? "Drafts remain editable while dispatch is release-held. No provider send or schedule request can start."
              : "Drafts are editable here. Any later dispatch must recheck US/Canada consent, suppressions, quiet hours, and server readiness."}
          </p>
        </div>
        <div className="sms-broadcasts-toolbar-actions">
          <span
            className="muted small tabular"
            role="status"
            aria-live="polite"
          >
            {!online
              ? broadcasts
                ? "Offline · retained loaded pages"
                : "Offline · not loaded"
              : refreshing
                ? "Refreshing…"
                : lastRefreshedAt
                  ? `Loaded ${new Date(lastRefreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : "Waiting for a decoded list response"}
          </span>
          <button
            type="button"
            className="btn"
            onClick={onRefresh}
            disabled={!online || refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn btn-primary pw-discoverable-unavailable"
            aria-disabled={!canAdmin || !online}
            aria-describedby={
              !canAdmin ? "sms-broadcast-admin-reason" : undefined
            }
            onClick={() => {
              if (canAdmin && online) onCreate();
            }}
          >
            New broadcast
          </button>
        </div>
      </div>

      {!online ? (
        <Notice tone="warning" announcement="polite">
          Broadcast polling and mutations are paused offline.
          {broadcasts ? " The last loaded pages remain visible." : ""}
        </Notice>
      ) : null}
      {dispatchAvailable === false ? (
        <Notice tone="warning" announcement="polite">
          <span id="sms-broadcast-dispatch-reason">
            {dispatchHoldCopy(dispatchUnavailableReason)}
          </span>
        </Notice>
      ) : null}
      {error ? (
        <Notice
          tone={broadcasts ? "warning" : "danger"}
          announcement={broadcasts ? "polite" : "assertive"}
        >
          {broadcasts
            ? `Broadcast refresh failed: ${error}. Showing the last loaded pages.`
            : `Couldn't load broadcasts: ${error}`}
        </Notice>
      ) : null}
      {lookupError ? (
        <Notice tone="warning" announcement="polite">
          {lookupError} Stored audience identifiers are shown when a name could
          not be verified.
        </Notice>
      ) : null}
      {snapshotAt ? (
        <p className="muted small sms-broadcast-snapshot-boundary">
          Loaded pages share a broadcast insertion cutoff of{" "}
          {fmtDateTime(snapshotAt)}. Status and delivery counters can still
          change, and late commits at or before that cutoff can differ after
          refresh.
        </p>
      ) : null}

      {broadcasts === null ? (
        error ? null : (
          <div className="sms-broadcasts-loading" role="status">
            <span className="visually-hidden">Loading broadcasts…</span>
            <div aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <div key={index} className="skel-row" />
              ))}
            </div>
          </div>
        )
      ) : rows.length === 0 ? (
        <div className="sms-broadcasts-empty">
          <span aria-hidden="true">◇</span>
          <h3>No SMS broadcasts yet</h3>
          <p>
            No broadcast rows were returned in this loaded result. You can draft
            a message for an SMS list, segment, or tag; eligibility is rechecked
            only when dispatch is authorized.
          </p>
          {!canAdmin ? (
            <p className="muted small">
              Creating and sending broadcasts requires the admin role.
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="sms-broadcast-grid" aria-label="SMS broadcasts">
          {rows.map((broadcast) => (
            <li key={broadcast.id}>
              <BroadcastListRow
                broadcast={broadcast}
                canAdmin={canAdmin}
                nameLookup={nameLookup}
                expanded={expandedId === broadcast.id}
                progress={progress}
                progressError={progressError}
                actionBusy={actionBusy || !online}
                dispatchAvailable={dispatchAvailable === true}
                onEdit={onEdit}
                onSend={onSend}
                onCancel={onCancel}
                onDelete={onDelete}
                onToggleProgress={onToggleProgress}
              />
            </li>
          ))}
        </ul>
      )}
      {broadcasts !== null && hasMore ? (
        <div className="sms-broadcast-load-more">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={!online || loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "Loading more…" : "Load more broadcasts"}
          </button>
          <span className="muted small">
            More rows exist beyond this loaded insertion window.
          </span>
        </div>
      ) : null}
    </section>
  );
}

interface BroadcastListRowProps {
  broadcast: SmsBroadcast;
  canAdmin: boolean;
  nameLookup: AudienceNameLookup;
  expanded: boolean;
  progress: SmsBroadcastProgress | null;
  progressError: string | null;
  actionBusy: boolean;
  dispatchAvailable: boolean;
  onEdit: (broadcast: SmsBroadcast) => void;
  onSend: (broadcast: SmsBroadcast) => void;
  onCancel: (broadcast: SmsBroadcast) => void;
  onDelete: (broadcast: SmsBroadcast) => void;
  onToggleProgress: (id: string) => void;
}

function BroadcastListRow({
  broadcast,
  canAdmin,
  nameLookup,
  expanded,
  progress,
  progressError,
  actionBusy,
  dispatchAvailable,
  onEdit,
  onSend,
  onCancel,
  onDelete,
  onToggleProgress,
}: BroadcastListRowProps): ReactElement {
  const badge = broadcastStatusBadge(broadcast.status);
  const sendLabel =
    broadcast.scheduled_at &&
    new Date(broadcast.scheduled_at).getTime() > Date.now()
      ? "Schedule"
      : "Send now";
  const permissionProps = {
    className: "pw-discoverable-unavailable",
    "aria-disabled": !canAdmin || actionBusy,
    "aria-describedby": !canAdmin ? "sms-broadcast-admin-reason" : undefined,
  } as const;
  const rowTitleId = `sms-broadcast-title-${broadcast.id}`;
  return (
    <article className="sms-broadcast-card" aria-labelledby={rowTitleId}>
      <header className="sms-broadcast-card-head">
        <div>
          <span className="sms-kicker">SMS broadcast</span>
          <h3 id={rowTitleId}>{broadcast.name}</h3>
        </div>
        <div>
          <span className={badge.className}>{badge.label}</span>
        </div>
      </header>
      <dl className="sms-broadcast-facts">
        <div className="sms-broadcast-fact sms-broadcast-fact-audience">
          <dt>Audience</dt>
          <dd>{audienceSummary(broadcast, nameLookup)}</dd>
        </div>
        <div className="sms-broadcast-fact">
          <dt>Recorded provider outcomes</dt>
          <dd className="tabular">
            {broadcast.sent_count.toLocaleString()} accepted ·{" "}
            {broadcast.failed_count.toLocaleString()} recorded failed ·{" "}
            {broadcast.held_count.toLocaleString()} held
          </dd>
        </div>
        <div className="sms-broadcast-fact">
          <dt>Segments each</dt>
          <dd className="tabular">{broadcast.segments_per_message}</dd>
        </div>
        <div className="sms-broadcast-fact">
          <dt>Schedule</dt>
          <dd className="tabular">
            {broadcast.scheduled_at
              ? fmtDateTime(broadcast.scheduled_at)
              : "Not scheduled"}
          </dd>
        </div>
      </dl>
      <footer className="sms-broadcast-card-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => onToggleProgress(broadcast.id)}
          aria-expanded={expanded}
          aria-controls={`sms-broadcast-progress-${broadcast.id}`}
          aria-label={`${expanded ? "Hide" : "Show"} delivery progress for ${broadcast.name}`}
        >
          {expanded ? "Hide" : "Progress"}
        </button>
        {canEditBroadcast(broadcast.status) ? (
          <button
            type="button"
            className={`btn btn-sm btn-ghost ${permissionProps.className}`}
            aria-disabled={permissionProps["aria-disabled"]}
            aria-describedby={permissionProps["aria-describedby"]}
            onClick={() => {
              if (canAdmin && !actionBusy) onEdit(broadcast);
            }}
          >
            Edit
          </button>
        ) : null}
        {canSendBroadcast(broadcast.status) ? (
          <button
            type="button"
            className={`btn btn-sm ${permissionProps.className}`}
            disabled={!canAdmin || actionBusy || !dispatchAvailable}
            aria-describedby={
              !dispatchAvailable
                ? "sms-broadcast-dispatch-reason"
                : permissionProps["aria-describedby"]
            }
            onClick={() => {
              if (canAdmin && !actionBusy && dispatchAvailable) {
                onSend(broadcast);
              }
            }}
          >
            {sendLabel}
          </button>
        ) : null}
        {canCancelBroadcast(broadcast.status) ? (
          <button
            type="button"
            className={`btn btn-sm btn-ghost ${permissionProps.className}`}
            aria-disabled={permissionProps["aria-disabled"]}
            aria-describedby={permissionProps["aria-describedby"]}
            onClick={() => {
              if (canAdmin && !actionBusy) onCancel(broadcast);
            }}
          >
            Cancel
          </button>
        ) : null}
        {canDeleteBroadcast(broadcast.status) ? (
          <button
            type="button"
            className={`btn btn-sm btn-ghost ${permissionProps.className}`}
            aria-disabled={permissionProps["aria-disabled"]}
            aria-describedby={permissionProps["aria-describedby"]}
            onClick={() => {
              if (canAdmin && !actionBusy) onDelete(broadcast);
            }}
          >
            Delete
          </button>
        ) : null}
      </footer>
      {expanded ? (
        <div
          id={`sms-broadcast-progress-${broadcast.id}`}
          className="sms-broadcast-progress-region"
        >
          <BroadcastProgressRow
            broadcast={broadcast}
            progress={progress}
            error={progressError}
          />
        </div>
      ) : null}
    </article>
  );
}

interface BroadcastConfirmModalsProps {
  sendTarget: SmsBroadcast | null;
  cancelTarget: SmsBroadcast | null;
  deleteTarget: SmsBroadcast | null;
  actionBusy: boolean;
  nameLookup: AudienceNameLookup;
  onCloseSend: () => void;
  onCloseCancel: () => void;
  onCloseDelete: () => void;
  onConfirmSend: () => void;
  onConfirmCancel: () => void;
  onConfirmDelete: () => void;
}

function BroadcastConfirmModals({
  sendTarget,
  cancelTarget,
  deleteTarget,
  actionBusy,
  nameLookup,
  onCloseSend,
  onCloseCancel,
  onCloseDelete,
  onConfirmSend,
  onConfirmCancel,
  onConfirmDelete,
}: BroadcastConfirmModalsProps): ReactElement {
  const scheduled = Boolean(
    sendTarget?.scheduled_at &&
    new Date(sendTarget.scheduled_at).getTime() > Date.now(),
  );
  return (
    <>
      <ConfirmModal
        open={sendTarget !== null}
        title={
          scheduled
            ? `Schedule "${sendTarget?.name ?? ""}"?`
            : `Send "${sendTarget?.name ?? ""}" now?`
        }
        description="This authorizes a real one-to-many SMS dispatch attempt."
        confirmLabel={scheduled ? "Schedule" : "Send now"}
        busy={actionBusy}
        onClose={onCloseSend}
        onConfirm={onConfirmSend}
      >
        {sendTarget ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0 }}>
              Audience:{" "}
              <strong>{audienceSummary(sendTarget, nameLookup)}</strong>
              {" — "}the server resolves the audience and rechecks each
              recipient at dispatch. Each provider attempt uses{" "}
              <strong>{sendTarget.segments_per_message}</strong> billed segment
              {sendTarget.segments_per_message === 1 ? "" : "s"}. The server
              rejects sends over the per-broadcast recipient cap.
            </p>
            <p style={{ margin: 0 }} className="muted">
              Quiet-hours messages are held, not counted as failures, and may
              resume after the window. A later consent revocation or suppression
              still blocks that recipient.
            </p>
            {scheduled && sendTarget.scheduled_at ? (
              <p style={{ margin: 0 }} className="muted">
                Armed for{" "}
                <strong>{fmtDateTime(sendTarget.scheduled_at)}</strong> — you
                can cancel any time before then.
              </p>
            ) : null}
          </div>
        ) : null}
      </ConfirmModal>
      <ConfirmModal
        open={cancelTarget !== null}
        title={`Cancel "${cancelTarget?.name ?? ""}"?`}
        description={
          cancelTarget?.status === "sending"
            ? "The broadcast is mid-send."
            : "The broadcast is scheduled."
        }
        confirmLabel="Cancel broadcast"
        cancelLabel="Keep it"
        danger
        busy={actionBusy}
        onClose={onCloseCancel}
        onConfirm={onConfirmCancel}
      >
        <p style={{ margin: 0 }}>
          Still-pending recipients — including quiet-hours holds — will be
          marked cancelled. Provider-accepted messages cannot be recalled.
        </p>
      </ConfirmModal>
      <ConfirmModal
        open={deleteTarget !== null}
        title={`Delete draft "${deleteTarget?.name ?? ""}"?`}
        description="Drafts are deleted permanently — there is no undo."
        confirmLabel="Delete draft"
        danger
        busy={actionBusy}
        onClose={onCloseDelete}
        onConfirm={onConfirmDelete}
      />
    </>
  );
}

function useBroadcastList(
  authorized: boolean,
  online: boolean,
  documentVisible: boolean,
) {
  const PAGE_SIZE = 50;
  const [broadcasts, setBroadcasts] = useState<SmsBroadcast[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [dispatchAvailable, setDispatchAvailable] = useState<boolean | null>(
    null,
  );
  const [dispatchUnavailableReason, setDispatchUnavailableReason] = useState<
    string | undefined
  >();
  const requestSequenceRef = useRef(0);
  const firstPageAbortRef = useRef<AbortController | null>(null);
  const nextPageAbortRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const load = useCallback(
    async (
      options: { signal?: AbortSignal; showBusy?: boolean } = {},
    ): Promise<void> => {
      if (!authorized || !online || !documentVisible) return;
      firstPageAbortRef.current?.abort();
      nextPageAbortRef.current?.abort();
      const controller = new AbortController();
      firstPageAbortRef.current = controller;
      const abortFromOwner = (): void => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else
        options.signal?.addEventListener("abort", abortFromOwner, {
          once: true,
        });
      const requestId = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestId;
      setNextCursor(undefined);
      setSnapshotAt(null);
      setLoadingMore(false);
      loadingMoreRef.current = false;
      setDispatchAvailable(null);
      setDispatchUnavailableReason(undefined);
      if (options.showBusy !== false) setRefreshing(true);
      try {
        const res = await smsBroadcastsApi.list({
          limit: PAGE_SIZE,
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          requestId !== requestSequenceRef.current
        ) {
          return;
        }
        if (res.error) {
          setError(describeBroadcastError(res.error));
          return;
        }
        setError(null);
        setBroadcasts(res.data.items);
        setNextCursor(res.data.nextCursor);
        setSnapshotAt(res.data.snapshotAt);
        setDispatchAvailable(res.data.broadcastDispatchAvailable);
        setDispatchUnavailableReason(
          res.data.broadcastDispatchUnavailableReason,
        );
        setLastRefreshedAt(Date.now());
      } catch (loadError) {
        if (
          controller.signal.aborted ||
          requestId !== requestSequenceRef.current
        ) {
          return;
        }
        setError(
          lifecycleOperationError(
            loadError,
            "The broadcast list request failed.",
          ),
        );
      } finally {
        if (
          options.showBusy !== false &&
          !controller.signal.aborted &&
          requestId === requestSequenceRef.current
        ) {
          setRefreshing(false);
        }
        options.signal?.removeEventListener("abort", abortFromOwner);
      }
    },
    [authorized, documentVisible, online],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    if (
      !authorized ||
      !online ||
      !documentVisible ||
      loadingMoreRef.current ||
      !nextCursor ||
      !snapshotAt
    ) {
      return;
    }
    nextPageAbortRef.current?.abort();
    const controller = new AbortController();
    nextPageAbortRef.current = controller;
    const ownerRequest = requestSequenceRef.current;
    const ownerCursor = nextCursor;
    const ownerSnapshot = snapshotAt;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await smsBroadcastsApi.list({
        cursor: ownerCursor,
        limit: PAGE_SIZE,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        ownerRequest !== requestSequenceRef.current
      ) {
        return;
      }
      if (res.error) {
        setError(
          `More broadcasts could not load: ${describeBroadcastError(res.error)}`,
        );
        return;
      }
      if (res.data.snapshotAt !== ownerSnapshot) {
        setNextCursor(undefined);
        setError(
          "The broadcast insertion window changed between pages. Refresh from the first page before continuing.",
        );
        return;
      }
      setError(null);
      setBroadcasts((current) => {
        const seen = new Set((current ?? []).map((row) => row.id));
        return [
          ...(current ?? []),
          ...res.data.items.filter((row) => !seen.has(row.id)),
        ];
      });
      setNextCursor(res.data.nextCursor);
      setDispatchAvailable(res.data.broadcastDispatchAvailable);
      setDispatchUnavailableReason(res.data.broadcastDispatchUnavailableReason);
    } catch (loadError) {
      if (
        !controller.signal.aborted &&
        ownerRequest === requestSequenceRef.current
      ) {
        setError(
          lifecycleOperationError(
            loadError,
            "More broadcast rows could not be loaded.",
          ),
        );
      }
    } finally {
      if (nextPageAbortRef.current === controller) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [authorized, documentVisible, nextCursor, online, snapshotAt]);

  useEffect(() => {
    if (!authorized || !online || !documentVisible) {
      firstPageAbortRef.current?.abort();
      nextPageAbortRef.current?.abort();
      requestSequenceRef.current += 1;
      setRefreshing(false);
      setLoadingMore(false);
      loadingMoreRef.current = false;
      return;
    }
    void load({ showBusy: broadcasts === null });
    // A reconnect must refresh the retained snapshot. `broadcasts` is read
    // only to choose the busy treatment and must not retrigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, documentVisible, load, online]);
  usePoller(
    async ({ signal }) => {
      await load({ signal, showBusy: false });
    },
    authorized && online && documentVisible ? LIST_REFRESH_MS : 0,
    [authorized, documentVisible, load, online],
  );
  useEffect(
    () => () => {
      firstPageAbortRef.current?.abort();
      nextPageAbortRef.current?.abort();
      requestSequenceRef.current += 1;
    },
    [],
  );
  return {
    broadcasts,
    error,
    lastRefreshedAt,
    dispatchAvailable,
    dispatchUnavailableReason,
    nextCursor,
    snapshotAt,
    loadingMore,
    loadMore,
    load,
    refreshing,
    setBroadcasts,
  };
}

export function BroadcastsPanel(props: {
  expandedId?: string | null;
  onExpandedIdChange?: (id: string | null) => void;
}): ReactElement {
  const [localExpandedId, setLocalExpandedId] = useState<string | null>(null);
  const expandedId =
    props.expandedId === undefined ? localExpandedId : props.expandedId;
  const onExpandedIdChange = props.onExpandedIdChange ?? setLocalExpandedId;
  const canAdmin = useCanAdmin();
  const online = useBroadcastOnlineStatus();
  const documentVisible = useSMSDocumentVisible();
  const {
    broadcasts,
    error: err,
    lastRefreshedAt,
    dispatchAvailable,
    dispatchUnavailableReason,
    nextCursor,
    snapshotAt,
    loadingMore,
    loadMore,
    load,
    refreshing,
    setBroadcasts,
  } = useBroadcastList(canAdmin, online, documentVisible);

  // Audience-name lookups. A failed source remains visible as partial
  // evidence; stored ids are never silently presented as verified names.
  const [lists, setLists] = useState<SmsList[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [lookupErr, setLookupErr] = useState<string | null>(null);

  // Composer + confirm state.
  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<SmsBroadcast | null>(null);
  const [sendTarget, setSendTarget] = useState<SmsBroadcast | null>(null);
  const [cancelTarget, setCancelTarget] = useState<SmsBroadcast | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SmsBroadcast | null>(null);
  const actionOperation = useSingleFlightOperation({
    ownerId: "sms-broadcast-action",
    label: "SMS broadcast action",
    detail: "Wait for the broadcast request to finish before leaving.",
  });
  const actionBusy = actionOperation.active;

  // Progress drilldown: which row is expanded + its latest snapshot.
  const [progress, setProgress] = useState<SmsBroadcastProgress | null>(null);
  const [progressErr, setProgressErr] = useState<string | null>(null);

  // Mirror of `expandedId` for the async progress callbacks. The
  // refreshProgress useCallback closes over `expandedId` at definition
  // time; if we read that stale closure, an in-flight response for a
  // row the user already collapsed (and re-expanded a different one)
  // would write the wrong row's counts into the shared `progress`
  // state. The ref always reflects the LATEST expanded id.
  const expandedIdRef = useRef<string | null>(null);
  useEffect(() => {
    expandedIdRef.current = expandedId;
  }, [expandedId]);

  // Name lookups refresh after reconnect. Broadcast list ids belong to
  // sms_lists (UUIDs), never the numeric email-list namespace.
  useEffect(() => {
    if (!canAdmin || !online || !documentVisible) return;
    let cancelled = false;
    setLookupErr(null);
    const failures = new Set<string>();
    const surfaceFailures = (): void => {
      if (!cancelled) {
        setLookupErr(failures.size > 0 ? Array.from(failures).join(" ") : null);
      }
    };
    void listSmsLists()
      .then((listsRes) => {
        if (cancelled) return;
        if (listsRes && !listsRes.error) {
          setLists(listsRes.data?.items ?? []);
        } else {
          failures.add("SMS list names could not be verified.");
        }
        surfaceFailures();
      })
      .catch(() => {
        failures.add("SMS list names could not be verified.");
        surfaceFailures();
      });
    // Broadcasts persist `segment_id` as a canonical `segments.id`.
    // Directory saved-view ids belong to `saved_segments` and cannot be used
    // for delivery or for resolving the audience label here.
    void segmentsClient
      .list()
      .then((segmentsRes) => {
        if (cancelled) return;
        if (segmentsRes && !segmentsRes.error) {
          setSegments(Array.isArray(segmentsRes.data) ? segmentsRes.data : []);
        } else {
          failures.add("Segment names could not be verified.");
        }
        surfaceFailures();
      })
      .catch(() => {
        failures.add("Segment names could not be verified.");
        surfaceFailures();
      });
    return (): void => {
      cancelled = true;
    };
  }, [canAdmin, documentVisible, online]);

  const nameLookup = useMemo(
    () => ({
      listName: (id: string): string | undefined =>
        lists.find((l) => String(l.id) === id)?.name,
      segmentName: (id: string): string | undefined =>
        segments.find((s) => s.id === id)?.name,
    }),
    [lists, segments],
  );

  const expanded = useMemo(
    () => (broadcasts ?? []).find((b) => b.id === expandedId) ?? null,
    [broadcasts, expandedId],
  );

  const refreshProgress = useCallback(
    async (id: string, signal?: AbortSignal): Promise<void> => {
      let res: Awaited<ReturnType<typeof smsBroadcastsApi.progress>>;
      try {
        res = await smsBroadcastsApi.progress(id, { signal });
      } catch (error) {
        if (!signal?.aborted && id === expandedIdRef.current) {
          setProgressErr(
            lifecycleOperationError(error, "The progress request failed."),
          );
        }
        return;
      }
      if (signal?.aborted) return;
      // The drilldown may have collapsed or moved to another row while
      // this request was in flight. Only the row that is STILL expanded
      // owns the shared progress/error slots — otherwise a slow response
      // for row A would clobber row B's drilldown (expand A → collapse A
      // → expand B). The `setBroadcasts` mirror below is keyed by `id`,
      // so it stays correct regardless and runs unconditionally.
      const stillExpanded = id === expandedIdRef.current;
      if (res.error) {
        if (stillExpanded) setProgressErr(describeBroadcastError(res.error));
        return;
      }
      if (stillExpanded) setProgressErr(null);
      const p = res.data;
      if (p) {
        if (stillExpanded) setProgress(p);
        // The progress endpoint refreshes the denormalised counters
        // and lazily finalises sending → sent — mirror that into the
        // row so the badge/counters don't lag the drilldown.
        setBroadcasts((prev) =>
          (prev ?? []).map((b) =>
            b.id === id
              ? {
                  ...b,
                  status: p.status,
                  sent_count: p.sent,
                  failed_count: p.failed,
                  held_count: p.held,
                }
              : b,
          ),
        );
      }
    },
    [],
  );

  // Immediate fetch when a drilldown opens…
  useEffect(() => {
    setProgress(null);
    setProgressErr(null);
    if (canAdmin && expandedId && online && documentVisible) {
      const controller = new AbortController();
      void refreshProgress(expandedId, controller.signal);
      return () => controller.abort();
    } else if (expandedId) {
      setProgressErr(
        online
          ? "Return to the app to refresh the saved progress view."
          : "Reconnect to load the saved progress view.",
      );
    }
    return undefined;
  }, [canAdmin, documentVisible, expandedId, online, refreshProgress]);

  // …then poll every 5s, but only while the broadcast is sending.
  const pollingId =
    expanded && expanded.status === "sending" ? expanded.id : null;
  usePoller(
    async ({ signal }) => {
      if (!pollingId || signal.aborted) return;
      await refreshProgress(pollingId, signal);
    },
    canAdmin && pollingId && online && documentVisible
      ? PROGRESS_REFRESH_MS
      : 0,
    [canAdmin, documentVisible, online, pollingId],
  );

  /* ---------- actions ------------------------------------------------ */

  const onConfirmSend = async (): Promise<void> => {
    const target = sendTarget;
    if (!canAdmin || !target || dispatchAvailable !== true) return;
    const request = actionOperation.run(() => smsBroadcastsApi.send(target.id));
    if (!request) {
      await actionOperation.wait().catch(() => undefined);
      return;
    }
    try {
      const res = await request;
      if (res.error) {
        toast.error({
          message: "Couldn't start the broadcast",
          detail: describeBroadcastError(res.error),
        });
        return;
      }
      const out = res.data;
      setSendTarget(null);
      if (out?.broadcast.status === "scheduled") {
        toast.success(
          `Scheduled for ${fmtDateTime(out.broadcast.scheduled_at ?? undefined)}`,
        );
      } else {
        toast.success(
          out && out.enqueued > 0
            ? `Sending — ${out.enqueued.toLocaleString()} messages enqueued`
            : "Already sending — progress replayed (no new messages enqueued)",
        );
        // Open the drilldown so the operator watches it drain.
        if (out) onExpandedIdChange(out.broadcast.id);
      }
      void load();
    } catch (error) {
      toast.error({
        message: "Couldn't start the broadcast",
        detail: lifecycleOperationError(error, "The send request failed."),
      });
    }
  };

  const onConfirmCancel = async (): Promise<void> => {
    const target = cancelTarget;
    if (!canAdmin || !target) return;
    const request = actionOperation.run(() =>
      smsBroadcastsApi.cancel(target.id),
    );
    if (!request) {
      await actionOperation.wait().catch(() => undefined);
      return;
    }
    try {
      const res = await request;
      if (res.error) {
        toast.error({
          message: "Couldn't cancel the broadcast",
          detail: describeBroadcastError(res.error),
        });
        return;
      }
      setCancelTarget(null);
      toast.success("Broadcast cancelled");
      void load();
    } catch (error) {
      toast.error({
        message: "Couldn't cancel the broadcast",
        detail: lifecycleOperationError(
          error,
          "The cancellation request failed.",
        ),
      });
    }
  };

  const onConfirmDelete = async (): Promise<void> => {
    const target = deleteTarget;
    if (!canAdmin || !target) return;
    const request = actionOperation.run(() =>
      smsBroadcastsApi.remove(target.id),
    );
    if (!request) {
      await actionOperation.wait().catch(() => undefined);
      return;
    }
    try {
      const res = await request;
      if (res.error) {
        toast.error({
          message: "Couldn't delete the draft",
          detail: describeBroadcastError(res.error),
        });
        return;
      }
      setDeleteTarget(null);
      toast.success("Broadcast draft deleted");
      if (expandedId === target.id) onExpandedIdChange(null);
      setBroadcasts((prev) =>
        (prev ?? []).filter((broadcast) => broadcast.id !== target.id),
      );
    } catch (error) {
      toast.error({
        message: "Couldn't delete the draft",
        detail: lifecycleOperationError(error, "The delete request failed."),
      });
    }
  };

  return (
    <div>
      <BroadcastListSurface
        canAdmin={canAdmin}
        broadcasts={broadcasts}
        error={err}
        nameLookup={nameLookup}
        expandedId={expandedId}
        progress={progress}
        progressError={progressErr}
        lookupError={lookupErr}
        online={online}
        refreshing={refreshing}
        lastRefreshedAt={lastRefreshedAt}
        snapshotAt={snapshotAt}
        hasMore={Boolean(nextCursor)}
        loadingMore={loadingMore}
        actionBusy={actionBusy}
        dispatchAvailable={dispatchAvailable}
        dispatchUnavailableReason={dispatchUnavailableReason}
        onRefresh={() => void load()}
        onLoadMore={() => void loadMore()}
        onCreate={() => {
          setEditing(null);
          setComposerOpen(true);
        }}
        onEdit={(broadcast) => {
          setEditing(broadcast);
          setComposerOpen(true);
        }}
        onSend={(broadcast) => {
          if (dispatchAvailable === true) setSendTarget(broadcast);
        }}
        onCancel={setCancelTarget}
        onDelete={setDeleteTarget}
        onToggleProgress={(id) =>
          onExpandedIdChange(expandedId === id ? null : id)
        }
      />

      {canAdmin ? (
        <>
          <BroadcastComposerModal
            open={composerOpen}
            existing={editing}
            onClose={() => setComposerOpen(false)}
            onSaved={() => {
              setComposerOpen(false);
              toast.success(editing ? "Broadcast updated" : "Draft created");
              void load();
            }}
          />

          <BroadcastConfirmModals
            sendTarget={sendTarget}
            cancelTarget={cancelTarget}
            deleteTarget={deleteTarget}
            actionBusy={actionBusy}
            nameLookup={nameLookup}
            onCloseSend={() => setSendTarget(null)}
            onCloseCancel={() => setCancelTarget(null)}
            onCloseDelete={() => setDeleteTarget(null)}
            onConfirmSend={() => void onConfirmSend()}
            onConfirmCancel={() => void onConfirmCancel()}
            onConfirmDelete={() => void onConfirmDelete()}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Progress drilldown row — renders the GET /{id}/progress payload
 * verbatim (sent / failed / held / total). The parent owns the
 * polling; this is purely presentational.
 */
function BroadcastProgressRow(props: {
  broadcast: SmsBroadcast;
  progress: SmsBroadcastProgress | null;
  error: string | null;
}): ReactElement {
  const { broadcast, progress, error } = props;
  const extended = progress as
    | (SmsBroadcastProgress & {
        pending?: number;
        reconciling?: number;
        asOf?: string;
      })
    | null;
  const completed = progress
    ? Math.min(progress.total, progress.sent + progress.failed)
    : 0;
  const pending = progress
    ? (extended?.pending ??
      Math.max(
        0,
        progress.total - progress.sent - progress.failed - progress.held,
      ))
    : 0;
  return (
    <div
      className="sms-broadcast-progress"
      aria-live="polite"
      aria-atomic="true"
    >
      {error ? (
        <Notice
          tone={progress ? "warning" : "danger"}
          announcement={progress ? "polite" : "assertive"}
        >
          Couldn&apos;t refresh progress: {error}
          {progress ? " The last loaded counters remain below." : ""}
        </Notice>
      ) : null}
      {!progress ? (
        error ? null : (
          <span className="muted small">Loading progress…</span>
        )
      ) : (
        <div className="sms-broadcast-progress-layout">
          <div className="sms-broadcast-progress-summary">
            <div>
              <span className="muted small">Latest recorded send status</span>
              <strong>{progress.status}</strong>
            </div>
            <span className="tabular small">
              {progressPct(progress)}% accepted or recorded failed ·{" "}
              {completed.toLocaleString()} of {progress.total.toLocaleString()}
            </span>
          </div>
          <progress
            max={Math.max(1, progress.total)}
            value={completed}
            aria-label={`${completed} of ${progress.total} recipients were accepted by a provider or recorded failed`}
          />
          <dl className="sms-broadcast-progress-counts">
            <div>
              <dt>Accepted by provider</dt>
              <dd>{progress.sent.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Recorded failed</dt>
              <dd>{progress.failed.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Held</dt>
              <dd>{progress.held.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Pending</dt>
              <dd>{pending.toLocaleString()}</dd>
            </div>
            {extended?.reconciling !== undefined ? (
              <div>
                <dt>Reconciling</dt>
                <dd>{extended.reconciling.toLocaleString()}</dd>
              </div>
            ) : null}
          </dl>
          {progress.held > 0 ? (
            <p className="muted small">
              Held = waiting out a quiet-hours window. Eligibility is rechecked
              before a later dispatch attempt.
            </p>
          ) : null}
          <p className="muted small sms-broadcast-progress-asof">
            {extended?.asOf
              ? `Progress counters as of ${fmtDateTime(extended.asOf)}.`
              : "The server did not include a progress as-of time."}{" "}
            {broadcast.status === "sending"
              ? "Refreshing every 5 seconds while this view is online."
              : "Polling is stopped because this broadcast is not sending."}
          </p>
        </div>
      )}
    </div>
  );
}
