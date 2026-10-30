/**
 * InboundWebhooks — admin view of HMAC-authenticated inbound endpoints
 * that receive product events from external systems.
 *
 * Lists `/api/v1/inbound-webhooks`, lets the operator create new
 * endpoints, and surfaces the freshly-minted plaintext signing secret
 * via a "shown once" success view (modelled on AWS-style "copy this
 * now, you won't see it again" UX).
 *
 * The Go handler exposes List / Create / Get / Recent events / Rotate /
 * Delete. Detail and rotation both use shown-once secret handling so the
 * operator can verify integrations without exposing historical secrets.
 */

import {
  type Dispatch,
  type MutableRefObject,
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { InboundWebhookDetailSlideover } from "../components/InboundWebhookDetailSlideover";
import { InlineHelp } from "../components/InlineHelp";
import { Modal, ModalFooter } from "../components/Modal";
import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { SectionHeader } from "../components/SectionHeader";
import { StatStrip, type StatCell } from "../components/StatStrip";
import { toast } from "../components/Toast";
import { WebhookOnboardingGallery } from "../components/webhooks/WebhookOnboardingGallery";
import { InboundEndpointEditDialog } from "../components/webhooks/InboundEndpointEditDialog";
import { useShownOnceSecretLifecycle } from "../hooks/useShownOnceSecretLifecycle";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import {
  type InboundWebhookEndpoint,
  api,
  getApiUrl,
  updateInboundWebhookEndpoint,
} from "../lib/api-client";
import { fmtDate } from "../lib/format-date";
import { clipboardSuccessDetail, writeClipboardText } from "../lib/clipboard";
import { HERO } from "../lib/heroAssets";
import { newUUIDv7 } from "../lib/http-fetch";
import { useCanAdmin } from "../lib/store";
import "../styles-webhooks.css";

const COLS =
  "minmax(140px, 1.4fr) minmax(220px, 2fr) 110px 140px minmax(150px, auto)";
const ENDPOINT_PAGE_LIMIT = 50;
const ENDPOINT_SEARCH_DEBOUNCE_MS = 250;

function publicUrlFor(slug: string): string {
  return new URL(
    `./api/public/inbound/${encodeURIComponent(slug)}`,
    `${getApiUrl().replace(/\/+$/, "")}/`,
  ).toString();
}

function buildInboundStats(rows: InboundWebhookEndpoint[] | null): StatCell[] {
  if (!rows) {
    return [
      { label: "Loaded endpoints", value: "—" },
      { label: "Enabled", value: "—" },
      { label: "Events received", value: "—" },
    ];
  }
  return [
    { label: "Loaded endpoints", value: rows.length.toLocaleString() },
    {
      label: "Enabled",
      value: rows
        .filter((row) => row.enabled !== false)
        .length.toLocaleString(),
      hint: "Endpoints currently accepting correctly signed requests.",
    },
    {
      label: "Events received",
      value: "—",
      hint: "The endpoint list contract does not include aggregate event counts. Open an endpoint to inspect retained events.",
    },
  ];
}

function filterInboundEndpoints(
  rows: InboundWebhookEndpoint[] | null,
  query: string,
): InboundWebhookEndpoint[] {
  if (!rows) return [];
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return rows;
  return rows.filter((row) => {
    const label = row.name.toLowerCase();
    return (
      label.includes(normalizedQuery) ||
      row.slug.toLowerCase().includes(normalizedQuery)
    );
  });
}

function useDebouncedInboundQuery(query: string): string {
  const normalized = query.trim();
  const [debounced, setDebounced] = useState(normalized);
  useEffect(() => {
    if (normalized === debounced) return;
    const timer = window.setTimeout(
      () => setDebounced(normalized),
      ENDPOINT_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [debounced, normalized]);
  return debounced;
}

interface InboundSecretReveal {
  endpoint: InboundWebhookEndpoint;
  secret: string;
  kind: "create" | "rotate";
}

function InboundPageChrome({
  rows,
  filteredCount,
  stats,
  canAdmin,
  loading,
  revealed,
  operationActive,
  query,
  searchPending,
  error,
  clipboardStatus,
  onLoad,
  onCreate,
  onQueryChange,
}: {
  rows: InboundWebhookEndpoint[] | null;
  filteredCount: number;
  stats: StatCell[];
  canAdmin: boolean;
  loading: boolean;
  revealed: boolean;
  operationActive: boolean;
  query: string;
  searchPending: boolean;
  error: string | null;
  clipboardStatus: string | null;
  onLoad: () => void;
  onCreate: () => void;
  onQueryChange: (value: string) => void;
}): ReactElement {
  const searchId = useId();
  const refreshAction = {
    label: loading ? "Refreshing…" : "Refresh",
    onClick: onLoad,
    variant: "ghost" as const,
    disabled: loading,
    title: loading
      ? "The endpoint list is already refreshing."
      : "Reload endpoint status from the server.",
  };
  return (
    <>
      <PageHeader
        eyebrow="Webhooks"
        title="Inbound webhooks"
        subtitle={
          rows && (!error || rows.length > 0)
            ? `${filteredCount.toLocaleString()} loaded endpoint${filteredCount === 1 ? "" : "s"} — receive JSON from senders implementing Moosewave's versioned timestamp-and-event HMAC contract.`
            : error
              ? "Endpoint state is unavailable until the request succeeds."
              : "Loading endpoints…"
        }
        actions={
          canAdmin
            ? [
                refreshAction,
                {
                  label: "New endpoint",
                  onClick: onCreate,
                  variant: "primary",
                  disabled: loading || operationActive || revealed,
                  title: revealed
                    ? "Store or explicitly discard the shown signing secret before creating another endpoint."
                    : operationActive
                      ? "Wait for the current endpoint request to finish."
                      : loading
                        ? "Wait for the endpoint list to finish refreshing."
                        : "Create a signed public endpoint and receive its one-time secret.",
                },
              ]
            : [refreshAction]
        }
      />
      {rows && rows.length > 0 ? <StatStrip cells={stats} /> : null}
      <div className="wh-list-controls wh-list-toolbar">
        <label className="sr-only" htmlFor={searchId}>
          Search inbound endpoints by label or slug
        </label>
        <input
          id={searchId}
          className="input"
          style={{ width: 280 }}
          placeholder="Search label or slug…"
          value={query}
          maxLength={200}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === "Escape" && query) {
              event.preventDefault();
              onQueryChange("");
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onQueryChange("")}
          >
            Clear search
          </button>
        ) : null}
        <span className="spacer" />
        {rows ? (
          <span className="wh-results-summary">
            {searchPending
              ? "Searching server…"
              : query
                ? `${filteredCount.toLocaleString()} matching endpoint${filteredCount === 1 ? "" : "s"} loaded from the server`
                : `${rows.length.toLocaleString()} loaded endpoint${rows.length === 1 ? "" : "s"}`}
          </span>
        ) : null}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {clipboardStatus}
      </div>
      {error ? (
        <div className="notice" role="alert">
          <span>
            {rows && rows.length > 0
              ? `Refresh failed: ${error} Previously loaded endpoint data remains visible and may be stale.`
              : `Couldn't load endpoints: ${error}`}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onLoad}
            aria-disabled={loading ? "true" : "false"}
          >
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
    </>
  );
}

function InboundEndpointList({
  filtered,
  loading,
  loadingMore,
  initialLoading,
  hasSourceRows,
  error,
  moreError,
  nextCursor,
  query,
  canAdmin,
  operationActive,
  secretRevealed,
  onCreate,
  onLoadMore,
  onOpen,
  onRotate,
  onEdit,
  onToggle,
  onCopy,
  mutatingId,
}: {
  filtered: InboundWebhookEndpoint[];
  loading: boolean;
  loadingMore: boolean;
  initialLoading: boolean;
  hasSourceRows: boolean;
  error: string | null;
  moreError: string | null;
  nextCursor: string | null;
  query: string;
  canAdmin: boolean;
  operationActive: boolean;
  secretRevealed: boolean;
  onCreate: () => void;
  onLoadMore: () => void;
  onOpen: (endpoint: InboundWebhookEndpoint) => void;
  onRotate: (endpoint: InboundWebhookEndpoint) => void;
  onEdit: (endpoint: InboundWebhookEndpoint) => void;
  onToggle: (endpoint: InboundWebhookEndpoint) => void;
  onCopy: (value: string, label: string) => void;
  mutatingId: string | null;
}): ReactElement {
  const statusId = useId();
  return (
    <section
      className="list wh-webhook-list wh-inbound-list"
      aria-label="Inbound webhook endpoints"
      aria-busy={loading || loadingMore ? "true" : "false"}
      aria-describedby={statusId}
    >
      <span id={statusId} className="sr-only" role="status">
        {loading
          ? "Loading inbound endpoints."
          : loadingMore
            ? "Loading more inbound endpoints."
            : error
              ? filtered.length > 0
                ? "Endpoint refresh failed. Previously loaded results remain visible."
                : "Inbound endpoints are unavailable."
              : `${filtered.length} inbound endpoint${filtered.length === 1 ? "" : "s"} shown.`}
      </span>
      <div className="list-header" style={{ gridTemplateColumns: COLS }}>
        <div>Label</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          Public URL
          <InlineHelp text="Send POST requests here with mandatory X-Postwave-Timestamp and stable X-Postwave-Event-Id headers plus the versioned v2 X-Postwave-Signature shown in the secret dialog. Missing, stale, or invalid authentication is rejected." />
        </div>
        <div>Events</div>
        <div>Created</div>
        <div></div>
      </div>
      {initialLoading || (loading && Boolean(query)) ? (
        <div style={{ padding: 4 }} aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="skel-row">
              <div className="skel skel-cell lg" />
              <div className="skel skel-cell" />
              <div className="skel skel-cell sm" />
              <div className="skel skel-cell sm" />
              <div className="skel skel-cell sm" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        error && !hasSourceRows ? (
          <div className="list-empty">
            <div className="empty-state">
              <div className="empty-state-icon">·</div>
              <h3>Couldn&apos;t load inbound endpoints</h3>
              <p>Use Retry above. No endpoint state is shown as current.</p>
            </div>
          </div>
        ) : query ? (
          <div className="list-empty">
            <div className="empty-state">
              <div className="empty-state-icon">·</div>
              <h3>No matches for &quot;{query}&quot;</h3>
              <p>Clear search to see all endpoints.</p>
            </div>
          </div>
        ) : (
          <>
            <HeroEmptyState
              tone="sand"
              eyebrow="Inbound"
              title="Listen for what your other tools are saying."
              subtitle="Persist verified events, then evaluate the sequence, tag, or automation triggers you explicitly configure."
              primaryCta={
                canAdmin
                  ? { label: "New endpoint", onClick: onCreate }
                  : undefined
              }
              imageSrc={HERO.inboundWebhooks}
              imageAlt="A brass receiver glowing teal"
            />
            <SectionHeader
              title="Connect a compatible sender"
              description="Direct senders and provider adapters must generate Moosewave's v2 length-framed HMAC over the timestamp, stable event ID, and exact request bytes."
              helpText="The URL Moosewave generates is unguessable per-tenant; combine with HMAC for verified delivery."
            />
            {canAdmin ? (
              <WebhookOnboardingGallery
                direction="inbound"
                onCreate={() => onCreate()}
              />
            ) : (
              <div className="notice" role="status">
                Ask a workspace admin to create the endpoint after you choose
                the upstream source and signing policy.
              </div>
            )}
          </>
        )
      ) : (
        <div role="list" aria-label="Inbound endpoint results">
          {filtered.map((endpoint) => (
            <InboundEndpointRow
              key={endpoint.id}
              endpoint={endpoint}
              canAdmin={canAdmin}
              rotateUnavailable={loading || operationActive || secretRevealed}
              mutationActive={mutatingId === endpoint.id}
              onOpen={() => onOpen(endpoint)}
              onRotate={() => onRotate(endpoint)}
              onEdit={() => onEdit(endpoint)}
              onToggle={() => onToggle(endpoint)}
              onCopy={onCopy}
            />
          ))}
        </div>
      )}
      {!initialLoading && hasSourceRows ? (
        <div
          className="wh-pagination-footer"
          aria-live="polite"
          aria-label="Inbound endpoint pagination"
        >
          <div className="wh-pagination-copy">
            {moreError ? (
              <span className="field-error" role="alert">
                Couldn&apos;t load more endpoints: {moreError}
              </span>
            ) : null}
            <span className="muted small">
              {nextCursor
                ? query
                  ? "More matching endpoint records are available from the server."
                  : "More endpoint records are available from the server."
                : "All available endpoint records are loaded."}
            </span>
          </div>
          {nextCursor ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={loading || loadingMore}
              aria-describedby={loading || loadingMore ? statusId : undefined}
              onClick={onLoadMore}
            >
              {loadingMore
                ? "Loading more endpoints…"
                : moreError
                  ? "Retry loading more"
                  : "Load more endpoints"}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function InboundEndpointRow({
  endpoint,
  canAdmin,
  rotateUnavailable,
  mutationActive,
  onOpen,
  onRotate,
  onEdit,
  onToggle,
  onCopy,
}: {
  endpoint: InboundWebhookEndpoint;
  canAdmin: boolean;
  rotateUnavailable: boolean;
  mutationActive: boolean;
  onOpen: () => void;
  onRotate: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onCopy: (value: string, label: string) => void;
}): ReactElement {
  const url = publicUrlFor(endpoint.slug);
  const label = endpoint.name || endpoint.slug;
  const createdAt = endpoint.createdAt;
  const operationReasonId = useId();
  const rotationReasonId = useId();
  return (
    <div
      className="list-row wh-endpoint-row"
      style={{ gridTemplateColumns: COLS }}
      role="listitem"
    >
      <button
        type="button"
        className="wh-row-primary"
        onClick={onOpen}
        aria-label={`Open inbound webhook ${label}`}
        data-label="Label"
        style={{ overflowWrap: "anywhere" }}
      >
        <span className="wh-row-titleline">
          <strong>{label}</strong>
          <span
            className={`badge ${endpoint.enabled !== false ? "success" : "warning"}`}
          >
            {endpoint.enabled !== false ? "Enabled" : "Disabled"}
          </span>
        </span>
        <span className="wh-row-secondary mono">/{endpoint.slug}</span>
      </button>
      <div className="wh-url-cell" data-label="Public URL">
        <code className="mono muted wh-full-identifier">{url}</code>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => onCopy(url, "URL")}
        >
          Copy
        </button>
      </div>
      <div
        className="muted tabular wh-row-meta"
        aria-label="Events received"
        data-label="Events"
      >
        Not reported
      </div>
      <div className="muted tabular wh-row-meta" data-label="Created">
        {createdAt ? (
          <time dateTime={createdAt}>{fmtDate(createdAt)}</time>
        ) : (
          "Not reported"
        )}
      </div>
      <div className="wh-row-actions-cell">
        <span id={operationReasonId} className="sr-only">
          Wait for the current endpoint update to finish.
        </span>
        <span id={rotationReasonId} className="sr-only">
          Finish the current list or shown-secret operation before rotating.
        </span>
        <div className="list-row-actions">
          {canAdmin ? (
            <>
              <button
                type="button"
                className="list-row-action"
                aria-label={`Edit inbound endpoint ${label}`}
                disabled={mutationActive}
                aria-describedby={
                  mutationActive ? operationReasonId : undefined
                }
                onClick={onEdit}
              >
                Edit
              </button>
              <button
                type="button"
                className="list-row-action"
                aria-label={`${endpoint.enabled !== false ? "Disable" : "Enable"} inbound endpoint ${label}`}
                disabled={mutationActive}
                aria-describedby={
                  mutationActive ? operationReasonId : undefined
                }
                onClick={onToggle}
              >
                {mutationActive
                  ? "Updating…"
                  : endpoint.enabled !== false
                    ? "Disable"
                    : "Enable"}
              </button>
              <button
                type="button"
                className="list-row-action"
                aria-label={`Rotate signing secret for ${label}`}
                disabled={rotateUnavailable || mutationActive}
                aria-describedby={
                  mutationActive
                    ? operationReasonId
                    : rotateUnavailable
                      ? rotationReasonId
                      : undefined
                }
                onClick={onRotate}
              >
                Rotate
              </button>
            </>
          ) : null}
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onOpen}>
          Open details
        </button>
      </div>
    </div>
  );
}

function useInboundEndpointData(query: string): {
  rows: InboundWebhookEndpoint[] | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  moreError: string | null;
  nextCursor: string | null;
  clipboardStatus: string | null;
  activeRef: MutableRefObject<boolean>;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  copy: (value: string, label: string) => Promise<void>;
} {
  const normalizedQuery = query.trim();
  const [rows, setRows] = useState<InboundWebhookEndpoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState<string | null>(null);
  const activeRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const loadFlightRef = useRef<Promise<void> | null>(null);
  const loadMoreFlightRef = useRef<Promise<void> | null>(null);
  const copyFlightRef = useRef<Promise<void> | null>(null);
  const loadedIdsRef = useRef<Set<string>>(new Set());
  const loadedCursorsRef = useRef<Set<string>>(new Set());

  const load = useCallback((): Promise<void> => {
    if (loadFlightRef.current) return loadFlightRef.current;
    const requestId = ++loadSequenceRef.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(null);
    setNextCursor(null);
    loadMoreFlightRef.current = null;
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const response = await api.listInboundWebhooks({
          limit: ENDPOINT_PAGE_LIMIT,
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
        });
        if (!activeRef.current || requestId !== loadSequenceRef.current) return;
        if (response.error) {
          setError(response.error.message);
        } else {
          const ids = new Set<string>();
          for (const endpoint of response.data.items) {
            if (ids.has(endpoint.id)) {
              setError(
                "Moosewave repeated an inbound endpoint inside the first page. The last verified rows remain unchanged and no duplicate was accepted.",
              );
              return;
            }
            ids.add(endpoint.id);
          }
          const next = response.data.next_cursor || null;
          loadedIdsRef.current = ids;
          loadedCursorsRef.current = new Set(next ? [next] : []);
          setRows(response.data.items);
          setNextCursor(next);
        }
      } catch (caught) {
        if (!activeRef.current || requestId !== loadSequenceRef.current) return;
        setError(
          lifecycleOperationError(
            caught,
            "The inbound endpoints request failed. Check your connection and try again.",
          ),
        );
      } finally {
        if (activeRef.current && requestId === loadSequenceRef.current) {
          setLoading(false);
        }
        if (requestId === loadSequenceRef.current) loadFlightRef.current = null;
      }
    })();
    loadFlightRef.current = request;
    return request;
  }, [normalizedQuery]);

  const loadMore = useCallback((): Promise<void> => {
    if (loadMoreFlightRef.current) return loadMoreFlightRef.current;
    if (!nextCursor || loading) return Promise.resolve();
    const cursor = nextCursor;
    const requestId = loadSequenceRef.current;
    setLoadingMore(true);
    setMoreError(null);
    const request = (async (): Promise<void> => {
      try {
        const response = await api.listInboundWebhooks({
          cursor,
          limit: ENDPOINT_PAGE_LIMIT,
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
        });
        if (!activeRef.current || requestId !== loadSequenceRef.current) return;
        if (response.error) {
          setMoreError(response.error.message);
          return;
        }
        const pageIds = new Set<string>();
        const duplicate = response.data.items.some((endpoint) => {
          if (
            pageIds.has(endpoint.id) ||
            loadedIdsRef.current.has(endpoint.id)
          ) {
            return true;
          }
          pageIds.add(endpoint.id);
          return false;
        });
        if (duplicate) {
          setNextCursor(null);
          setMoreError(
            "Moosewave repeated an inbound endpoint across cursor pages. Pagination stopped before any duplicate or partial page was accepted; loaded rows remain visible but history completeness is unknown.",
          );
          return;
        }
        const next = response.data.next_cursor || null;
        if (next && (next === cursor || loadedCursorsRef.current.has(next))) {
          setNextCursor(null);
          setMoreError(
            "Moosewave repeated an inbound-endpoint pagination cursor. Pagination stopped before another request could loop; loaded rows remain visible but completeness is unknown.",
          );
          return;
        }
        setRows((current) => [...(current ?? []), ...response.data.items]);
        for (const id of pageIds) loadedIdsRef.current.add(id);
        if (next) loadedCursorsRef.current.add(next);
        setNextCursor(next);
      } catch (caught) {
        if (!activeRef.current || requestId !== loadSequenceRef.current) return;
        setMoreError(
          lifecycleOperationError(
            caught,
            "Older endpoint records couldn't be loaded. Check your connection and retry.",
          ),
        );
      } finally {
        if (activeRef.current && requestId === loadSequenceRef.current) {
          setLoadingMore(false);
        }
        if (requestId === loadSequenceRef.current) {
          loadMoreFlightRef.current = null;
        }
      }
    })();
    loadMoreFlightRef.current = request;
    return request;
  }, [loading, nextCursor, normalizedQuery]);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
      loadSequenceRef.current += 1;
      loadFlightRef.current = null;
      loadMoreFlightRef.current = null;
      copyFlightRef.current = null;
      loadedIdsRef.current = new Set();
      loadedCursorsRef.current = new Set();
    };
  }, [load]);

  const copy = (value: string, label: string): Promise<void> => {
    if (copyFlightRef.current) {
      setClipboardStatus(
        `A clipboard write is already in progress. Try copying ${label} again when it finishes.`,
      );
      return copyFlightRef.current;
    }
    const request = (async (): Promise<void> => {
      try {
        const secret = label.toLowerCase().includes("secret");
        const result = await writeClipboardText(value, {
          contentClass: secret ? "secret" : "public",
          label,
          clearIfUnchangedAfterMs: secret ? 60_000 : undefined,
        });
        if (!activeRef.current) return;
        if (result.ok) {
          const detail = clipboardSuccessDetail(result);
          setClipboardStatus(`${label} copied. ${detail}`);
          toast.success({ message: `${label} copied`, detail });
        } else {
          setClipboardStatus(`${label} wasn't copied. ${result.message}`);
          toast.error(result.message);
        }
      } catch (error) {
        if (!activeRef.current) return;
        const message = lifecycleOperationError(
          error,
          `${label} wasn't copied. Focus Moosewave and try again, or copy it manually.`,
        );
        setClipboardStatus(message);
        toast.error(message);
      }
    })().finally(() => {
      copyFlightRef.current = null;
    });
    copyFlightRef.current = request;
    return request;
  };

  return {
    rows,
    loading,
    loadingMore,
    error,
    moreError,
    nextCursor,
    clipboardStatus,
    activeRef,
    load,
    loadMore,
    copy,
  };
}

