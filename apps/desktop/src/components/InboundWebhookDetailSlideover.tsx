/**
 * InboundWebhookDetailSlideover — full details for one inbound endpoint
 * with a recent-events list and dangerous actions (rotate, delete).
 *
 * Loads `/api/v1/inbound-webhooks/{id}/events?limit=` on mount so
 * operators can inspect recent deliveries and signature outcomes.
 */

import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { getApiUrl, getInboundWebhookSignatureState } from "../lib/api-client";
import type {
  InboundWebhookEndpoint,
  InboundWebhookEvent,
} from "../lib/api-client";
import { api } from "../lib/api-client";
import { newUUIDv7 } from "../lib/http-fetch";
import { useCanAdmin } from "../lib/store";
import { clipboardSuccessDetail, writeClipboardText } from "../lib/clipboard";
import { ConfirmModal } from "./ConfirmModal";
import { Notice } from "./Notice";
import { SlideoverShell } from "./SlideoverShell";
import { toast } from "./Toast";
import { TriggersPanel } from "./webhooks/TriggersPanel";

interface Props {
  endpoint: InboundWebhookEndpoint;
  onClose: () => void;
  /**
   * Open the rotate-secret confirmation. The parent owns the "shown
   * once" success view because it's also rendered inline after Create.
   */
  onRotate: (endpoint: InboundWebhookEndpoint) => void;
  /** Fired after a successful DELETE so the list can refresh. */
  onDeleted: () => void;
}

function InboundDetailShell({
  busy = false,
  children,
  onClose,
  subtitle,
  title,
}: {
  busy?: boolean;
  children: ReactNode;
  onClose: () => void;
  subtitle: ReactNode;
  title: ReactNode;
}): ReactElement {
  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="md"
      eyebrow="Inbound webhook"
      title={title}
      subtitle={subtitle}
      closeOnBackdrop={!busy}
      busy={busy}
    >
      {children}
    </SlideoverShell>
  );
}

const EVENT_LIMIT = 20;

function fmtDate(s: string | undefined | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
}

function publicUrlFor(slug: string): string {
  // The base URL points at the same Moosewave API host the desktop talks
  // to. The public ingest path is unauthenticated.
  return new URL(
    `./api/public/inbound/${encodeURIComponent(slug)}`,
    `${getApiUrl().replace(/\/+$/, "")}/`,
  ).toString();
}

function thrownMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sampleEventBody(events: InboundWebhookEvent[] | null): string {
  const mostRecentVerified = events?.find(
    (event) => getInboundWebhookSignatureState(event) === "verified",
  );
  return mostRecentVerified?.body ?? "";
}

function InboundEventPayload({
  body,
  verified,
}: {
  body: string;
  verified: boolean;
}): ReactElement {
  const [revealed, setRevealed] = useState(false);
  const excerpt = body.slice(0, 120) || "(empty payload)";
  if (verified) {
    return (
      <span className="wh-inbound-event-body">
        <span className="muted small">Processed payload</span>
        <span className="mono">{excerpt}</span>
      </span>
    );
  }
  return (
    <span className="wh-inbound-event-body">
      <span className="muted small">
        Payload hidden because signature verification failed
      </span>
      <button
        type="button"
        className="btn btn-xs"
        aria-expanded={revealed}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? "Hide invalid payload" : "Reveal invalid payload"}
      </button>
      {revealed ? <span className="mono">{excerpt}</span> : null}
    </span>
  );
}

interface RecentInboundEventsProps {
  error: string | null;
  events: InboundWebhookEvent[] | null;
  eventsTitleId: string;
  loading: boolean;
  loadingMore: boolean;
  moreError: string | null;
  nextCursor: string | null;
  onLoadMore: () => Promise<void>;
  onReload: () => Promise<void>;
  onSelectReplay: (event: InboundWebhookEvent) => void;
  operationBusy: boolean;
  replayHelpId: string;
}

