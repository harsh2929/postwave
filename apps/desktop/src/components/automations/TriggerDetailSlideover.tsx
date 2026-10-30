/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- bounded overflow regions must be keyboard-scrollable. */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import {
  AUTOMATION_SURFACE_BOUNDARIES,
  ZERO_COPY_ALERTING_AVAILABLE,
  ZERO_COPY_DLQ_RECOVERY_AVAILABLE,
  ZERO_COPY_LIVE_POLL_AVAILABLE,
} from "../../lib/automation-operational-availability";
import {
  type ZeroCopyTrigger,
  zeroCopyTriggersApi,
} from "../../lib/api-client";
import { SlideoverShell } from "../SlideoverShell";

import {
  type ResponseNormalization,
  type SafeAlertConfig,
  type SafeDLQRecord,
  type SafeFireRecord,
  normalizeAlertConfig,
  normalizeDLQResponse,
  normalizeFireResponse,
} from "./response-normalizers";
import {
  fireStatusTone,
  fmtDuration,
  fmtRelative,
  maskOperationalIdentifier,
  triggerHealth,
} from "./zero-copy-helpers";

type Tab = "fires" | "alerts" | "dlq";
const TRIGGER_TABS: readonly { value: Tab; label: string }[] = [
  { value: "fires", label: "Enqueue log" },
  { value: "alerts", label: "Alert config" },
  { value: "dlq", label: "Recovery" },
];

interface InspectionResponse<T> {
  data?: T;
  error?: { message: string } | null;
}

interface InspectionState<T> {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  stale: boolean;
}

function useInspectableResource<T>(
  resourceKey: string,
  request: () => Promise<InspectionResponse<unknown>>,
  normalize: (input: unknown) => ResponseNormalization<T>,
): InspectionState<T> & { refresh: () => Promise<void> } {
  const requestRef = useRef(request);
  requestRef.current = request;
  const normalizeRef = useRef(normalize);
  normalizeRef.current = normalize;
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const [state, setState] = useState<InspectionState<T>>({
    data: null,
    loading: true,
    refreshing: false,
    error: null,
    stale: false,
  });

  const execute = useCallback(async (retain: boolean): Promise<void> => {
    const sequence = ++sequenceRef.current;
    setState((previous) => ({
      data: retain ? previous.data : null,
      loading: !retain || previous.data === null,
      refreshing: retain && previous.data !== null,
      error: null,
      stale: false,
    }));
    try {
      const response = await requestRef.current();
      if (!mountedRef.current || sequence !== sequenceRef.current) return;
      if (response.error) {
        setState((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error:
            "The inspection request failed. Retry, then review secure service logs if it persists.",
          stale: previous.data !== null,
        }));
        return;
      }
      const normalized = normalizeRef.current(response.data);
      if (!normalized.ok) {
        setState((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error: normalized.message,
          stale: previous.data !== null,
        }));
        return;
      }
      setState({
        data: normalized.value,
        loading: false,
        refreshing: false,
        error: null,
        stale: false,
      });
    } catch {
      if (!mountedRef.current || sequence !== sequenceRef.current) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        refreshing: false,
        error:
          "The inspection request did not complete. Retry, then review secure service logs if it persists.",
        stale: previous.data !== null,
      }));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void execute(false);
    return () => {
      mountedRef.current = false;
      sequenceRef.current += 1;
    };
  }, [execute, resourceKey]);

  return { ...state, refresh: () => execute(true) };
}