function InboundAdminRequired(): ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="Webhooks"
        title="Inbound webhooks"
        subtitle="Inbound endpoints expose signing configuration, retained payloads, replay controls, and trigger actions."
      />
      <Notice tone="danger" announcement="assertive">
        Workspace admin access is required to view or manage inbound webhook
        endpoints. This surface does not expose a partial read-only mode.
      </Notice>
    </>
  );
}

export function InboundWebhooks(): ReactElement {
  const canAdmin = useCanAdmin();
  return canAdmin ? <InboundWebhooksAdmin /> : <InboundAdminRequired />;
}

interface InboundAdminViewProps {
  page: {
    rows: InboundWebhookEndpoint[] | null;
    filtered: InboundWebhookEndpoint[];
    stats: StatCell[];
    loading: boolean;
    loadingMore: boolean;
    error: string | null;
    moreError: string | null;
    nextCursor: string | null;
    clipboardStatus: string | null;
    query: string;
    debouncedQuery: string;
    operationActive: boolean;
    mutatingId: string | null;
    secretRevealed: boolean;
  };
  dialogs: {
    selected: InboundWebhookEndpoint | null;
    editTarget: InboundWebhookEndpoint | null;
    createOpen: boolean;
    draftLabel: string;
    submitError: string | null;
    submitting: boolean;
    rotateTarget: InboundWebhookEndpoint | null;
    rotateError: string | null;
    rotating: boolean;
    toggleTarget: InboundWebhookEndpoint | null;
    toggleError: string | null;
    revealed: InboundSecretReveal | null;
    confirmSecretClose: boolean;
    confirmCreateClose: boolean;
  };
  actions: {
    load: () => void;
    loadMore: () => void;
    setQuery: (value: string) => void;
    openCreate: () => void;
    openEndpoint: (endpoint: InboundWebhookEndpoint | null) => void;
    openRotate: (endpoint: InboundWebhookEndpoint) => void;
    openEdit: (endpoint: InboundWebhookEndpoint) => void;
    openToggle: (endpoint: InboundWebhookEndpoint) => void;
    copy: (value: string, label: string) => void;
    closeEdit: () => void;
    saveEdit: (updated: InboundWebhookEndpoint) => void;
    deleteEndpoint: () => void;
    setDraftLabel: (value: string) => void;
    requestCreateClose: () => void;
    submitCreate: () => void;
    closeRotate: () => void;
    submitRotate: () => void;
    submitToggle: () => void;
    closeToggle: () => void;
    requestSecretClose: () => void;
    keepSecretOpen: () => void;
    resolveSecret: () => void;
    discardCreateDraft: () => void;
    keepCreateDraft: () => void;
  };
}