function RecentInboundEvents({
  error,
  events,
  eventsTitleId,
  loading,
  loadingMore,
  moreError,
  nextCursor,
  onLoadMore,
  onReload,
  onSelectReplay,
  operationBusy,
  replayHelpId,
}: RecentInboundEventsProps): ReactElement {
  return (
    <section
      aria-labelledby={eventsTitleId}
      aria-busy={loading || loadingMore ? "true" : undefined}
    >
      <div className="wh-triggers-head">
        <h3 id={eventsTitleId} className="label" style={{ margin: 0 }}>
          Recent events
        </h3>
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading || loadingMore}
          onClick={() => void onReload()}
        >
          {loading ? "Refreshing events…" : "Refresh events"}
        </button>
      </div>
      {loading && !events ? (
        <div role="status" aria-live="polite">
          <span className="visually-hidden">Loading recent events…</span>
          <div className="skel" style={{ height: 40 }} aria-hidden="true" />
        </div>
      ) : null}
      {loading && events ? (
        <div className="muted small" role="status" aria-live="polite">
          Refreshing recent events… Last verified rows remain visible.
        </div>
      ) : null}
      {error ? (
        <div className="field-error" role="alert">
          <div>
            {events
              ? `Couldn't refresh events: ${error} Previously verified events remain visible and may be stale.`
              : `Couldn't load events: ${error}`}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void onReload()}
            style={{ marginTop: 8 }}
          >
            Retry loading events
          </button>
        </div>
      ) : null}
      {!loading && !error && (!events || events.length === 0) ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No events received yet. Once an external system POSTs to the public
          URL it will appear here.
        </div>
      ) : null}
      {events && events.length > 0 ? (
        <div className="wh-inbound-event-list" role="list">
          {events.map((event) => {
            const signatureState = getInboundWebhookSignatureState(event);
            const signatureLabel =
              signatureState === "verified" ? "Verified" : "Invalid signature";
            const signatureTone =
              signatureState === "verified" ? "success" : "danger";
            return (
              <div
                key={String(event.id)}
                className="wh-inbound-event-row"
                role="listitem"
              >
                <span
                  className={`badge ${signatureTone}`.trim()}
                  style={{ flexShrink: 0 }}
                  aria-label={`Signature verification: ${signatureLabel}`}
                >
                  {signatureLabel}
                </span>
                <span
                  className="muted tabular"
                  style={{ fontSize: 11, flexShrink: 0 }}
                >
                  {fmtDate(event.received_at)}
                </span>
                <InboundEventPayload
                  body={event.body}
                  verified={signatureState === "verified"}
                />
                <button
                  type="button"
                  className="btn btn-xs"
                  style={{ flexShrink: 0 }}
                  disabled={operationBusy || signatureState !== "verified"}
                  onClick={() => onSelectReplay(event)}
                  aria-describedby={replayHelpId}
                  aria-label={
                    signatureState === "verified"
                      ? "Replay event"
                      : "Replay unavailable: invalid signature"
                  }
                  title={
                    signatureState === "verified"
                      ? "Queue a new trigger-evaluation attempt"
                      : "Events that failed signature verification cannot be replayed."
                  }
                >
                  Replay event
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {!loading && events && events.length > 0 ? (
        <div
          className="wh-pagination-footer wh-pagination-footer--events"
          aria-live="polite"
          aria-label="Inbound event pagination"
        >
          <div className="wh-pagination-copy">
            {moreError ? (
              <span className="field-error" role="alert">
                Couldn&apos;t load older events: {moreError}
              </span>
            ) : null}
            <span className="muted small">
              {moreError
                ? `${events.length.toLocaleString()} previously loaded event${events.length === 1 ? "" : "s"} remain visible. History completeness is unknown until pagination succeeds.`
                : nextCursor
                  ? `${events.length.toLocaleString()} recent events loaded. Older retained events are available.`
                  : `All ${events.length.toLocaleString()} available retained event${events.length === 1 ? "" : "s"} are loaded.`}
            </span>
          </div>
          {nextCursor ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={loadingMore}
              onClick={() => void onLoadMore()}
            >
              {loadingMore
                ? "Loading older events…"
                : moreError
                  ? "Retry loading older events"
                  : "Load older events"}
            </button>
          ) : null}
        </div>
      ) : null}
      <p id={replayHelpId} className="muted" style={{ fontSize: 11 }}>
        Replaying evaluates the stored processed payload and queues fresh action
        attempts. Workers execute valid actions asynchronously.
      </p>
    </section>
  );
}

function InboundEndpointAddress({
  onCopy,
  slug,
  url,
}: {
  onCopy: () => Promise<void>;
  slug: string;
  url: string;
}): ReactElement {
  return (
    <>
      <div>
        <div className="label">Public URL</div>
        <div className="copy-row">
          <output className="copy-text" aria-label="Public URL">
            {url}
          </output>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void onCopy()}
          >
            Copy URL
          </button>
        </div>
        <div className="wh-inbound-signing-contract">
          <strong>Authenticated v2 request contract</strong>
          <span>
            Send mandatory <code>X-Postwave-Timestamp</code> and stable{" "}
            <code>X-Postwave-Event-Id</code> headers. Set{" "}
            <code>X-Postwave-Signature</code> to{" "}
            <code>v2=&lt;hex_hmac_sha256&gt;</code> over the exact byte string:
          </span>
          {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- This horizontally scrollable, named region must be reachable without a pointing device. */}
          <pre
            className="wh-framing-code"
            role="region"
            aria-label="Inbound webhook HMAC v2 signature framing"
            tabIndex={0}
          >
            <code>
              v2:&lt;timestampByteLen&gt;:&lt;timestamp&gt;:&lt;eventIdByteLen&gt;:&lt;eventId&gt;:&lt;rawBody&gt;
            </code>
          </pre>
          {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
          <span>
            Byte lengths make the authenticated fields unambiguous. The
            timestamp must be within five minutes. Legacy raw-hex v1 is a
            compatibility opt-in only; do not use it for new senders.
          </span>
        </div>
      </div>
      <div>
        <div className="label">Slug</div>
        <div className="mono" style={{ fontSize: 12 }}>
          {slug}
        </div>
      </div>
    </>
  );
}

interface InboundEventHistory {
  events: InboundWebhookEvent[] | null;
  error: string | null;
  loading: boolean;
  loadingMore: boolean;
  moreError: string | null;
  nextCursor: string | null;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
}

interface InboundEventPageValidation {
  pageIds: Set<string>;
  issue: string | null;
}

function validateInboundEventPage({
  items,
  nextCursor,
  requestedCursor,
  append,
  loadedCursors,
  loadedEventIds,
}: {
  items: InboundWebhookEvent[];
  nextCursor: string;
  requestedCursor: string;
  append: boolean;
  loadedCursors: Set<string>;
  loadedEventIds: Set<string>;
}): InboundEventPageValidation {
  const pageIds = new Set<string>();
  for (const event of items) {
    const id = String(event.id);
    if (pageIds.has(id)) {
      return {
        pageIds,
        issue:
          "Moosewave returned duplicate events in one page. The unverified page was not shown.",
      };
    }
    pageIds.add(id);
  }
  if (append && items.some((event) => loadedEventIds.has(String(event.id)))) {
    return {
      pageIds,
      issue:
        "Moosewave returned an event that was already loaded. Pagination stopped safely without adding the unverified page.",
    };
  }
  if (
    nextCursor &&
    (nextCursor === requestedCursor ||
      (append && loadedCursors.has(nextCursor)))
  ) {
    return {
      pageIds,
      issue:
        "Moosewave repeated an event-history cursor. Pagination stopped safely without adding the unverified page.",
    };
  }
  return { pageIds, issue: null };
}

function useInboundEventHistory(endpointId: string): InboundEventHistory {
  const [events, setEvents] = useState<InboundWebhookEvent[] | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const eventsRequestRef = useRef(0);
  const ownerIdRef = useRef<string | null>(null);
  const loadMoreRef = useRef<Promise<void> | null>(null);
  const loadedCursorsRef = useRef<Set<string>>(new Set());
  const loadedEventIdsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(false);
  const currentEndpointIdRef = useRef(endpointId);
  currentEndpointIdRef.current = endpointId;

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++eventsRequestRef.current;
    const sameOwner = ownerIdRef.current === endpointId;
    ownerIdRef.current = endpointId;
    setOwnerId(endpointId);
    if (!sameOwner) {
      setEvents(null);
      setNextCursor(null);
      loadedCursorsRef.current = new Set();
      loadedEventIdsRef.current = new Set();
    }
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(null);
    loadMoreRef.current = null;
    try {
      const res = await api.listInboundWebhookEvents(endpointId, {
        limit: EVENT_LIMIT,
      });
      if (
        requestId !== eventsRequestRef.current ||
        currentEndpointIdRef.current !== endpointId
      ) {
        return;
      }
      if (res.error) {
        setError(res.error.message);
      } else {
        const next = res.data.next_cursor || "";
        const validation = validateInboundEventPage({
          items: res.data.items,
          nextCursor: next,
          requestedCursor: "",
          append: false,
          loadedCursors: loadedCursorsRef.current,
          loadedEventIds: loadedEventIdsRef.current,
        });
        if (validation.issue) {
          setError(validation.issue);
          setNextCursor(null);
          return;
        }
        loadedEventIdsRef.current = validation.pageIds;
        loadedCursorsRef.current = new Set(next ? [next] : []);
        setEvents(res.data.items);
        setNextCursor(next || null);
      }
    } catch (caught) {
      if (
        requestId === eventsRequestRef.current &&
        currentEndpointIdRef.current === endpointId
      ) {
        setError(thrownMessage(caught, "The event history request failed."));
      }
    } finally {
      if (
        requestId === eventsRequestRef.current &&
        currentEndpointIdRef.current === endpointId
      ) {
        setLoading(false);
      }
    }
  }, [endpointId]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadMoreRef.current) return loadMoreRef.current;
    if (!nextCursor || loading) return;
    const cursor = nextCursor;
    const requestId = eventsRequestRef.current;
    setLoadingMore(true);
    setMoreError(null);
    const request = (async (): Promise<void> => {
      try {
        const res = await api.listInboundWebhookEvents(endpointId, {
          cursor,
          limit: EVENT_LIMIT,
        });
        if (
          !mountedRef.current ||
          currentEndpointIdRef.current !== endpointId ||
          eventsRequestRef.current !== requestId
        ) {
          return;
        }
        if (res.error) {
          setMoreError(res.error.message);
          return;
        }
        const next = res.data.next_cursor || "";
        const validation = validateInboundEventPage({
          items: res.data.items,
          nextCursor: next,
          requestedCursor: cursor,
          append: true,
          loadedCursors: loadedCursorsRef.current,
          loadedEventIds: loadedEventIdsRef.current,
        });
        if (validation.issue) {
          setNextCursor(null);
          setMoreError(validation.issue);
          return;
        }
        for (const event of res.data.items) {
          loadedEventIdsRef.current.add(String(event.id));
        }
        loadedCursorsRef.current.add(cursor);
        if (next) loadedCursorsRef.current.add(next);
        setEvents((current) => [...(current ?? []), ...res.data.items]);
        setNextCursor(next || null);
      } catch (caught) {
        if (
          mountedRef.current &&
          currentEndpointIdRef.current === endpointId &&
          eventsRequestRef.current === requestId
        ) {
          setMoreError(
            thrownMessage(
              caught,
              "Older retained events couldn't be loaded. Check your connection and retry.",
            ),
          );
        }
      } finally {
        if (
          mountedRef.current &&
          currentEndpointIdRef.current === endpointId &&
          eventsRequestRef.current === requestId
        ) {
          setLoadingMore(false);
        }
        if (eventsRequestRef.current === requestId) {
          loadMoreRef.current = null;
        }
      }
    })();
    loadMoreRef.current = request;
    return request;
  }, [endpointId, loading, nextCursor]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      eventsRequestRef.current += 1;
      loadMoreRef.current = null;
    };
  }, [endpointId, load]);

  const ownsVisibleRows = ownerId === endpointId;
  return {
    events: ownsVisibleRows ? events : null,
    error: ownsVisibleRows ? error : null,
    loading: !ownsVisibleRows || loading,
    loadingMore: ownsVisibleRows && loadingMore,
    moreError: ownsVisibleRows ? moreError : null,
    nextCursor: ownsVisibleRows ? nextCursor : null,
    load,
    loadMore,
  };
}