export function TriggerDetailSlideover({
  trigger,
  canAdmin,
  onClose,
}: {
  trigger: ZeroCopyTrigger;
  canAdmin: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}): ReactElement {
  const [tab, setTab] = useState<Tab>("fires");
  const pollDescriptionId = useId();
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: TRIGGER_TABS,
    onChange: setTab,
  });
  const health = triggerHealth(trigger);
  const legacyActive = trigger.status.toLowerCase() === "active";

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="lg"
      eyebrow="Warehouse trigger definition"
      title={trigger.name || "Unnamed trigger"}
      subtitle={
        <>
          <span
            className={`badge ${legacyActive ? "warning" : health.tone === "neutral" ? "" : health.tone}`}
          >
            {legacyActive ? "active · runtime blocked" : health.label}
          </span>{" "}
          {trigger.provider} · configured every{" "}
          {fmtDuration(trigger.polling_interval_seconds)} ·{" "}
          {trigger.rows_fired_total.toLocaleString()} enqueue records
        </>
      }
      headerActions={
        canAdmin ? (
          <>
            <span id={pollDescriptionId} className="visually-hidden">
              Live polling is unavailable until the durable automation runtime
              passes qualification.
            </span>
            <button
              type="button"
              className="btn"
              aria-disabled={!ZERO_COPY_LIVE_POLL_AVAILABLE}
              aria-describedby={pollDescriptionId}
              onClick={() => {
                // Keep the boundary fail closed even if an assistive or
                // automated client invokes this discoverable control.
                if (!ZERO_COPY_LIVE_POLL_AVAILABLE) return;
              }}
            >
              Poll unavailable
            </button>
          </>
        ) : undefined
      }
    >
      <SummaryStrip trigger={trigger} />

      <div className="automations-runtime-note" role="note">
        <strong>Inspection only</strong>
        <span>
          Enqueue rows and stored statuses are operational records, not proof
          that a journey ran or a message was delivered.
        </span>
      </div>

      {trigger.last_error ? (
        <div className="callout error" role="status">
          <strong>An operational error is recorded.</strong> Details are hidden
          here because provider errors can contain warehouse or profile data.
          Review secure service logs for diagnosis.
        </div>
      ) : null}

      <div
        ref={tabs.listRef}
        className="tabbar automations-detail-tabs"
        {...tabs.listProps}
        aria-label="Trigger definition details"
      >
        {TRIGGER_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            {...tabs.getTabProps(item.value)}
            className={tab === item.value ? "tab active" : "tab"}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section {...tabs.getPanelProps("fires")}>
        {tab === "fires" ? <FiresTab triggerId={trigger.id ?? ""} /> : null}
      </section>
      <section {...tabs.getPanelProps("alerts")}>
        {tab === "alerts" ? <AlertsTab triggerId={trigger.id ?? ""} /> : null}
      </section>
      <section {...tabs.getPanelProps("dlq")}>
        {tab === "dlq" ? (
          <DLQTab triggerId={trigger.id ?? ""} canAdmin={canAdmin} />
        ) : null}
      </section>
    </SlideoverShell>
  );
}