function InboundWebhooksAdminView({
  page,
  dialogs,
  actions,
}: InboundAdminViewProps): ReactElement {
  return (
    <>
      <InboundPageChrome
        rows={page.rows}
        filteredCount={page.filtered.length}
        stats={page.stats}
        canAdmin
        loading={page.loading}
        revealed={page.secretRevealed}
        operationActive={page.operationActive}
        query={page.query}
        searchPending={page.query.trim() !== page.debouncedQuery}
        error={page.error}
        clipboardStatus={page.clipboardStatus}
        onLoad={actions.load}
        onCreate={actions.openCreate}
        onQueryChange={actions.setQuery}
      />
      <InboundEndpointList
        filtered={page.filtered}
        loading={page.loading}
        loadingMore={page.loadingMore}
        initialLoading={page.loading && page.rows === null}
        hasSourceRows={(page.rows?.length ?? 0) > 0}
        error={page.error}
        moreError={page.moreError}
        nextCursor={page.nextCursor}
        query={page.debouncedQuery}
        canAdmin
        operationActive={page.operationActive}
        secretRevealed={page.secretRevealed}
        onCreate={actions.openCreate}
        onLoadMore={actions.loadMore}
        onOpen={actions.openEndpoint}
        onRotate={actions.openRotate}
        onEdit={actions.openEdit}
        onToggle={actions.openToggle}
        onCopy={actions.copy}
        mutatingId={page.mutatingId}
      />
      <InboundEndpointEditDialog
        endpoint={dialogs.editTarget}
        onClose={actions.closeEdit}
        onSaved={actions.saveEdit}
      />
      {dialogs.selected ? (
        <InboundWebhookDetailSlideover
          endpoint={dialogs.selected}
          onClose={() => actions.openEndpoint(null)}
          onRotate={actions.openRotate}
          onDeleted={actions.deleteEndpoint}
        />
      ) : null}
      <InboundEndpointCreateModal
        open={dialogs.createOpen}
        label={dialogs.draftLabel}
        error={dialogs.submitError}
        busy={dialogs.submitting || page.operationActive}
        onLabelChange={actions.setDraftLabel}
        onClose={actions.requestCreateClose}
        onSubmit={actions.submitCreate}
      />
      <InboundEndpointRotateModal
        target={dialogs.rotateTarget}
        error={dialogs.rotateError}
        busy={dialogs.rotating || page.operationActive}
        onClose={actions.closeRotate}
        onSubmit={actions.submitRotate}
      />
      <ConfirmModal
        open={dialogs.toggleTarget !== null}
        title={
          dialogs.toggleTarget?.enabled === false
            ? "Enable this endpoint?"
            : "Disable this endpoint?"
        }
        description={
          dialogs.toggleTarget?.enabled === false
            ? "New correctly signed requests will be accepted again. Existing retained events and the signing secret are unchanged."
            : "New requests will be rejected until you enable it again. Existing retained events, triggers, URL, and signing secret are preserved."
        }
        confirmLabel={
          page.mutatingId
            ? "Updating…"
            : dialogs.toggleTarget?.enabled === false
              ? "Enable endpoint"
              : "Disable endpoint"
        }
        cancelLabel="Cancel"
        danger={dialogs.toggleTarget?.enabled !== false}
        busy={page.mutatingId !== null}
        onConfirm={actions.submitToggle}
        onClose={actions.closeToggle}
      >
        {dialogs.toggleError ? (
          <p className="field-error" role="alert">
            {dialogs.toggleError}
          </p>
        ) : null}
      </ConfirmModal>
      <InboundSecretRevealModal
        revealed={dialogs.revealed}
        confirmClose={dialogs.confirmSecretClose}
        onRequestClose={actions.requestSecretClose}
        onKeepOpen={actions.keepSecretOpen}
        onResolve={actions.resolveSecret}
        onCopy={actions.copy}
      />
      <ConfirmModal
        open={dialogs.confirmCreateClose}
        title="Discard inbound endpoint draft?"
        description="The unsaved endpoint label will be cleared. No endpoint has been created yet."
        confirmLabel="Discard draft"
        cancelLabel="Keep editing"
        danger
        onConfirm={actions.discardCreateDraft}
        onClose={actions.keepCreateDraft}
      />
    </>
  );
}

