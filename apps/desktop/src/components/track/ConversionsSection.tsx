/**
 * Track conversion feed and tracking-key console.
 *
 * This surface owns cursor paging, creation-result credentials, permission-aware
 * key management, and the public-ingest integration example.
 */

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Bounded JSON evidence is a labelled overflow region that keyboard users must be able to pan. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { FieldError, FormField } from "../FormField";
import { InlineHelp } from "../InlineHelp";
import { Modal, ModalFooter } from "../Modal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { useShownOnceSecretLifecycle } from "../../hooks/useShownOnceSecretLifecycle";
import {
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type ConversionListCursor,
  type ConversionRow,
  type ConversionTrackingKey,
  conversionsApi,
  getApiUrl,
} from "../../lib/api-client";
import { clipboardAnnouncement, writeClipboardText } from "../../lib/clipboard";
import { isRemotePermissionError } from "../../lib/remote-resource";
import { useCanAdmin } from "../../lib/store";
import {
  CONVERSION_TRACKING_KEY_LABEL_MAX_CODE_POINTS,
  conversionCurlSnippet,
  conversionTrackingKeyLabelError,
  fmtConversionAmount,
  keyPrefixDisplay,
  nextConversionsCursor,
  trackingKeyState,
} from "../../pages/track-conversions";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import {
  boundedJsonPreview,
  isConfirmedRevocation,
  isUncertainMutationFailure,
  parseConversionKeys,
  parseConversionRows,
  parseCreatedSecret,
  safeAbsoluteTime,
  safeTrackFailure,
} from "./track-maturity";
import { ConversionIngestSecretsPanel } from "./ConversionIngestSecretsPanel";

function fmtTime(value: string): string {
  return safeAbsoluteTime(value);
}

const CONVERSION_FEED_ACCESS_MESSAGE =
  "Raw conversion feed access requires both read:reports and read:subscribers. Tracking-key administration is separate and remains available to admins.";

function EventTime({
  value,
}: {
  value: string | null | undefined;
}): ReactElement {
  if (!value) return <span className="muted">Not recorded</span>;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return <span className="muted">Invalid timestamp</span>;
  }
  return (
    <time dateTime={value} className="tabular">
      {fmtTime(value)}
    </time>
  );
}

function conversionAttributionLabel(
  value: ConversionRow["attributed_via"],
): string {
  switch (value) {
    case "explicit":
      return "Explicit campaign";
    case "last_touch":
      return "Last-touch · heuristic";
    case "none":
      return "Unattributed";
    case "code_redemption":
      return "Code assignment linkage";
    case "campaign_vanity_path":
      return "Shared campaign path";
    default:
      return "Unclassified legacy";
  }
}

/* ====================================================================
 * Conversions (#32)
 * ==================================================================== */

interface RevealedConversionKey {
  plaintext: string;
  label: string;
}

function CopyButton({
  text,
  label,
  secret = false,
}: {
  text: string;
  label: string;
  secret?: boolean;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const operationRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const statusId = useId();
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current = null;
    };
  }, []);
  const copy = (): Promise<void> => {
    if (operationRef.current) return operationRef.current;
    setBusy(true);
    setStatus(null);
    const request = (async (): Promise<void> => {
      try {
        const result = await writeClipboardText(text, {
          contentClass: secret ? "secret" : "public",
          label,
          clearIfUnchangedAfterMs: secret ? 60_000 : undefined,
        });
        if (!mountedRef.current) return;
        if (result.ok) {
          const message = clipboardAnnouncement(result, label);
          setStatus(message);
          toast.success(`${label} copied to clipboard`);
        } else {
          setStatus(result.message);
          toast.error(result.message);
        }
      } catch {
        if (!mountedRef.current) return;
        const message = `${label} couldn't be copied. Select and copy the visible text manually.`;
        setStatus(message);
        toast.error(message);
      }
    })().finally(() => {
      if (operationRef.current === request) operationRef.current = null;
      if (mountedRef.current) setBusy(false);
    });
    operationRef.current = request;
    return request;
  };
  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 4,
      }}
    >
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled={busy || undefined}
        aria-describedby={status ? statusId : undefined}
        onClick={() => void copy()}
      >
        {busy ? "Copying…" : `Copy ${label}`}
      </button>
      {status ? (
        <span
          id={statusId}
          className="muted"
          role="status"
          style={{ fontSize: 11 }}
        >
          {status}
        </span>
      ) : null}
    </span>
  );
}