function SummaryStrip({ trigger }: { trigger: ZeroCopyTrigger }): ReactElement {
  const items = [
    ["Last poll record", fmtRelative(trigger.last_polled_at)],
    ["Last success record", fmtRelative(trigger.last_success_at)],
    ["Stored failures", String(trigger.consecutive_failures)],
    ["Cursor suffix", maskOperationalIdentifier(trigger.last_seen_cursor)],
  ];
  return (
    <dl className="automations-summary-strip">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResourceFailure({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="automations-load-error" role="alert">
      <strong>{title}</strong>
      <span>{message}</span>
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function StaleInspection({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="callout warning" role="status">
      Showing the last loaded records. Refresh failed: {message}{" "}
      <button type="button" className="link-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function FiresTab({ triggerId }: { triggerId: string }): ReactElement {
  const resource = useInspectableResource(
    `fires:${triggerId}`,
    () => zeroCopyTriggersApi.fires(triggerId),
    (input) => normalizeFireResponse(input, triggerId),
  );
  const rows = resource.data?.items ?? null;

  if (rows === null && resource.loading) {
    return (
      <p className="muted" role="status">
        Loading enqueue records…
      </p>
    );
  }
  if (rows === null && resource.error) {
    return (
      <ResourceFailure
        title="Enqueue records are unavailable."
        message={resource.error}
        onRetry={() => void resource.refresh()}
      />
    );
  }
  return (
    <div>
      <div className="automations-tab-heading">
        <p>
          The API returns the latest 100 enqueue records. “Fired” describes a
          stored hand-off record; it does not confirm downstream execution.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={resource.refreshing}
          onClick={() => void resource.refresh()}
        >
          {resource.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {resource.error && resource.stale ? (
        <StaleInspection
          message={resource.error}
          onRetry={() => void resource.refresh()}
        />
      ) : null}
      {rows?.length === 0 ? (
        <div className="automations-inline-empty">
          <strong>No enqueue records returned</strong>
          <span>
            This does not prove that polling ran or that no failures occurred.
          </span>
        </div>
      ) : rows ? (
        <div
          className="automations-table-scroll"
          role="region"
          aria-label="Trigger enqueue records"
          tabIndex={0}
        >
          <table className="data-table automations-responsive-table">
            <thead>
              <tr>
                <th scope="col">Recorded</th>
                <th scope="col">Stored status</th>
                <th scope="col">Related data present</th>
                <th scope="col">Outcome marker</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((fire: SafeFireRecord) => {
                const tone = fireStatusTone(fire.status);
                return (
                  <tr key={fire.id}>
                    <td data-label="Recorded" className="muted tabular">
                      {fmtRelative(fire.firedAt)}
                    </td>
                    <td data-label="Stored status">
                      <span
                        className={`badge ${tone === "neutral" ? "" : tone}`}
                      >
                        {fire.status}
                      </span>
                    </td>
                    <td data-label="Related data present" className="muted">
                      {firePresenceLabel(fire)}
                    </td>
                    <td data-label="Outcome marker" className="muted">
                      {fire.errorCategory
                        ? "Execution error recorded · details hidden"
                        : "No error category reported"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function AlertsTab({ triggerId }: { triggerId: string }): ReactElement {
  const unavailableReasonId = useId();
  const resource = useInspectableResource(
    `alerts:${triggerId}`,
    () => zeroCopyTriggersApi.getAlerts(triggerId),
    (input) => normalizeAlertConfig(input, triggerId),
  );
  const config = resource.data;
  const boundary = AUTOMATION_SURFACE_BOUNDARIES["warehouse-triggers"];

  if (config === null && resource.loading) {
    return (
      <p className="muted" role="status">
        Loading alert configuration…
      </p>
    );
  }
  if (config === null && resource.error) {
    return (
      <ResourceFailure
        title="Alert configuration is unavailable."
        message={resource.error}
        onRetry={() => void resource.refresh()}
      />
    );
  }
  return (
    <div>
      <div
        className="automations-runtime-note is-blocked"
        role="note"
        id={unavailableReasonId}
      >
        <strong>Alerting unavailable</strong>
        <span>
          Effective defaults or stored thresholds can be inspected; persistence
          is not exposed by this response. Evaluator and notifier readiness is
          not qualified, so editing is disabled. {boundary.unavailable}.
        </span>
      </div>
      {resource.error && resource.stale ? (
        <StaleInspection
          message={resource.error}
          onRetry={() => void resource.refresh()}
        />
      ) : null}
      {config ? <AlertConfigSummary config={config} /> : null}
      <button
        type="button"
        className="btn"
        aria-disabled={!ZERO_COPY_ALERTING_AVAILABLE}
        aria-describedby={unavailableReasonId}
        onClick={() => {
          if (!ZERO_COPY_ALERTING_AVAILABLE) return;
        }}
      >
        Saving unavailable
      </button>
    </div>
  );
}

function AlertConfigSummary({
  config,
}: {
  config: SafeAlertConfig;
}): ReactElement {
  const values = [
    ["Failure threshold", config.consecutiveFailuresThreshold.toLocaleString()],
    ["Lag threshold", fmtDuration(config.lagSecondsThreshold)],
    ["Rows-per-poll threshold", config.firesPerTickThreshold.toLocaleString()],
    ["Cooldown", fmtDuration(config.cooldownSeconds)],
    [
      "Webhook destination",
      config.webhookConfigured ? "Configured (hidden)" : "Not configured",
    ],
    ["Last alert record", fmtRelative(config.lastAlertFiredAt)],
    ["Last alert kind", alertKindLabel(config.lastAlertKind)],
    [
      "Alert message",
      config.hasLastAlertMessage ? "Recorded (hidden)" : "Not recorded",
    ],
    [
      "Server runtime descriptor",
      config.runtime.executionEnabled
        ? "Reports enabled · desktop remains blocked"
        : config.runtime.runtimeStatus,
    ],
  ];
  return (
    <dl className="automations-definition-grid">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DLQTab({
  triggerId,
  canAdmin,
}: {
  triggerId: string;
  canAdmin: boolean;
}): ReactElement {
  const unavailableReasonId = useId();
  const resource = useInspectableResource(
    `dlq:${triggerId}`,
    () => zeroCopyTriggersApi.listDLQ(triggerId),
    (input) => normalizeDLQResponse(input, triggerId),
  );
  const rows = resource.data?.items ?? null;

  if (rows === null && resource.loading) {
    return (
      <p className="muted" role="status">
        Loading recovery records…
      </p>
    );
  }
  if (rows === null && resource.error) {
    return (
      <ResourceFailure
        title="Recovery records are unavailable."
        message={resource.error}
        onRetry={() => void resource.refresh()}
      />
    );
  }
  return (
    <div>
      <div
        className="automations-runtime-note is-blocked"
        role="note"
        id={unavailableReasonId}
      >
        <strong>Recovery is not operational</strong>
        <span>
          This endpoint is an inspection scaffold. It is not proven to capture
          every failed row, and retry reconciliation cannot confirm re-delivery.
          Only the newest 100 records are returned; the service exposes no
          total, pagination, or truncation signal.
        </span>
      </div>
      {resource.error && resource.stale ? (
        <StaleInspection
          message={resource.error}
          onRetry={() => void resource.refresh()}
        />
      ) : null}
      {rows?.length === 0 ? (
        <div className="automations-inline-empty">
          <strong>No recovery rows returned</strong>
          <span>
            An empty response is not evidence that every row succeeded.
          </span>
        </div>
      ) : rows ? (
        <div
          className="automations-table-scroll"
          role="region"
          aria-label="Trigger recovery records"
          tabIndex={0}
        >
          <table className="data-table automations-responsive-table">
            <thead>
              <tr>
                <th scope="col">Entry</th>
                <th scope="col">Reason category</th>
                <th scope="col">Stored status</th>
                <th scope="col">Related data present</th>
                <th scope="col">Retries</th>
                <th scope="col">Created</th>
                {canAdmin ? <th scope="col">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((entry: SafeDLQRecord) => (
                <tr key={entry.id}>
                  <td data-label="Entry" className="tabular">
                    #{entry.id}
                  </td>
                  <td data-label="Reason category">
                    {dlqReasonLabel(entry.reason)}
                    {entry.lastErrorCategory
                      ? " · execution error recorded"
                      : ""}
                  </td>
                  <td data-label="Stored status">
                    <span className="badge">{entry.status}</span>
                  </td>
                  <td data-label="Related data present" className="muted">
                    {dlqPresenceLabel(entry)}
                  </td>
                  <td data-label="Retries" className="tabular">
                    {entry.retryCount}
                  </td>
                  <td data-label="Created" className="muted tabular">
                    {fmtRelative(entry.createdAt)}
                  </td>
                  {canAdmin ? (
                    <td data-label="Action">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        aria-disabled={!ZERO_COPY_DLQ_RECOVERY_AVAILABLE}
                        aria-describedby={unavailableReasonId}
                        onClick={() => {
                          if (!ZERO_COPY_DLQ_RECOVERY_AVAILABLE) return;
                        }}
                      >
                        Retry unavailable
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function firePresenceLabel(fire: SafeFireRecord): string {
  const labels = [
    fire.hasCursor ? "cursor" : null,
    fire.hasProfileKey ? "profile key" : null,
    fire.hasSubscriber ? "subscriber" : null,
    fire.hasPayload ? "payload" : null,
    fire.hasFlowRun ? "flow run" : null,
  ].filter((label): label is string => label !== null);
  return labels.length > 0 ? labels.join(", ") : "None reported";
}

function dlqPresenceLabel(entry: SafeDLQRecord): string {
  const labels = [
    entry.hasCursor ? "cursor" : null,
    entry.hasProfileKey ? "profile key" : null,
    entry.hasPayload ? "payload" : null,
  ].filter((label): label is string => label !== null);
  return labels.length > 0 ? labels.join(", ") : "None reported";
}

function dlqReasonLabel(reason: SafeDLQRecord["reason"]): string {
  switch (reason) {
    case "unresolved_subscriber":
      return "Subscriber unresolved";
    case "enqueue_failed":
      return "Enqueue failed";
    case "driver_partial_row":
      return "Incomplete warehouse row";
  }
}

function alertKindLabel(kind: SafeAlertConfig["lastAlertKind"]): string {
  switch (kind) {
    case "failures":
      return "Consecutive failures";
    case "lag":
      return "Polling lag";
    case "fires_burst":
      return "Rows-per-poll burst";
    default:
      return "Not recorded";
  }
}