function buildInboundOpenActions({
  revealed,
  operationActive,
  loading,
  mutatingId,
  setDraftLabel,
  setSubmitError,
  setCreateOpen,
  setRotateError,
  setRotateTarget,
  setEditTarget,
  setToggleError,
  setToggleTarget,
}: {
  revealed: InboundSecretReveal | null;
  operationActive: boolean;
  loading: boolean;
  mutatingId: string | null;
  setDraftLabel: (value: string) => void;
  setSubmitError: (value: string | null) => void;
  setCreateOpen: (value: boolean) => void;
  setRotateError: (value: string | null) => void;
  setRotateTarget: (value: InboundWebhookEndpoint | null) => void;
  setEditTarget: (value: InboundWebhookEndpoint | null) => void;
  setToggleError: (value: string | null) => void;
  setToggleTarget: (value: InboundWebhookEndpoint | null) => void;
}): {
  openCreate: () => void;
  openRotate: (endpoint: InboundWebhookEndpoint) => void;
  openEdit: (endpoint: InboundWebhookEndpoint) => void;
  openToggle: (endpoint: InboundWebhookEndpoint) => void;
} {
  const secretOrRequestBusy = (): boolean => {
    if (revealed) {
      toast.info("Store or explicitly discard the shown secret first.");
      return true;
    }
    if (operationActive) {
      toast.info("Wait for the current endpoint request to finish.");
      return true;
    }
    if (loading) {
      toast.info("Wait for the endpoint list to finish refreshing.");
      return true;
    }
    return false;
  };

  return {
    openCreate: () => {
      if (secretOrRequestBusy()) return;
      setDraftLabel("");
      setSubmitError(null);
      setCreateOpen(true);
    },
    openRotate: (endpoint) => {
      if (secretOrRequestBusy()) return;
      setRotateError(null);
      setRotateTarget(endpoint);
    },
    openEdit: (endpoint) => {
      if (secretOrRequestBusy() || mutatingId) {
        if (mutatingId) {
          toast.info("Finish the current endpoint operation before editing.");
        }
        return;
      }
      setEditTarget(endpoint);
    },
    openToggle: (endpoint) => {
      if (secretOrRequestBusy() || mutatingId) {
        if (mutatingId) {
          toast.info("Finish the current endpoint operation first.");
        }
        return;
      }
      setToggleError(null);
      setToggleTarget(endpoint);
    },
  };
}