function InboundWebhookAdminRequired({
  onClose,
}: Pick<Props, "onClose">): ReactElement {
  return (
    <InboundDetailShell
      onClose={onClose}
      title="Admin access required"
      subtitle="Inbound event history is restricted."
    >
      <Notice tone="warning" title="Admin access required">
        Endpoint signing details, retained payloads, trigger configuration, and
        replay controls are restricted to workspace admins. No webhook history
        was requested.
      </Notice>
    </InboundDetailShell>
  );
}

export function InboundWebhookDetailSlideover(props: Props): ReactElement {
  const canAdmin = useCanAdmin();
  if (!canAdmin) {
    return <InboundWebhookAdminRequired onClose={props.onClose} />;
  }
  return <InboundWebhookDetailAdmin {...props} />;
}

function InboundWebhookDetailAdmin({
  endpoint,
  onClose,
  onRotate,
  onDeleted,
}: Props): ReactElement {
  const eventHistory = useInboundEventHistory(endpoint.id);
  const [deleting, setDeleting] = useState(false);
  const [deleteTargetEndpointId, setDeleteTargetEndpointId] = useState<
    string | null
  >(null);
  // Re-evaluate the stored processed payload so operators can debug a trigger
  // without asking the source system to send the event again. The 202 response
  // proves durable planning/enqueue only; workers execute valid actions later.
  const [replaySelection, setReplaySelection] = useState<{
    endpointId: string;
    event: InboundWebhookEvent;
  } | null>(null);
  const [replaying, setReplaying] = useState(false);
  const deleteOperationRef = useRef<symbol | null>(null);
  const replayOperationRef = useRef<symbol | null>(null);
  const replayIdempotencyKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const currentEndpointIdRef = useRef(endpoint.id);
  const replayHelpId = useId();
  const eventsTitleId = useId();
  currentEndpointIdRef.current = endpoint.id;

  const url = publicUrlFor(endpoint.slug);
  const label = endpoint.name || endpoint.slug;
  const confirmDeleteOpen = deleteTargetEndpointId === endpoint.id;
  const replayTarget =
    replaySelection?.endpointId === endpoint.id ? replaySelection.event : null;

  useEffect(() => {
    mountedRef.current = true;
    setDeleteTargetEndpointId(null);
    setReplaySelection(null);
    replayIdempotencyKeyRef.current = null;
    deleteOperationRef.current = null;
    replayOperationRef.current = null;
    setDeleting(false);
    setReplaying(false);
    return () => {
      mountedRef.current = false;
    };
  }, [endpoint.id]);

  const copy = async (text: string, kind: string): Promise<void> => {
    try {
      const secret = kind.toLowerCase().includes("secret");
      const result = await writeClipboardText(text, {
        contentClass: secret ? "secret" : "public",
        label: kind,
        clearIfUnchangedAfterMs: secret ? 60_000 : undefined,
      });
      if (result.ok) {
        toast.success({
          message: `${kind} copied`,
          detail: clipboardSuccessDetail(result),
        });
      } else toast.error(result.message);
    } catch (error) {
      toast.error(thrownMessage(error, `${kind} couldn't be copied.`));
    }
  };

  const replayEvent = async (): Promise<void> => {
    if (
      !replayTarget ||
      getInboundWebhookSignatureState(replayTarget) !== "verified" ||
      replayOperationRef.current
    ) {
      return;
    }
    const endpointId = endpoint.id;
    const targetId = replayTarget.id;
    const operation = Symbol("replay-inbound-event");
    const idempotencyKey =
      replayIdempotencyKeyRef.current ??
      (replayIdempotencyKeyRef.current = newUUIDv7());
    replayOperationRef.current = operation;
    setReplaying(true);
    try {
      const res = await api.replayInboundEvent(endpointId, targetId, {
        idempotencyKey,
      });
      if (
        !mountedRef.current ||
        currentEndpointIdRef.current !== endpointId ||
        replayOperationRef.current !== operation
      ) {
        return;
      }
      if (res.error) {
        toast.error(`Replay failed: ${res.error.message}`);
        return;
      }
      const matches = res.data.matches;
      const queued = matches.filter((match) => match.queued).length;
      const rejected = matches.length - queued;
      setReplaySelection(null);
      replayIdempotencyKeyRef.current = null;
      toast.success(
        queued > 0
          ? `Replay queued — ${queued} matching trigger action${queued === 1 ? "" : "s"} awaiting execution${rejected > 0 ? `; ${rejected} matched but could not be queued` : ""}.`
          : matches.length > 0
            ? `Replay accepted — ${matches.length} trigger${matches.length === 1 ? "" : "s"} matched, but no actions were queued. Review the trigger configuration.`
            : "Replay accepted — no active triggers matched this event.",
      );
    } catch (error) {
      if (
        mountedRef.current &&
        currentEndpointIdRef.current === endpointId &&
        replayOperationRef.current === operation
      ) {
        toast.error(
          `Replay failed: ${thrownMessage(error, "The replay request failed.")}`,
        );
      }
    } finally {
      if (replayOperationRef.current === operation) {
        replayOperationRef.current = null;
        if (mountedRef.current && currentEndpointIdRef.current === endpointId) {
          setReplaying(false);
        }
      }
    }
  };

  // Fired from the ConfirmModal's confirm button. (This used to be
  // gated on window.confirm, which silently no-ops in the Tauri
  // webview — the delete button did nothing.)
  const doDelete = async (): Promise<void> => {
    if (deleteOperationRef.current) return;
    const endpointId = endpoint.id;
    const operation = Symbol("delete-inbound-webhook");
    deleteOperationRef.current = operation;
    setDeleting(true);
    try {
      const res = await api.deleteInboundWebhook(endpointId);
      if (
        !mountedRef.current ||
        currentEndpointIdRef.current !== endpointId ||
        deleteOperationRef.current !== operation
      ) {
        return;
      }
      if (res.error) {
        toast.error(res.error.message);
        return;
      }
      setDeleteTargetEndpointId(null);
      setDeleting(false);
      deleteOperationRef.current = null;
      toast.success("Endpoint deleted");
      onDeleted();
    } catch (error) {
      if (
        mountedRef.current &&
        currentEndpointIdRef.current === endpointId &&
        deleteOperationRef.current === operation
      ) {
        toast.error(thrownMessage(error, "The endpoint couldn't be deleted."));
      }
    } finally {
      if (deleteOperationRef.current === operation) {
        deleteOperationRef.current = null;
        if (mountedRef.current && currentEndpointIdRef.current === endpointId) {
          setDeleting(false);
        }
      }
    }
  };

  const operationBusy = deleting || replaying;
  const requestClose = (): void => {
    if (
      deleteOperationRef.current ||
      replayOperationRef.current ||
      operationBusy
    ) {
      return;
    }
    onClose();
  };

  return (
    <>
      <InboundDetailShell
        onClose={requestClose}
        title={label}
        subtitle={`Created ${fmtDate(endpoint.createdAt)}`}
        busy={operationBusy}
      >
        <InboundEndpointAddress
          onCopy={() => copy(url, "URL")}
          slug={endpoint.slug}
          url={url}
        />

        {/* PR final batch: triggers panel. Renders above Recent
            events so users can debug "why didn't my trigger fire"
            against the freshest event body below. */}
        <TriggersPanel
          webhookId={endpoint.id}
          sampleBody={sampleEventBody(eventHistory.events)}
        />

        <RecentInboundEvents
          error={eventHistory.error}
          events={eventHistory.events}
          eventsTitleId={eventsTitleId}
          loading={eventHistory.loading}
          loadingMore={eventHistory.loadingMore}
          moreError={eventHistory.moreError}
          nextCursor={eventHistory.nextCursor}
          onLoadMore={eventHistory.loadMore}
          onReload={eventHistory.load}
          onSelectReplay={(event) => {
            if (getInboundWebhookSignatureState(event) !== "verified") return;
            // A deliberate new selection starts a new logical replay. If a
            // prior confirmed request failed ambiguously, retries inside its
            // still-open confirm reuse that operation's key instead.
            replayIdempotencyKeyRef.current = null;
            setReplaySelection({ endpointId: endpoint.id, event });
          }}
          operationBusy={operationBusy}
          replayHelpId={replayHelpId}
        />

        <div style={{ marginTop: "auto" }}>
          <div className="label">Danger zone</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={operationBusy}
              onClick={() => onRotate(endpoint)}
            >
              Rotate secret
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setDeleteTargetEndpointId(endpoint.id)}
              disabled={operationBusy}
            >
              {deleting ? "Deleting…" : "Delete endpoint"}
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Rotation makes the new secret primary immediately and accepts the
            previous secret for 24 hours. Update the sender before the old
            secret expires.
          </div>
        </div>
      </InboundDetailShell>

      <ConfirmModal
        open={confirmDeleteOpen}
        title={`Delete "${label}"?`}
        description="Public ingest stops immediately and this endpoint disappears. Its signing secrets are shredded; retained event and action evidence remains only for governed retention and can delay physical purge. This cannot be undone."
        confirmLabel="Delete endpoint"
        danger
        busy={deleting}
        onConfirm={doDelete}
        onClose={() => {
          if (!deleteOperationRef.current) setDeleteTargetEndpointId(null);
        }}
      />

      <ConfirmModal
        open={replayTarget !== null}
        title="Replay this event?"
        description="Evaluates the stored processed payload and queues new attempts for valid matching trigger actions. Workers execute them later, and real side effects may repeat."
        confirmLabel="Replay event"
        danger
        busy={replaying}
        onConfirm={replayEvent}
        onClose={() => {
          if (!replayOperationRef.current) {
            replayIdempotencyKeyRef.current = null;
            setReplaySelection(null);
          }
        }}
      />
    </>
  );
}