function ConversionFeedTable({
  rows,
  loading,
  error,
  accessDenied,
}: {
  rows: ConversionRow[] | null;
  loading: boolean;
  error: string | null;
  accessDenied: boolean;
}): ReactElement {
  const columns: readonly DataTableColumn<ConversionRow>[] = [
    {
      id: "receipt-id",
      header: "Conversion ID",
      width: "100px",
      cell: (row) => (
        <span className="mono" style={{ overflowWrap: "anywhere" }}>
          {String(row.id)}
        </span>
      ),
    },
    {
      id: "time",
      header: "Occurred",
      width: "155px",
      cell: (row) => <EventTime value={row.occurred_at} />,
    },
    {
      id: "event",
      header: "Event",
      width: "150px",
      cell: (row) => (
        <span className="badge accent mono">{row.event_name}</span>
      ),
    },
    {
      id: "subscriber",
      header: "Subscriber",
      width: "200px",
      cell: (row) => (
        <span
          className="mono"
          style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
        >
          {row.subscriber_email || "Not recorded"}
        </span>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      width: "100px",
      align: "end",
      className: "tabular",
      cell: (row) => fmtConversionAmount(row.amount_cents, row.currency),
    },
    {
      id: "campaign",
      header: "Campaign",
      width: "180px",
      cell: (row) => (
        <span
          className="mono muted"
          style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
        >
          {row.campaign_id || "Unattributed"}
        </span>
      ),
    },
    {
      id: "attribution-method",
      header: "Attribution method",
      width: "165px",
      cell: (row) => (
        <span
          className="muted"
          title={
            row.attributed_via === "last_touch"
              ? "Inferred from the subscriber's most recent qualifying click; this is a heuristic, not proof of causation."
              : row.attributed_via === "code_redemption"
                ? "Linked through one issued-code assignment; this does not prove who redeemed the code or read the message."
                : row.attributed_via === "campaign_vanity_path"
                  ? "Linked through a shared campaign path; this is campaign-scope evidence, not recipient identity."
              : undefined
          }
        >
          {conversionAttributionLabel(row.attributed_via)}
        </span>
      ),
    },
    {
      id: "properties",
      header: "Properties preview",
      width: "min(230px, 26vw)",
      cell: (row) => (
        <code
          className="mono track-json-preview"
          role="region"
          tabIndex={0}
          aria-label={`Properties for conversion ${row.id}`}
        >
          {boundedJsonPreview(row.properties, 1_200)}
        </code>
      ),
    },
  ];
  return (
    <DataTable
      caption="Conversion event feed"
      description={
        loading && rows
          ? "Refreshing · showing the last verified conversions"
          : error && rows
            ? "Refresh failed · showing the last verified conversions"
            : `${(rows?.length ?? 0).toLocaleString()} conversion${rows?.length === 1 ? "" : "s"} loaded, newest first`
      }
      columns={columns}
      rows={rows ?? []}
      getRowKey={(row) => String(row.id)}
      loading={loading && rows === null}
      loadingLabel="Loading conversion events…"
      emptyState={
        accessDenied
          ? "The raw conversion feed is unavailable. This identity needs both read:reports and read:subscribers."
          : error
            ? "Conversion data is unavailable. Retry the conversions refresh."
            : "No conversions have been recorded. Create a tracking key and post a purchase or signup event using the integration example below."
      }
      density="compact"
    />
  );
}

function TrackingKeysTable({
  keys,
  loading,
  error,
  canAdmin,
  operationActive,
  onRevoke,
}: {
  keys: ConversionTrackingKey[] | null;
  loading: boolean;
  error: string | null;
  canAdmin: boolean;
  operationActive: boolean;
  onRevoke: (key: ConversionTrackingKey) => void;
}): ReactElement {
  const permissionReasonId = useId();
  const mutationUnavailable =
    !canAdmin || operationActive || loading || Boolean(error);
  const columns: readonly DataTableColumn<ConversionTrackingKey>[] = [
    {
      id: "key-id",
      header: "Key ID",
      width: "180px",
      cell: (key) => (
        <span className="mono" style={{ overflowWrap: "anywhere" }}>
          {key.id}
        </span>
      ),
    },
    {
      id: "label",
      header: "Label",
      width: "220px",
      cell: (key) => (
        <strong style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {key.label}
        </strong>
      ),
    },
    {
      id: "prefix",
      header: "Public prefix",
      width: "150px",
      cell: (key) => <span className="mono">{keyPrefixDisplay(key)}</span>,
    },
    {
      id: "status",
      header: "Status",
      width: "150px",
      cell: (key) => {
        const state = trackingKeyState(key);
        return (
          <span className="track-key-state">
            <span
              className={`badge${state.tone === "success" ? " success" : ""}`}
            >
              {state.label}
            </span>
            {key.revoked_at ? (
              <span className="muted">
                Revoked <EventTime value={key.revoked_at} />
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "created",
      header: "Created",
      width: "165px",
      cell: (key) => <EventTime value={key.created_at} />,
    },
    {
      id: "actions",
      header: <span className="visually-hidden">Tracking key actions</span>,
      width: "120px",
      align: "end",
      cell: (key) =>
        key.revoked_at ? (
          <span className="muted">No actions</span>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-disabled={mutationUnavailable || undefined}
            aria-describedby={
              mutationUnavailable ? permissionReasonId : undefined
            }
            onClick={() => {
              if (!mutationUnavailable) onRevoke(key);
            }}
          >
            Revoke
          </button>
        ),
    },
  ];
  return (
    <>
      {mutationUnavailable ? (
        <div
          id={permissionReasonId}
          className="muted"
          style={{ fontSize: 12, marginBottom: 8 }}
        >
          {!canAdmin
            ? "Admin access is required to create or revoke conversion tracking keys. Existing key status remains visible."
            : error
              ? "Resolve the tracking-key register error before changing credentials."
              : loading
                ? "Wait for the tracking-key register refresh to finish before changing credentials."
                : "Wait for the current tracking-key operation to finish."}
        </div>
      ) : null}
      <DataTable
        caption="Conversion tracking keys"
        description={
          loading && keys
            ? "Refreshing · showing the last verified key register"
            : error && keys
              ? "Refresh failed · showing the last verified key register"
              : `${(keys?.length ?? 0).toLocaleString()} key${keys?.length === 1 ? "" : "s"} registered`
        }
        columns={columns}
        rows={keys ?? []}
        getRowKey={(key) => key.id}
        loading={loading && keys === null}
        loadingLabel="Loading tracking keys…"
        emptyState={
          error
            ? "Tracking keys are unavailable. Retry the conversions refresh."
            : canAdmin
              ? "No tracking keys exist. Create one to route low-trust conversion posts."
              : "No tracking keys are visible. Ask an admin to create the first key."
        }
        density="compact"
      />
    </>
  );
}

interface ConversionSectionSurfaceProps {
  canAdmin: boolean;
  rows: ConversionRow[] | null;
  cursor: ConversionListCursor | null;
  feedError: string | null;
  feedAccessDenied: boolean;
  feedLoading: boolean;
  moreLoading: boolean;
  moreError: string | null;
  keys: ConversionTrackingKey[] | null;
  keysError: string | null;
  keysLoading: boolean;
  keyOperationActive: boolean;
  revealed: RevealedConversionKey | null;
  snippet: string;
  createOpen: boolean;
  createLabel: string;
  createError: string | null;
  createBusy: boolean;
  createUncertain: boolean;
  confirmCreateClose: boolean;
  confirmSecretClose: boolean;
  revoking: ConversionTrackingKey | null;
  revokeBusy: boolean;
  revokeError: string | null;
  onRefresh: () => void;
  onLoadMore: () => void;
  onRequestCreate: () => void;
  onRevoke: (key: ConversionTrackingKey) => void;
  onCreateLabelChange: (value: string) => void;
  onRequestCreateClose: () => void;
  onCreate: () => void;
  onRequestSecretClose: () => void;
  onKeepSecretOpen: () => void;
  onResolveSecret: () => void;
  onDiscardCreateDraft: () => void;
  onKeepCreateDraft: () => void;
  onConfirmRevoke: () => void;
  onCancelRevoke: () => void;
}

function ConversionSectionSurface({
  canAdmin,
  rows,
  cursor,
  feedError,
  feedAccessDenied,
  feedLoading,
  moreLoading,
  moreError,
  keys,
  keysError,
  keysLoading,
  keyOperationActive,
  revealed,
  snippet,
  createOpen,
  createLabel,
  createError,
  createBusy,
  createUncertain,
  confirmCreateClose,
  confirmSecretClose,
  revoking,
  revokeBusy,
  revokeError,
  onRefresh,
  onLoadMore,
  onRequestCreate,
  onRevoke,
  onCreateLabelChange,
  onRequestCreateClose,
  onCreate,
  onRequestSecretClose,
  onKeepSecretOpen,
  onResolveSecret,
  onDiscardCreateDraft,
  onKeepCreateDraft,
  onConfirmRevoke,
  onCancelRevoke,
}: ConversionSectionSurfaceProps): ReactElement {
  const refreshStatusId = useId();
  const moreStatusId = useId();
  const keyActionReasonId = useId();
  const refreshBusy = feedLoading || keysLoading;
  const newKeyUnavailable =
    !canAdmin ||
    keyOperationActive ||
    revealed !== null ||
    keysError !== null ||
    keys === null ||
    keysLoading;
  const activeKey = keys?.find((key) => !key.revoked_at);
  return (
    <section style={{ marginTop: 28 }}>
      <SectionHeader
        title="Conversions"
        description="Revenue and goal events posted from your site or backend, attributed to campaigns where possible."
        helpText="Conversions arrive via the low-trust public tracking endpoint and are routed by a publishable tenant key (not an HMAC signing secret or dashboard API key). Viewing the raw, subscriber-linked feed requires both read:reports and read:subscribers. A valid workspace campaign hint is explicit attribution; without one, a recent qualifying click may produce heuristic last-touch attribution. Invalid, stale, or foreign campaign hints remain unattributed."
        actions={
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={refreshBusy || undefined}
            aria-describedby={refreshStatusId}
            onClick={onRefresh}
          >
            {refreshBusy ? "Refreshing…" : "Refresh conversions"}
          </button>
        }
      />
      {feedError ? (
        <div className="notice" role="alert">
          Conversion feed: {feedError}
        </div>
      ) : null}
      <div
        id={refreshStatusId}
        className="muted"
        role={refreshBusy ? "status" : undefined}
        style={{ fontSize: 12, margin: "8px 0" }}
      >
        {refreshBusy
          ? "Refreshing the conversion feed and tracking-key register."
          : feedAccessDenied
            ? CONVERSION_FEED_ACCESS_MESSAGE
            : "Conversions are newest first; every row distinguishes explicit, heuristic, unattributed, and legacy-unclassified attribution."}
      </div>
      <ConversionFeedTable
        rows={rows}
        loading={feedLoading}
        error={feedError}
        accessDenied={feedAccessDenied}
      />
      {cursor ? (
        <div style={{ marginTop: 8, textAlign: "center" }}>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={moreLoading || undefined}
            aria-describedby={moreStatusId}
            onClick={onLoadMore}
          >
            {moreLoading ? "Loading…" : "Load older conversions"}
          </button>
          <div
            id={moreStatusId}
            className={moreError ? "field-error" : "muted"}
            role={moreError ? "alert" : moreLoading ? "status" : undefined}
            style={{ fontSize: 12 }}
          >
            {moreError ??
              (moreLoading
                ? "Loading the next older page. Repeated activation reuses this request."
                : "Loads the next cursor page without replacing the conversions already shown.")}
          </div>
        </div>
      ) : null}
      <div style={{ marginTop: 20 }}>
        <SectionHeader
          title="Tracking keys"
          description="Publishable per-tenant keys route low-trust browser or server telemetry. They do not sign events and must never be reused as HMAC signing secrets. Rotate by creating a new key, updating your integration, and revoking the old key."
          actions={
            <button
              type="button"
              className="btn btn-sm btn-primary"
              aria-disabled={newKeyUnavailable || undefined}
              aria-describedby={
                newKeyUnavailable ? keyActionReasonId : undefined
              }
              onClick={() => {
                if (!newKeyUnavailable) onRequestCreate();
              }}
            >
              + New key
            </button>
          }
        />
        <div className="notice" role="note" style={{ marginBottom: 8 }}>
          <strong>Telemetry trust boundary.</strong> A publishable tracking key
          proves tenant routing, not that revenue came from a trusted source.
          Treat amounts and revenue metrics as marketing telemetry—not an
          authoritative financial ledger. Use Trusted server conversion ingest
          below for HMAC-authenticated feeds.
          <br />
          The ordinary key register never reveals a full key. Admin-only
          idempotent retries can replay the exact creation response for 24
          hours.
        </div>
        <div
          id={keyActionReasonId}
          className="muted"
          style={{ fontSize: 12, margin: "0 0 8px" }}
        >
          {!canAdmin
            ? "Admin access is required to create or revoke tracking keys."
            : keysError
              ? "Resolve the tracking-key register error before changing credentials."
              : keys === null
                ? "Wait for the tracking-key register to be verified before creating a key."
                : keysLoading
                  ? "Wait for the tracking-key register refresh to finish before changing credentials."
                  : revealed
                    ? "Store and acknowledge the newly created key before creating another."
                    : keyOperationActive
                      ? "Wait for the current tracking-key operation to finish."
                      : "Create a key only when you are ready to store its creation response."}
        </div>
        {keysError ? (
          <div className="notice" role="alert">
            {keysError}
          </div>
        ) : null}
        <TrackingKeysTable
          keys={keys}
          loading={keysLoading}
          error={keysError}
          canAdmin={canAdmin}
          operationActive={keyOperationActive}
          onRevoke={onRevoke}
        />
      </div>
      <div className="card" style={{ marginTop: 16, padding: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          <div className="section-title" style={{ marginBottom: 0 }}>
            Posting publishable telemetry
            <InlineHelp text="This is the low-trust public endpoint, not signed ingest. Browser JSON requests work only when the API CORS allowlist includes that browser origin. The publishable key routes telemetry to a tenant but does not create an HMAC signature. The example deliberately contains no email. Use Trusted server conversion ingest below for authoritative feeds." />
          </div>
          <span className="spacer" />
          <CopyButton text={snippet} label="curl snippet" />
        </div>
        <pre
          className="mono"
          style={{
            margin: 0,
            fontSize: 11,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            background: "var(--pw-bg-elev-2)",
            borderRadius: 6,
            padding: 12,
          }}
        >
          {snippet}
        </pre>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          {activeKey ? (
            <>
              The snippet shows the key <em>prefix</em> only
              {keysError ? " from the last verified key register" : ""} —
              substitute the full key from the creation response.
            </>
          ) : (
            <>
              Replace <span className="mono">&lt;tracking-key&gt;</span> with a
              real key. A prefix is never a usable credential.
            </>
          )}
        </div>
      </div>
      <ConversionKeyCreateModal
        open={createOpen}
        label={createLabel}
        error={createError}
        busy={createBusy || keyOperationActive}
        uncertain={createUncertain}
        onLabelChange={onCreateLabelChange}
        onClose={onRequestCreateClose}
        onSubmit={onCreate}
      />
      <ConversionKeyReveal
        revealed={revealed}
        confirmClose={confirmSecretClose}
        onRequestClose={onRequestSecretClose}
        onKeepOpen={onKeepSecretOpen}
        onResolve={onResolveSecret}
      />
      <ConfirmModal
        open={confirmCreateClose}
        title={
          createUncertain
            ? "Close this uncertain key request?"
            : "Discard tracking-key draft?"
        }
        description={
          createUncertain
            ? "The service may have created a key without returning its creation response. Closing clears this form but does not revoke any key. Review the refreshed key register and revoke any unexpected entry."
            : "The unsaved key label will be cleared. No tracking key has been created yet."
        }
        confirmLabel={
          createUncertain ? "Close and review register" : "Discard draft"
        }
        cancelLabel="Keep editing"
        danger
        onConfirm={onDiscardCreateDraft}
        onClose={onKeepCreateDraft}
      />
      <ConfirmModal
        open={revoking !== null}
        danger
        title={'Revoke "' + (revoking?.label ?? "") + '"?'}
        description="Telemetry submitted with this publishable key starts failing immediately. This key does not sign events. Existing recorded conversions are kept."
        confirmLabel="Revoke key"
        busy={revokeBusy || keyOperationActive || keysLoading}
        onConfirm={onConfirmRevoke}
        onClose={onCancelRevoke}
      >
        {revokeError ? <FieldError>{revokeError}</FieldError> : null}
      </ConfirmModal>
    </section>
  );
}

function useConversionFeedController(): {
  rows: ConversionRow[] | null;
  cursor: ConversionListCursor | null;
  error: string | null;
  accessDenied: boolean;
  loading: boolean;
  moreLoading: boolean;
  moreError: string | null;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
} {
  const [rows, setRows] = useState<ConversionRow[] | null>(null);
  const [cursor, setCursor] = useState<ConversionListCursor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const reloadFlightRef = useRef<Promise<void> | null>(null);
  const moreFlightRef = useRef<Promise<void> | null>(null);

  const reload = useCallback((): Promise<void> => {
    if (reloadFlightRef.current) return reloadFlightRef.current;
    const generation = ++generationRef.current;
    moreFlightRef.current = null;
    setMoreLoading(false);
    setMoreError(null);
    setLoading(true);
    setError(null);
    const request = (async (): Promise<void> => {
      try {
        const response = await conversionsApi.list();
        if (!mountedRef.current || generation !== generationRef.current) return;
        if (response.error) {
          const permissionDenied = isRemotePermissionError(response.error);
          if (permissionDenied) {
            setRows(null);
            setCursor(null);
            setAccessDenied(true);
          }
          setError(
            safeTrackFailure(
              response.error,
              permissionDenied
                ? CONVERSION_FEED_ACCESS_MESSAGE
                : "Moosewave couldn't load conversions.",
            ),
          );
          return;
        }
        const page = parseConversionRows(response.data);
        if (!page) {
          setError(
            "Moosewave couldn't verify the conversion response. Retry before relying on this feed.",
          );
          return;
        }
        setAccessDenied(false);
        setRows(page);
        setCursor(nextConversionsCursor(page));
      } catch {
        if (mountedRef.current && generation === generationRef.current) {
          setError(
            "Moosewave couldn't load conversions. Check the connection and retry.",
          );
        }
      } finally {
        if (mountedRef.current && generation === generationRef.current) {
          setLoading(false);
        }
      }
    })();
    reloadFlightRef.current = request;
    void request.finally(() => {
      if (reloadFlightRef.current === request) reloadFlightRef.current = null;
    });
    return request;
  }, []);

  const loadMore = useCallback((): Promise<void> => {
    if (moreFlightRef.current) return moreFlightRef.current;
    if (!cursor) return Promise.resolve();
    const requestedCursor = cursor;
    const generation = generationRef.current;
    setMoreLoading(true);
    setMoreError(null);
    const request = (async (): Promise<void> => {
      try {
        const response = await conversionsApi.list(requestedCursor);
        if (!mountedRef.current || generation !== generationRef.current) return;
        if (response.error) {
          const permissionDenied = isRemotePermissionError(response.error);
          if (permissionDenied) {
            setRows(null);
            setCursor(null);
            setAccessDenied(true);
          }
          const message = safeTrackFailure(
            response.error,
            permissionDenied
              ? CONVERSION_FEED_ACCESS_MESSAGE
              : "Older conversions couldn't be loaded.",
          );
          if (permissionDenied) setError(message);
          setMoreError(message);
          toast.error(message);
          return;
        }
        const page = parseConversionRows(response.data);
        if (!page) {
          const message =
            "Moosewave couldn't verify the older-conversions response. Existing verified rows were not changed.";
          setMoreError(message);
          toast.error(message);
          return;
        }
        setAccessDenied(false);
        setRows((previous) => {
          const existingIds = new Set(
            (previous ?? []).map((conversion) => conversion.id),
          );
          return [
            ...(previous ?? []),
            ...page.filter((conversion) => !existingIds.has(conversion.id)),
          ];
        });
        setCursor(nextConversionsCursor(page));
      } catch {
        if (mountedRef.current && generation === generationRef.current) {
          const message =
            "Older conversions couldn't be loaded. Check the connection and retry.";
          setMoreError(message);
          toast.error(message);
        }
      } finally {
        if (mountedRef.current && generation === generationRef.current) {
          setMoreLoading(false);
        }
      }
    })();
    moreFlightRef.current = request;
    void request.finally(() => {
      if (moreFlightRef.current === request) moreFlightRef.current = null;
    });
    return request;
  }, [cursor]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      reloadFlightRef.current = null;
      moreFlightRef.current = null;
    };
  }, [reload]);

  return {
    rows,
    cursor,
    error,
    accessDenied,
    loading,
    moreLoading,
    moreError,
    reload,
    loadMore,
  };
}

function useConversionKeyRegister(
  canAdmin: boolean,
  onAccessDenied: () => void,
): {
  keys: ConversionTrackingKey[] | null;
  setKeys: (keys: ConversionTrackingKey[] | null) => void;
  error: string | null;
  setError: (error: string | null) => void;
  loading: boolean;
  reload: (force?: boolean) => Promise<void>;
} {
  const [keys, setKeys] = useState<ConversionTrackingKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const reloadFlightRef = useRef<Promise<void> | null>(null);

  const reload = useCallback(
    (force = false): Promise<void> => {
      if (!force && reloadFlightRef.current) return reloadFlightRef.current;
      if (force) reloadFlightRef.current = null;
      const generation = ++generationRef.current;
      setLoading(true);
      setError(null);
      const request = (async (): Promise<void> => {
        try {
          const response = await conversionsApi.listKeys();
          if (!mountedRef.current || generation !== generationRef.current)
            return;
          if (response.error) {
            const message = safeTrackFailure(
              response.error,
              "Moosewave couldn't load conversion tracking keys.",
            );
            if (isRemotePermissionError(response.error)) {
              setKeys(null);
              onAccessDenied();
            }
            setError(message);
            return;
          }
          const parsed = parseConversionKeys(response.data);
          if (!parsed) {
            setError(
              "Moosewave couldn't verify the tracking-key register. Retry before changing credentials.",
            );
            return;
          }
          setKeys(parsed);
        } catch {
          if (mountedRef.current && generation === generationRef.current) {
            setError(
              "Moosewave couldn't load conversion tracking keys. Check the connection and retry.",
            );
          }
        } finally {
          if (mountedRef.current && generation === generationRef.current) {
            setLoading(false);
          }
        }
      })();
      reloadFlightRef.current = request;
      void request.finally(() => {
        if (reloadFlightRef.current === request) reloadFlightRef.current = null;
      });
      return request;
    },
    [onAccessDenied],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (canAdmin) void reload();
    else {
      generationRef.current += 1;
      reloadFlightRef.current = null;
      setKeys(null);
      setError(null);
      setLoading(false);
      onAccessDenied();
    }
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      reloadFlightRef.current = null;
    };
  }, [canAdmin, onAccessDenied, reload]);

  return { keys, setKeys, error, setError, loading, reload };
}

function useConversionKeysController(canAdmin: boolean): {
  keys: ConversionTrackingKey[] | null;
  error: string | null;
  loading: boolean;
  operationActive: boolean;
  revealed: RevealedConversionKey | null;
  createOpen: boolean;
  createLabel: string;
  createError: string | null;
  createBusy: boolean;
  createUncertain: boolean;
  confirmCreateClose: boolean;
  confirmSecretClose: boolean;
  revoking: ConversionTrackingKey | null;
  revokeBusy: boolean;
  revokeError: string | null;
  reload: (force?: boolean) => Promise<void>;
  requestCreate: () => void;
  setCreateLabel: (value: string) => void;
  requestCreateClose: () => void;
  create: () => Promise<void>;
  requestSecretClose: () => void;
  keepSecretOpen: () => void;
  resolveSecret: () => void;
  discardCreateDraft: () => void;
  keepCreateDraft: () => void;
  requestRevoke: (key: ConversionTrackingKey) => void;
  confirmRevoke: () => Promise<void>;
  cancelRevoke: () => void;
} {
  const [createOpen, setCreateOpen] = useState(false);
  const [createLabel, setCreateLabel] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createUncertain, setCreateUncertain] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmCreateClose, setConfirmCreateClose] = useState(false);
  const [revealed, setRevealed] = useState<RevealedConversionKey | null>(null);
  const [confirmSecretClose, setConfirmSecretClose] = useState(false);
  const [revoking, setRevoking] = useState<ConversionTrackingKey | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const canAdminRef = useRef(canAdmin);
  canAdminRef.current = canAdmin;
  const { activate: activateSecretGuard, resolve: releaseSecretGuard } =
    useShownOnceSecretLifecycle(
      "conversion-tracking-key",
      "Conversion tracking key",
      revealed !== null,
    );
  const operation = useSingleFlightOperation({
    ownerId: "conversion-tracking-key",
    label: "Conversion tracking-key operation",
    detail: "Wait for the tracking-key request to finish before leaving.",
  });
  const discardCreateDraft = useCallback((): void => {
    setCreateLabel("");
    setCreateError(null);
    setCreateUncertain(false);
    setCreateOpen(false);
    setConfirmCreateClose(false);
  }, []);
  const clearPrivilegedEvidence = useCallback((): void => {
    setCreateOpen(false);
    setCreateLabel("");
    setCreateBusy(false);
    setCreateUncertain(false);
    setCreateError(null);
    setConfirmCreateClose(false);
    releaseSecretGuard();
    setRevealed(null);
    setConfirmSecretClose(false);
    setRevoking(null);
    setRevokeBusy(false);
    setRevokeError(null);
  }, [releaseSecretGuard]);
  const { keys, setKeys, error, setError, loading, reload } =
    useConversionKeyRegister(canAdmin, clearPrivilegedEvidence);
  const createDirty = createOpen && createLabel.trim() !== "";
  useDiscardOnlyDraftLifecycle({
    ownerId: "conversion-key-create",
    label: "Conversion tracking-key draft",
    dirty: createDirty,
    operationRef: operation.promiseRef,
    discard: discardCreateDraft,
    detail: "This tracking-key label has not been submitted.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestCreateClose = (): void => {
    if (createBusy || operation.active) return;
    if (createDirty) {
      setConfirmCreateClose(true);
      return;
    }
    discardCreateDraft();
  };
  const resolveSecret = (): void => {
    releaseSecretGuard();
    setConfirmSecretClose(false);
    setRevealed(null);
  };
  const create = async (): Promise<void> => {
    if (!canAdminRef.current) return;
    const label = createLabel.trim();
    const labelError = conversionTrackingKeyLabelError(label);
    if (labelError) {
      setCreateError(labelError);
      return;
    }
    setCreateError(null);
    setCreateUncertain(false);
    const request = operation.run(() => conversionsApi.createKey(label));
    if (!request) return;
    setCreateBusy(true);
    let response: Awaited<ReturnType<typeof conversionsApi.createKey>>;
    try {
      response = await request;
    } catch {
      if (mountedRef.current) {
        setCreateUncertain(true);
        setCreateError(
          "The key request couldn't be confirmed. It may have been created; review the key register before retrying.",
        );
        await reload(true);
      }
      return;
    } finally {
      if (mountedRef.current) setCreateBusy(false);
    }
    if (!mountedRef.current || !canAdminRef.current) return;
    if (response.error) {
      const message = safeTrackFailure(
        response.error,
        "The conversion tracking key couldn't be created.",
      );
      if (isRemotePermissionError(response.error)) {
        setKeys(null);
        clearPrivilegedEvidence();
        setError(message);
        return;
      }
      if (isUncertainMutationFailure(response.error)) {
        setCreateUncertain(true);
        setCreateError(
          "The key request couldn't be confirmed. It may have been created; review the key register before retrying.",
        );
        await reload(true);
        return;
      }
      setCreateError(message);
      return;
    }
    if (response.queued) {
      setCreateError("You're offline — key creation needs a live server.");
      return;
    }
    const plaintext = parseCreatedSecret(response.data);
    if (!plaintext) {
      setCreateUncertain(true);
      setCreateError(
        "The server did not return the key creation response. It may still have been created; review the key register and revoke any unexpected entry.",
      );
      await reload(true);
      return;
    }
    activateSecretGuard();
    setRevealed({ plaintext, label });
    discardCreateDraft();
    await reload(true);
  };
  const confirmRevoke = async (): Promise<void> => {
    if (!revoking || !canAdminRef.current) return;
    const target = revoking;
    setRevokeError(null);
    const request = operation.run(() => conversionsApi.revokeKey(target.id));
    if (!request) return;
    setRevokeBusy(true);
    let response: Awaited<ReturnType<typeof conversionsApi.revokeKey>>;
    try {
      response = await request;
    } catch {
      const message =
        "The tracking key couldn't be revoked. Check the connection and retry.";
      if (!mountedRef.current) return;
      setRevokeError(message);
      toast.error(message);
      return;
    } finally {
      if (mountedRef.current) setRevokeBusy(false);
    }
    if (!mountedRef.current || !canAdminRef.current) return;
    if (response.error) {
      const message = safeTrackFailure(
        response.error,
        "The tracking key couldn't be revoked.",
      );
      if (isRemotePermissionError(response.error)) {
        setKeys(null);
        clearPrivilegedEvidence();
        setError(message);
        toast.error(message);
        return;
      }
      setRevokeError(message);
      toast.error(message);
      return;
    }
    if (!isConfirmedRevocation(response.data)) {
      const message =
        "The service did not confirm that the key was revoked. Refresh the key register before retrying.";
      setRevokeError(message);
      toast.error(message);
      await reload(true);
      return;
    }
    toast.success(
      'Revoked "' +
        target.label +
        '" — telemetry submitted with it is rejected from now on',
    );
    setRevoking((current) => (current?.id === target.id ? null : current));
    setRevokeError(null);
    await reload(true);
  };
  const cancelRevoke = (): void => {
    if (!revokeBusy && !operation.active) {
      setRevoking(null);
      setRevokeError(null);
    }
  };

  return {
    keys,
    error,
    loading,
    operationActive: operation.active,
    revealed,
    createOpen,
    createLabel,
    createError,
    createBusy,
    createUncertain,
    confirmCreateClose,
    confirmSecretClose,
    revoking,
    revokeBusy,
    revokeError,
    reload,
    requestCreate: () => {
      if (!canAdminRef.current || operation.active || revealed) return;
      setCreateError(null);
      setCreateOpen(true);
    },
    setCreateLabel: (value) => {
      setCreateLabel(value);
      if (!createUncertain) setCreateError(null);
    },
    requestCreateClose,
    create,
    requestSecretClose: () => setConfirmSecretClose(true),
    keepSecretOpen: () => setConfirmSecretClose(false),
    resolveSecret,
    discardCreateDraft,
    keepCreateDraft: () => setConfirmCreateClose(false),
    requestRevoke: (key) => {
      if (!canAdminRef.current) return;
      setRevokeError(null);
      setRevoking(key);
    },
    confirmRevoke,
    cancelRevoke,
  };
}

export function ConversionsSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const feed = useConversionFeedController();
  const keyController = useConversionKeysController(canAdmin);
  const activeKey = keyController.keys?.find((key) => !key.revoked_at);
  const snippet = conversionCurlSnippet(
    getApiUrl(),
    activeKey ? keyPrefixDisplay(activeKey) : undefined,
  );
  return (
    <>
      <ConversionSectionSurface
        canAdmin={canAdmin}
        rows={feed.rows}
        cursor={feed.cursor}
        feedError={feed.error}
        feedAccessDenied={feed.accessDenied}
        feedLoading={feed.loading}
        moreLoading={feed.moreLoading}
        moreError={feed.moreError}
        keys={keyController.keys}
        keysError={keyController.error}
        keysLoading={keyController.loading}
        keyOperationActive={keyController.operationActive}
        revealed={keyController.revealed}
        snippet={snippet}
        createOpen={keyController.createOpen}
        createLabel={keyController.createLabel}
        createError={keyController.createError}
        createBusy={keyController.createBusy}
        createUncertain={keyController.createUncertain}
        confirmCreateClose={keyController.confirmCreateClose}
        confirmSecretClose={keyController.confirmSecretClose}
        revoking={keyController.revoking}
        revokeBusy={keyController.revokeBusy}
        revokeError={keyController.revokeError}
        onRefresh={() => {
          void feed.reload();
          if (canAdmin) void keyController.reload();
        }}
        onLoadMore={() => void feed.loadMore()}
        onRequestCreate={keyController.requestCreate}
        onRevoke={keyController.requestRevoke}
        onCreateLabelChange={keyController.setCreateLabel}
        onRequestCreateClose={keyController.requestCreateClose}
        onCreate={() => void keyController.create()}
        onRequestSecretClose={keyController.requestSecretClose}
        onKeepSecretOpen={keyController.keepSecretOpen}
        onResolveSecret={keyController.resolveSecret}
        onDiscardCreateDraft={keyController.discardCreateDraft}
        onKeepCreateDraft={keyController.keepCreateDraft}
        onConfirmRevoke={() => void keyController.confirmRevoke()}
        onCancelRevoke={keyController.cancelRevoke}
      />
      <ConversionIngestSecretsPanel />
    </>
  );
}

function ConversionKeyReveal({
  revealed,
  confirmClose,
  onRequestClose,
  onKeepOpen,
  onResolve,
}: {
  revealed: RevealedConversionKey | null;
  confirmClose: boolean;
  onRequestClose: () => void;
  onKeepOpen: () => void;
  onResolve: () => void;
}): ReactElement {
  return (
    <>
      <Modal
        open={revealed !== null}
        onClose={onRequestClose}
        title="Tracking key created"
        description={`"${revealed?.label ?? ""}" — store the key from this creation result.`}
      >
        <div className="notice" role="alert" style={{ marginBottom: 12 }}>
          <span>
            <strong>Store it now.</strong> The ordinary tracking-key register
            will not reveal this full value again. If the key is unavailable,
            revoke it and create a new one. This is a publishable routing key,
            not an HMAC signing secret.
          </span>
        </div>
        <div className="copy-row">
          <code
            className="mono copy-text"
            style={{
              fontSize: 12,
              padding: "8px 10px",
              background: "var(--pw-bg-elev-2)",
              borderRadius: 6,
              wordBreak: "break-all",
            }}
            data-testid="conversion-key-plaintext"
          >
            {revealed?.plaintext}
          </code>
          {revealed ? (
            <CopyButton
              text={revealed.plaintext}
              label="publishable tracking key"
            />
          ) : null}
        </div>
        <ModalFooter>
          <button type="button" className="btn btn-primary" onClick={onResolve}>
            I&apos;ve stored it
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={confirmClose}
        title="Close without storing this key?"
        description="The ordinary tracking-key register will not reveal the full key again. If it is unavailable, revoke this key and create another."
        confirmLabel="Discard shown key"
        cancelLabel="Keep key open"
        danger
        onConfirm={onResolve}
        onClose={onKeepOpen}
      />
    </>
  );
}

function ConversionKeyCreateModal({
  open,
  label,
  error,
  busy,
  uncertain,
  onLabelChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  label: string;
  error: string | null;
  busy: boolean;
  uncertain: boolean;
  onLabelChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}): ReactElement {
  const labelRef = useRef<HTMLInputElement>(null);
  const labelCharacterCount = Array.from(label.trim()).length;
  useEffect(() => {
    if (open && error) labelRef.current?.focus();
  }, [error, open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      title="New tracking key"
      description="The full key is generated server-side. After creation, the ordinary key register shows only its prefix."
    >
      <form
        aria-busy={busy || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !uncertain) onSubmit();
        }}
      >
        <FormField
          label="Label"
          required
          error={error}
          help={`Where this key ships — e.g. "storefront", "checkout backend". ${labelCharacterCount}/${CONVERSION_TRACKING_KEY_LABEL_MAX_CODE_POINTS} characters after trimming; control characters are not allowed.`}
        >
          <input
            ref={labelRef}
            type="text"
            className="input"
            autoComplete="off"
            value={label}
            disabled={busy || uncertain}
            spellCheck={false}
            onChange={(event) => onLabelChange(event.target.value)}
            placeholder="storefront"
          />
        </FormField>
        {busy ? (
          <div className="muted" role="status" aria-live="polite">
            Creating the tracking key and waiting for its creation response…
          </div>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            aria-disabled={busy || undefined}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            aria-disabled={busy || uncertain || undefined}
          >
            {busy
              ? "Creating…"
              : uncertain
                ? "Create unavailable"
                : "Create key"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