function useInboundEndpointToggle({
  activeRef,
  load,
  onUpdated,
}: {
  activeRef: MutableRefObject<boolean>;
  load: () => Promise<void>;
  onUpdated: (endpoint: InboundWebhookEndpoint) => void;
}): {
  toggleTarget: InboundWebhookEndpoint | null;
  setToggleTarget: Dispatch<SetStateAction<InboundWebhookEndpoint | null>>;
  mutatingId: string | null;
  toggleError: string | null;
  setToggleError: Dispatch<SetStateAction<string | null>>;
  submitToggle: () => Promise<void>;
} {
  const [toggleTarget, setToggleTarget] =
    useState<InboundWebhookEndpoint | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const submitToggle = async (): Promise<void> => {
    const target = toggleTarget;
    if (!target || mutatingId) return;
    const enabled = target.enabled === false;
    setMutatingId(target.id);
    setToggleError(null);
    try {
      const result = await updateInboundWebhookEndpoint(target.id, { enabled });
      if (result.error) {
        setToggleError(result.error.message);
        return;
      }
      setToggleTarget(null);
      onUpdated(result.data);
      toast.success(enabled ? "Endpoint enabled" : "Endpoint disabled");
      await load();
    } catch (error) {
      setToggleError(
        lifecycleOperationError(
          error,
          enabled
            ? "The endpoint couldn't be enabled."
            : "The endpoint couldn't be disabled.",
        ),
      );
    } finally {
      if (activeRef.current) setMutatingId(null);
    }
  };

  return {
    toggleTarget,
    setToggleTarget,
    mutatingId,
    toggleError,
    setToggleError,
    submitToggle,
  };
}

function buildInboundAdminViewActions({
  load,
  loadMore,
  setQuery,
  openCreate,
  setSelected,
  openRotate,
  openEdit,
  openToggle,
  copy,
  setEditTarget,
  setDraftLabel,
  requestCreateClose,
  submitCreate,
  rotateIdentityRef,
  setRotateTarget,
  submitRotate,
  submitToggle,
  mutatingId,
  setToggleTarget,
  setToggleError,
  setConfirmSecretClose,
  clearRevealedSecret,
  discardCreateDraft,
  setConfirmCreateClose,
}: {
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  setQuery: Dispatch<SetStateAction<string>>;
  openCreate: () => void;
  setSelected: Dispatch<SetStateAction<InboundWebhookEndpoint | null>>;
  openRotate: (endpoint: InboundWebhookEndpoint) => void;
  openEdit: (endpoint: InboundWebhookEndpoint) => void;
  openToggle: (endpoint: InboundWebhookEndpoint) => void;
  copy: (value: string, label: string) => Promise<void>;
  setEditTarget: Dispatch<SetStateAction<InboundWebhookEndpoint | null>>;
  setDraftLabel: Dispatch<SetStateAction<string>>;
  requestCreateClose: () => void;
  submitCreate: () => Promise<void>;
  rotateIdentityRef: MutableRefObject<{
    endpointId: string;
    key: string;
  } | null>;
  setRotateTarget: Dispatch<SetStateAction<InboundWebhookEndpoint | null>>;
  submitRotate: () => Promise<void>;
  submitToggle: () => Promise<void>;
  mutatingId: string | null;
  setToggleTarget: Dispatch<SetStateAction<InboundWebhookEndpoint | null>>;
  setToggleError: Dispatch<SetStateAction<string | null>>;
  setConfirmSecretClose: Dispatch<SetStateAction<boolean>>;
  clearRevealedSecret: () => void;
  discardCreateDraft: () => void;
  setConfirmCreateClose: Dispatch<SetStateAction<boolean>>;
}): InboundAdminViewProps["actions"] {
  return {
    load: () => void load(),
    loadMore: () => void loadMore(),
    setQuery,
    openCreate,
    openEndpoint: setSelected,
    openRotate,
    openEdit,
    openToggle,
    copy: (value, label) => void copy(value, label),
    closeEdit: () => setEditTarget(null),
    saveEdit: (updated) => {
      setEditTarget(null);
      setSelected((current) =>
        current?.id === updated.id ? updated : current,
      );
      void load();
    },
    deleteEndpoint: () => {
      setSelected(null);
      void load();
    },
    setDraftLabel,
    requestCreateClose,
    submitCreate: () => void submitCreate(),
    closeRotate: () => {
      rotateIdentityRef.current = null;
      setRotateTarget(null);
    },
    submitRotate: () => void submitRotate(),
    submitToggle: () => void submitToggle(),
    closeToggle: () => {
      if (!mutatingId) {
        setToggleTarget(null);
        setToggleError(null);
      }
    },
    requestSecretClose: () => setConfirmSecretClose(true),
    keepSecretOpen: () => setConfirmSecretClose(false),
    resolveSecret: clearRevealedSecret,
    discardCreateDraft,
    keepCreateDraft: () => setConfirmCreateClose(false),
  };
}

function InboundWebhooksAdmin(): ReactElement {
  // Every authenticated inbound-webhook route is ScopeAdmin on the API.
  // Keeping the data hook inside this component prevents a non-admin render
  // from issuing a request that can only return 403.
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedInboundQuery(query);
  const {
    rows,
    loading,
    loadingMore,
    error: err,
    moreError,
    nextCursor,
    clipboardStatus,
    activeRef,
    load,
    loadMore,
    copy,
  } = useInboundEndpointData(debouncedQuery);

  const [selected, setSelected] = useState<InboundWebhookEndpoint | null>(null);
  const [editTarget, setEditTarget] = useState<InboundWebhookEndpoint | null>(
    null,
  );
  const {
    toggleTarget,
    setToggleTarget,
    mutatingId,
    toggleError,
    setToggleError,
    submitToggle,
  } = useInboundEndpointToggle({
    activeRef,
    load,
    onUpdated: (updated) => {
      setSelected((current) =>
        current?.id === updated.id ? updated : current,
      );
    },
  });

  // Create flow: modal asks for label → on success swap to "shown once" view.
  const [createOpen, setCreateOpen] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [confirmCreateClose, setConfirmCreateClose] = useState(false);
  const [revealed, setRevealed] = useState<InboundSecretReveal | null>(null);
  const [confirmSecretClose, setConfirmSecretClose] = useState(false);
  const createIdentityRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const rotateIdentityRef = useRef<{
    endpointId: string;
    key: string;
  } | null>(null);

  // Rotate flow: confirmation modal → call /rotate → reuse `revealed` view.
  const [rotateTarget, setRotateTarget] =
    useState<InboundWebhookEndpoint | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotateErr, setRotateErr] = useState<string | null>(null);
  const secretLifecycle = useShownOnceSecretLifecycle(
    "inbound-webhook-signing-secret",
    "Inbound webhook signing secret",
    revealed !== null,
  );
  const operation = useSingleFlightOperation({
    ownerId: "inbound-webhook-secret",
    label: "Inbound webhook secret operation",
    detail: "Wait for the inbound webhook request to finish before leaving.",
  });
  const discardCreateDraft = useCallback((): void => {
    createIdentityRef.current = null;
    setDraftLabel("");
    setSubmitErr(null);
    setCreateOpen(false);
    setConfirmCreateClose(false);
  }, []);
  const createDirty = createOpen && draftLabel.trim() !== "";
  useDiscardOnlyDraftLifecycle({
    ownerId: "inbound-webhook-create",
    label: "Inbound webhook endpoint draft",
    dirty: createDirty,
    operationRef: operation.promiseRef,
    discard: discardCreateDraft,
    detail: "This inbound endpoint label has not been submitted.",
  });

  const requestCreateClose = (): void => {
    if (submitting || operation.active) return;
    if (createDirty) {
      setConfirmCreateClose(true);
      return;
    }
    discardCreateDraft();
  };

  const clearRevealedSecret = (): void => {
    secretLifecycle.resolve();
    setConfirmSecretClose(false);
    setRevealed(null);
  };

  useEffect(() => {
    if (!rows) return;
    setSelected((current) =>
      current
        ? (rows.find((endpoint) => endpoint.id === current.id) ?? null)
        : null,
    );
  }, [rows]);

  const filtered = useMemo(
    () => filterInboundEndpoints(rows, debouncedQuery),
    [debouncedQuery, rows],
  );

  const stats = useMemo(() => buildInboundStats(rows), [rows]);

  const { openCreate, openRotate, openEdit, openToggle } =
    buildInboundOpenActions({
      revealed,
      operationActive: operation.active,
      loading,
      mutatingId,
      setDraftLabel,
      setSubmitError: setSubmitErr,
      setCreateOpen,
      setRotateError: setRotateErr,
      setRotateTarget,
      setEditTarget,
      setToggleError,
      setToggleTarget,
    });

  const submitCreate = async (): Promise<void> => {
    const label = draftLabel.trim();
    if (!label) {
      setSubmitErr("Enter a label so you can recognise this endpoint later.");
      return;
    }
    setSubmitErr(null);
    const fingerprint = JSON.stringify({ name: label });
    if (createIdentityRef.current?.fingerprint !== fingerprint) {
      createIdentityRef.current = { fingerprint, key: newUUIDv7() };
    }
    const idempotencyKey = createIdentityRef.current.key;
    const request = operation.run(async () => {
      const response = await api.createInboundWebhook(
        { label },
        { idempotencyKey },
      );
      if (!response.error && activeRef.current) {
        secretLifecycle.activate();
        setRevealed({ ...response.data, kind: "create" });
      }
      return response;
    });
    if (!request) return;
    setSubmitting(true);
    let res: Awaited<ReturnType<typeof api.createInboundWebhook>>;
    try {
      res = await request;
    } catch (error) {
      if (activeRef.current) {
        setSubmitErr(
          lifecycleOperationError(
            error,
            "The inbound endpoint couldn't be created.",
          ),
        );
      }
      return;
    } finally {
      if (activeRef.current) setSubmitting(false);
    }
    if (!activeRef.current) return;
    if (res.error) {
      setSubmitErr(
        res.error.kind === "parse"
          ? `${res.error.message} The endpoint may have been created, but no usable one-time secret was returned. Refresh the list, then rotate any unexpected endpoint before using it.`
          : res.error.message,
      );
      if (res.error.kind === "parse") void load();
      return;
    }
    discardCreateDraft();
    toast.success("Endpoint created");
    void load();
  };

  const submitRotate = async (): Promise<void> => {
    if (!rotateTarget) return;
    const target = rotateTarget;
    if (rotateIdentityRef.current?.endpointId !== target.id) {
      rotateIdentityRef.current = {
        endpointId: target.id,
        key: newUUIDv7(),
      };
    }
    const idempotencyKey = rotateIdentityRef.current.key;
    const request = operation.run(async () => {
      const response = await api.rotateInboundWebhook(target.id, {
        idempotencyKey,
      });
      if (!response.error && activeRef.current) {
        secretLifecycle.activate();
        setRevealed({ ...response.data, kind: "rotate" });
      }
      return response;
    });
    if (!request) return;
    setRotating(true);
    setRotateErr(null);
    let res: Awaited<ReturnType<typeof api.rotateInboundWebhook>>;
    try {
      res = await request;
    } catch (error) {
      if (activeRef.current) {
        setRotateErr(
          lifecycleOperationError(
            error,
            "The signing secret couldn't be rotated.",
          ),
        );
      }
      return;
    } finally {
      if (activeRef.current) setRotating(false);
    }
    if (!activeRef.current) return;
    if (res.error) {
      setRotateErr(
        res.error.kind === "parse"
          ? `${res.error.message} The server may have rotated the secret without returning a usable one-time value. Rotate again before sending more events.`
          : res.error.message,
      );
      if (res.error.kind === "parse") void load();
      return;
    }
    rotateIdentityRef.current = null;
    setRotateTarget((current) => (current?.id === target.id ? null : current));
    toast.success("Secret rotated");
    void load();
  };

  const actions = buildInboundAdminViewActions({
    load,
    loadMore,
    setQuery,
    openCreate,
    setSelected,
    openRotate,
    openEdit,
    openToggle,
    copy,
    setEditTarget,
    setDraftLabel,
    requestCreateClose,
    submitCreate,
    rotateIdentityRef,
    setRotateTarget,
    submitRotate,
    submitToggle,
    mutatingId,
    setToggleTarget,
    setToggleError,
    setConfirmSecretClose,
    clearRevealedSecret,
    discardCreateDraft,
    setConfirmCreateClose,
  });

  return (
    <InboundWebhooksAdminView
      page={{
        rows,
        filtered,
        stats,
        loading,
        loadingMore,
        error: err,
        moreError,
        nextCursor,
        clipboardStatus,
        query,
        debouncedQuery,
        operationActive: operation.active,
        mutatingId,
        secretRevealed: revealed !== null,
      }}
      dialogs={{
        selected,
        editTarget,
        createOpen,
        draftLabel,
        submitError: submitErr,
        submitting,
        rotateTarget,
        rotateError: rotateErr,
        rotating,
        toggleTarget,
        toggleError,
        revealed,
        confirmSecretClose,
        confirmCreateClose,
      }}
      actions={actions}
    />
  );
}

function InboundSecretRevealModal({
  revealed,
  confirmClose,
  onRequestClose,
  onKeepOpen,
  onResolve,
  onCopy,
}: {
  revealed: InboundSecretReveal | null;
  confirmClose: boolean;
  onRequestClose: () => void;
  onKeepOpen: () => void;
  onResolve: () => void;
  onCopy: (value: string, label: string) => void;
}): ReactElement {
  const [stored, setStored] = useState(false);
  const storedHelpId = useId();
  useEffect(() => {
    setStored(false);
  }, [revealed?.secret]);
  const publicUrl = revealed ? publicUrlFor(revealed.endpoint.slug) : "";
  return (
    <>
      <Modal
        open={revealed !== null}
        onClose={() => (stored ? onResolve() : onRequestClose())}
        title={
          revealed?.kind === "rotate"
            ? "New signing secret"
            : "Endpoint created"
        }
        description="Copy the signing secret now. It is encrypted at rest and write-only in operator surfaces — you won't see it again."
      >
        {revealed ? (
          <>
            <div className="field">
              <div
                className="label"
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                Public URL
                <InlineHelp text="Send POST requests here with mandatory X-Postwave-Timestamp and X-Postwave-Event-Id headers plus a valid v2 X-Postwave-Signature. Missing or invalid authentication is rejected." />
              </div>
              <div className="copy-row">
                <div
                  className="copy-text"
                  role="textbox"
                  tabIndex={0}
                  aria-readonly="true"
                  aria-label="Inbound webhook public URL"
                >
                  {publicUrl}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onCopy(publicUrl, "URL")}
                >
                  Copy URL
                </button>
              </div>
            </div>
            <div className="field">
              <div
                className="label"
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                Signing secret
                <InlineHelp
                  text={
                    "HMAC-SHA256 the v2 length-framed timestamp, stable event ID, and exact raw body with this one-time secret. Prefix the hex digest with v2= in X-Postwave-Signature."
                  }
                />
              </div>
              <div className="copy-row">
                <div
                  className="copy-text"
                  role="textbox"
                  tabIndex={0}
                  aria-readonly="true"
                  aria-label="One-time inbound webhook signing secret"
                >
                  {revealed.secret}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => onCopy(revealed.secret, "Secret")}
                >
                  Copy secret
                </button>
              </div>
            </div>
            <div className="notice wh-inbound-signing-contract">
              <strong>Authenticated v2 request contract</strong>
              <span>
                Send mandatory <code>X-Postwave-Timestamp</code> and stable{" "}
                <code>X-Postwave-Event-Id</code> headers. Set{" "}
                <code>X-Postwave-Signature</code> to{" "}
                <code>v2=&lt;hex_hmac_sha256&gt;</code> computed over:
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
                Use the exact raw request bytes and reject timestamps outside
                the ±5-minute replay window. Legacy raw-hex v1 is an explicit
                compatibility opt-in only, not the default for new senders.
              </span>
            </div>
            <label
              style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
            >
              <input
                type="checkbox"
                checked={stored}
                onChange={(event) => setStored(event.target.checked)}
                style={{ width: "auto", marginTop: 2 }}
              />
              <span>
                I stored the signing secret in an approved secret manager and
                understand it cannot be shown again.
              </span>
            </label>
            {!stored ? (
              <p id={storedHelpId} className="field-help" style={{ margin: 0 }}>
                Confirm secure storage before dismissing this one-time secret.
              </p>
            ) : null}
          </>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (stored) onResolve();
            }}
            aria-disabled={stored ? "false" : "true"}
            aria-describedby={!stored ? storedHelpId : undefined}
          >
            I&apos;ve stored it securely
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={confirmClose}
        title="Close without storing this secret?"
        description="This signing secret is shown once and cannot be recovered. You will need to rotate it again."
        confirmLabel="Discard shown secret"
        cancelLabel="Keep secret open"
        danger
        onConfirm={onResolve}
        onClose={onKeepOpen}
      />
    </>
  );
}

function InboundEndpointCreateModal({
  open,
  label,
  error,
  busy,
  onLabelChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  label: string;
  error: string | null;
  busy: boolean;
  onLabelChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}): ReactElement {
  const labelHelpId = useId();
  const errorId = useId();
  const missingLabel = label.trim().length === 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      title="New inbound endpoint"
      description="A label helps you recognise this endpoint later. We'll generate the URL and signing secret for you."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !missingLabel) onSubmit();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="iwh-label">
            Label
          </label>
          <input
            id="iwh-label"
            type="text"
            className="input"
            placeholder="e.g. Stripe checkout events"
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
            maxLength={120}
            autoComplete="off"
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? errorId : labelHelpId}
          />
          {!error ? (
            <div id={labelHelpId} className="field-help">
              {missingLabel
                ? "Enter a label before creating the endpoint."
                : "Use the upstream system or purpose, for example “Stripe checkout”."}
            </div>
          ) : null}
        </div>
        {error ? (
          <div id={errorId} className="field-error" role="alert">
            {error}
          </div>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy}
            aria-disabled={busy || missingLabel ? "true" : "false"}
            aria-describedby={
              error ? errorId : missingLabel ? labelHelpId : undefined
            }
          >
            {busy ? "Creating…" : "Create endpoint"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function InboundEndpointRotateModal({
  target,
  error,
  busy,
  onClose,
  onSubmit,
}: {
  target: InboundWebhookEndpoint | null;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
}): ReactElement {
  return (
    <Modal
      open={target !== null}
      onClose={() => (busy ? undefined : onClose())}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      title="Rotate signing secret?"
      description="The new secret becomes primary immediately. The previous secret remains accepted for a bounded 24-hour grace period; update the sender before it expires, after which the old secret is rejected."
    >
      {target ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Endpoint: <span className="mono">{target.name || target.slug}</span>
        </div>
      ) : null}
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSubmit}
          disabled={busy}
        >
          {busy ? "Rotating…" : "Rotate secret"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
