/**
 * Audit Sinks — external destinations for the audit-log stream.
 *
 * Two-tab layout:
 *
 *   Sinks               — list, create, edit (rename + rotate creds),
 *                         test, enable/disable, breaker reset, delete.
 *   Dead letter queue   — batches that failed delivery and need replay.
 *
 * The create + edit modals reuse a single `KindFieldSet` so the
 * canonical config/credentials shape per kind only lives in one place
 * (the `SINK_KINDS` table below). Credentials are sent over TLS,
 * envelope-encrypted server-side under the tenant's KEK, and never
 * returned to the UI.
 *
 * Auto-disable + circuit breaker semantics surfaced inline:
 *
 *   - `consecutive_failures / auto_disable_after` shows how close a
 *     failing sink is to being flipped off.
 *   - `circuit_state` is rendered as a health badge — when open the
 *     row offers a "Reset breaker" action so the operator can resume
 *     delivery without waiting for the cooldown.
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

import { ConfirmModal } from "../components/ConfirmModal";
import { Modal, ModalFooter } from "../components/Modal";
import { Notice } from "../components/Notice";
import { StatStrip, type StatCell } from "../components/StatStrip";
import { toast } from "../components/Toast";
import { ValuePropCard } from "../components/ValuePropCard";
import { AuditSinkReplayTab } from "../components/audit/AuditSinkReplayTab";
import {
  AuditSinkCircuitBadge,
  AuditSinkCircuitHealthLegend,
  AuditSinkCircuitRecoveryCountdown,
  AuditSinkDLQTable,
  AuditSinkFailureMeter,
  AuditSinkTable,
  formatAuditSinkRelative,
} from "../components/audit/AuditSinkTables";
import { OCSFMappingInfo } from "../components/audit/OCSFMappingInfo";
import {
  type AuditSinkKindSpec,
  FormField,
  KindFieldSet,
  OutputFormatSelector,
  SigningKeyPanel,
  WebhookFormatSelector,
} from "../components/audit/AuditSinkEditorPrimitives";
import { useAuditSinkDraftLifecycle } from "../hooks/useAuditSinkDraftLifecycle";
import { useBlockingLifecycleOperation } from "../hooks/useBlockingLifecycleOperation";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import {
  type AuditSink,
  type AuditSinkDLQEntry,
  type AuditSinkInput,
  type AuditSinkOutputFormat,
  type AuditSinkPatch,
  type AuditSinkWebhookFormat,
  api,
} from "../lib/api-client";
import { useAuditScopes } from "../lib/auditScopes";
import { useDesktopRouteTab } from "../lib/desktop-router";

type Kind = AuditSinkInput["kind"];

/* ---------- canonical kind config ---------- */

/** Canonical field inventory; exported for release-contract coverage. */
export const SINK_KINDS: AuditSinkKindSpec[] = [
  {
    value: "datadog",
    label: "Datadog",
    description:
      "Logs intake. The audit stream is shipped to https://http-intake.logs.<site>/api/v2/logs.",
    fields: [
      {
        key: "site",
        label: "Site",
        store: "config",
        type: "text",
        placeholder: "datadoghq.com",
        helpText:
          "Use datadoghq.eu for the EU region, us3.datadoghq.com for US3, etc.",
        required: true,
      },
      {
        key: "api_key",
        label: "API key",
        store: "credentials",
        type: "password",
        helpText: "Datadog → Organization Settings → API Keys.",
        helpUrl: "https://app.datadoghq.com/organization-settings/api-keys",
        tooltipText:
          "Encrypted at rest under your tenant KEK. Never returned to the UI after creation — use Rotate credentials to replace.",
        required: true,
      },
    ],
  },
  {
    value: "splunk",
    label: "Splunk HEC",
    description:
      "HTTP Event Collector. The full HEC URL including the /services/collector path.",
    fields: [
      {
        key: "hec_url",
        label: "HEC URL",
        store: "config",
        type: "text",
        placeholder: "https://hec.example.com:8088/services/collector",
        required: true,
      },
      {
        key: "index",
        label: "Index (optional)",
        store: "config",
        type: "text",
        placeholder: "audit",
        helpText: "Overrides the default index configured on the HEC token.",
      },
      {
        key: "token",
        label: "HEC token",
        store: "credentials",
        type: "password",
        helpText: "Splunk → Settings → Data Inputs → HTTP Event Collector.",
        tooltipText:
          "Encrypted at rest under your tenant KEK. Sent as Authorization: Splunk <token> on every batch.",
        required: true,
      },
    ],
  },
  {
    value: "s3",
    label: "AWS S3",
    description:
      "Newline-delimited JSON written under <prefix>/<tenant>/<from-id>-<to-id>.jsonl. Use S3 Lifecycle for retention.",
    fields: [
      {
        key: "region",
        label: "Region",
        store: "config",
        type: "text",
        placeholder: "us-east-1",
        required: true,
      },
      {
        key: "bucket",
        label: "Bucket",
        store: "config",
        type: "text",
        placeholder: "postwave-audit-prod",
        required: true,
      },
      {
        key: "prefix",
        label: "Key prefix",
        store: "config",
        type: "text",
        placeholder: "audit/",
        helpText: "Optional. Trailing slash recommended.",
      },
      {
        key: "aws_access_key_id",
        label: "Access key ID",
        store: "credentials",
        type: "text",
        placeholder: "AKIA...",
        required: true,
      },
      {
        key: "aws_secret_access_key",
        label: "Secret access key",
        store: "credentials",
        type: "password",
        helpText:
          "Scope the IAM policy down to s3:PutObject on this bucket+prefix only.",
        tooltipText:
          "Encrypted at rest under your tenant KEK. Moosewave only needs s3:PutObject — narrow the IAM policy to that one action.",
        required: true,
      },
    ],
  },
  {
    value: "archive",
    label: "Parquet archive (S3 + Object Lock)",
    description:
      "Daily Parquet files under tenant=X/year=YYYY/month=MM/day=DD.parquet. Written with S3 Object Lock (WORM). Choose retention from your approved records schedule; a framework name alone does not define it. Glue/Athena queryable.",
    fields: [
      {
        key: "region",
        label: "Region",
        store: "config",
        type: "text",
        placeholder: "us-east-1",
        required: true,
      },
      {
        key: "bucket",
        label: "Bucket (Object Lock enabled)",
        store: "config",
        type: "text",
        placeholder: "postwave-audit-archive",
        helpText:
          "Bucket must have Object Lock enabled at creation time — it cannot be turned on afterwards.",
        required: true,
      },
      {
        key: "prefix",
        label: "Key prefix",
        store: "config",
        type: "text",
        placeholder: "audit",
        helpText:
          "Defaults to 'audit'. Files land under <prefix>/tenant=<id>/year=YYYY/...",
      },
      {
        key: "retention_days",
        label: "Retention (days)",
        store: "config",
        type: "text",
        placeholder: "2555",
        helpText:
          "Object Lock retain-until = now + N days. Verify the duration with your legal and records owners before enabling COMPLIANCE mode; an object cannot be deleted before that date.",
      },
      {
        key: "object_lock_mode",
        label: "Object Lock mode",
        store: "config",
        type: "text",
        placeholder: "COMPLIANCE",
        helpText:
          "COMPLIANCE (default, irreversible) or GOVERNANCE (operators with s3:BypassGovernanceRetention can delete).",
      },
      {
        key: "aws_access_key_id",
        label: "Access key ID",
        store: "credentials",
        type: "text",
        placeholder: "AKIA...",
        required: true,
      },
      {
        key: "aws_secret_access_key",
        label: "Secret access key",
        store: "credentials",
        type: "password",
        helpText:
          "IAM policy should grant s3:PutObject + s3:PutObjectRetention + s3:PutObjectLegalHold on this bucket+prefix only.",
        tooltipText:
          "Encrypted at rest under your tenant KEK. Compliance teams: validate Object Lock is enabled on the bucket before first write.",
        required: true,
      },
    ],
  },
  {
    value: "http",
    label: "Generic HTTP",
    description:
      "POSTs a JSON envelope { sink, rows } to the configured URL. Optional Bearer or HMAC auth.",
    fields: [
      {
        key: "url",
        label: "URL",
        store: "config",
        type: "text",
        placeholder: "https://logs.example.com/ingest",
        helpText:
          "HTTPS strongly recommended. SSRF-safe transport rejects private IPs.",
        required: true,
      },
      {
        key: "bearer_token",
        label: "Bearer token (optional)",
        store: "credentials",
        type: "password",
      },
      {
        key: "hmac_secret",
        label: "HMAC secret (optional)",
        store: "credentials",
        type: "password",
        helpText:
          "When set, each request gets an X-Postwave-Signature: sha256=<hex> header over the body.",
        tooltipText:
          "Moosewave HMAC-SHA256-signs the JSON body and sends the hex digest in X-Postwave-Signature. Verify it on the receiver before trusting batches.",
      },
    ],
  },
  {
    value: "snowflake_shareback",
    label: "Snowflake Native App Shareback",
    description:
      "Zero-copy data share into the customer's Snowflake account. The Moosewave Native App polls a presigned S3 archive and COPIES INTO an external stage. See docs/marketplace/snowflake-native-app/ for install steps.",
    fields: [
      {
        key: "account_locator",
        label: "Account locator",
        store: "config",
        type: "text",
        placeholder: "xy12345.eu-central-1.aws",
        helpText:
          "Snowflake account locator, e.g. xy12345.eu-central-1.aws. Find it under Admin > Accounts in Snowsight.",
        required: true,
      },
      {
        key: "share_name",
        label: "Share name",
        store: "config",
        type: "text",
        placeholder: "POSTWAVE_AUDIT_SHARE",
        helpText:
          "Must match the share name the Native App's install script created.",
        required: true,
      },
      {
        key: "bucket",
        label: "Archive bucket",
        store: "config",
        type: "text",
        placeholder: "postwave-shareback-eu",
        helpText: "Moosewave-owned S3 bucket the Native App pulls from.",
        required: true,
      },
      {
        key: "region",
        label: "Region",
        store: "config",
        type: "text",
        placeholder: "eu-central-1",
        required: true,
      },
      {
        key: "prefix",
        label: "Key prefix",
        store: "config",
        type: "text",
        placeholder: "audit",
        helpText:
          "Optional. Layout: <prefix>/<account_locator>/<share_name>/<tenant>/<from>-<to>.jsonl",
      },
      {
        key: "aws_access_key_id",
        label: "Moosewave bucket access key",
        store: "credentials",
        type: "text",
        placeholder: "AKIA...",
        required: true,
      },
      {
        key: "aws_secret_access_key",
        label: "Moosewave bucket secret",
        store: "credentials",
        type: "password",
        helpText:
          "Writer credentials for the Moosewave-owned shareback bucket. The customer never sees these; the Native App reads via the SHARE.",
        tooltipText:
          "Encrypted at rest under your tenant KEK. Rotate independently of the Native App listing.",
        required: true,
      },
    ],
  },
  {
    value: "otlp_logs",
    label: "OpenTelemetry OTLP Logs",
    description:
      "Emits each audit row as an OTLP LogRecord (HTTP/JSON) to the configured collector. Attributes follow OCSF + OTel semantic conventions so SOC teams can correlate against other OTel signals.",
    fields: [
      {
        key: "endpoint",
        label: "Endpoint",
        store: "config",
        type: "text",
        placeholder: "https://otel-collector.example.com:4318",
        helpText:
          "OTLP/HTTP endpoint. Moosewave posts to <endpoint>/v1/logs. Use an OTel Collector to bridge to gRPC (4317) if you need it.",
        required: true,
      },
      {
        key: "service_name",
        label: "service.name (optional)",
        store: "config",
        type: "text",
        placeholder: "postwave-audit",
        helpText:
          "Sets the OTel resource attribute. Defaults to postwave-audit.",
      },
      {
        key: "compression",
        label: "Compression (optional)",
        store: "config",
        type: "text",
        placeholder: "gzip",
        helpText:
          "Allowed: gzip or none (default). zstd not currently supported.",
      },
      {
        key: "headers",
        label: "Extra headers (optional)",
        store: "config",
        type: "text",
        placeholder: "X-Tenant-ID: acme",
        helpText:
          "One 'Header: value' pair per line. Use for non-secret tenant routing hints (X-Org-ID, etc.).",
      },
      {
        key: "bearer_token",
        label: "Bearer token (optional)",
        store: "credentials",
        type: "password",
        helpText: "Sent as Authorization: Bearer <token> on every batch.",
        tooltipText:
          "Encrypted at rest under your tenant KEK. Use this for collector tenant authentication.",
      },
      {
        key: "api_key",
        label: "API key (optional)",
        store: "credentials",
        type: "password",
        helpText:
          "Sent as X-API-Key on every batch (Grafana Cloud, NewRelic, etc.).",
      },
    ],
  },
];

function getKindSpec(kind: Kind): AuditSinkKindSpec {
  return SINK_KINDS.find((k) => k.value === kind) ?? SINK_KINDS[0];
}

/* ---------- page ---------- */

type TabKey = "sinks" | "dlq" | "replay";
const AUDIT_SINK_TABS = [
  { value: "sinks" },
  { value: "dlq" },
  { value: "replay" },
] as const;

function AuditSinkTabs({
  value,
  sinkCount,
  dlqCount,
  onChange,
  children,
}: {
  value: TabKey;
  sinkCount: number;
  dlqCount: number;
  onChange: (value: TabKey) => void;
  children: ReactNode;
}): ReactElement {
  const tabs = useTabsInteraction({
    activation: "manual",
    value,
    items: AUDIT_SINK_TABS,
    onChange,
  });
  return (
    <>
      <div
        ref={tabs.listRef}
        className="tabbar"
        {...tabs.listProps}
        aria-label="Audit sink sections"
        style={{ marginBottom: 12 }}
      >
        <button
          type="button"
          {...tabs.getTabProps("sinks")}
          className={value === "sinks" ? "tab active" : "tab"}
        >
          Sinks <span className="muted">({sinkCount})</span>
        </button>
        <button
          type="button"
          {...tabs.getTabProps("dlq")}
          className={value === "dlq" ? "tab active" : "tab"}
        >
          Dead letter queue{" "}
          {dlqCount > 0 ? (
            <span className="badge warning" style={{ marginLeft: 4 }}>
              {dlqCount}
            </span>
          ) : (
            <span className="muted">(0)</span>
          )}
        </button>
        <button
          type="button"
          {...tabs.getTabProps("replay")}
          className={value === "replay" ? "tab active" : "tab"}
          aria-describedby="audit-sink-replay-tab-help"
        >
          Replay
        </button>
      </div>
      <p id="audit-sink-replay-tab-help" className="muted small">
        Replay queues a signed, cursor-based job for an audit-log ID range.
      </p>
      {AUDIT_SINK_TABS.filter((item) => item.value !== value).map((item) => (
        <section key={item.value} {...tabs.getPanelProps(item.value)} />
      ))}
      <section {...tabs.getPanelProps(value)}>{children}</section>
    </>
  );
}

function buildAuditSinkStats(sinks: AuditSink[], dlqCount: number): StatCell[] {
  const enabledCount = sinks.filter((sink) => sink.enabled).length;
  const totalFailureWeight = sinks.reduce(
    (total, sink) =>
      total + sink.consecutive_failures / Math.max(1, sink.auto_disable_after),
    0,
  );
  const failurePercent =
    sinks.length > 0
      ? Math.round((totalFailureWeight / sinks.length) * 100)
      : 0;
  const breakerCount = sinks.filter(
    (sink) => sink.circuit_state !== "closed",
  ).length;
  return [
    {
      label: "Configured sinks",
      value: sinks.length > 0 ? sinks.length.toString() : "—",
      hint: "Total destinations receiving the audit stream.",
    },
    {
      label: "Enabled",
      value: sinks.length > 0 ? `${enabledCount} / ${sinks.length}` : "—",
      hint: "Sinks currently set to receive deliveries.",
    },
    {
      label: "Health load",
      value: sinks.length > 0 ? `${failurePercent}%` : "—",
      delta:
        sinks.length > 0
          ? failurePercent >= 50
            ? { direction: "down", text: "elevated" }
            : failurePercent >= 20
              ? { direction: "flat", text: "watch" }
              : { direction: "up", text: "healthy" }
          : null,
      hint: "Weighted % of the auto-disable budget consumed across all sinks.",
    },
    {
      label: "DLQ size",
      value: dlqCount.toLocaleString(),
      delta:
        breakerCount > 0
          ? { direction: "down", text: `${breakerCount} open breaker(s)` }
          : null,
      hint: "Failed batches awaiting replay.",
    },
  ];
}

export function AuditSinks(): ReactElement {
  // The role-shaped `isAdmin` flag is presentation metadata, not an audit
  // permission wildcard. A workspace administrator can have either grant
  // removed, and the server enforces that revocation. Keep every renderer
  // affordance on the same explicit scope boundary; `hasScope` still honours
  // the literal legacy/API-key `admin` scope that the server treats as a
  // wildcard.
  const auditScopeState = useAuditScopes();
  const canConfigureSinks = auditScopeState.hasScope("audit:configure_sinks");
  const canExecuteActions = auditScopeState.hasScope("audit:execute_actions");
  // Existing table and slideover props use this historical name for the
  // configure capability. Keep the local alias while preserving the stricter
  // meaning above.
  const canAdmin = canConfigureSinks;
  const [tab, setTab] = useDesktopRouteTab<TabKey>(
    "auditSinks",
    ["sinks", "dlq", "replay"],
    "sinks",
  );
  const [rows, setRows] = useState<AuditSink[] | null>(null);
  const [dlq, setDlq] = useState<AuditSinkDLQEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<AuditSink | null>(null);
  const [detailFor, setDetailFor] = useState<AuditSink | null>(null);
  const [deleting, setDeleting] = useState<AuditSink | null>(null);
  const loadSinks = async (): Promise<void> => {
    const res = await api.auditSinksList();
    if (res.error) {
      setErr(res.error.message);
      setRows([]);
      return;
    }
    setErr(null);
    setRows(res.data?.sinks ?? []);
  };

  const loadDLQ = async (): Promise<void> => {
    const res = await api.auditSinkDLQList();
    if (res.error) {
      // DLQ failures shouldn't blow up the page — just don't render the tab content.
      setDlq([]);
      return;
    }
    setDlq(res.data?.entries ?? []);
  };

  const reload = async (): Promise<void> => {
    setLoading(true);
    await Promise.all([loadSinks(), loadDLQ()]);
    setLoading(false);
  };

  useEffect(() => {
    void reload();
  }, []);

  // If a detail slideover is open and we just reloaded, refresh its
  // row from the new list so e.g. breaker state updates after reset.
  useEffect(() => {
    if (!detailFor || !rows) return;
    const fresh = rows.find((r) => r.id === detailFor.id);
    if (fresh && fresh !== detailFor) setDetailFor(fresh);
  }, [rows, detailFor]);

  const sinkCount = rows?.length ?? 0;
  const dlqCount = dlq?.length ?? 0;

  // Hoisted so it's never called conditionally (useMemo inside a tab
  // branch trips react-hooks/rules-of-hooks).
  const sinksById = useMemo(() => {
    const m = new Map<string, AuditSink>();
    (rows ?? []).forEach((r) => m.set(r.id, r));
    return m;
  }, [rows]);

  // Aggregate KPIs use only the already-fetched sink and DLQ rows.
  const stats = useMemo(
    () => buildAuditSinkStats(rows ?? [], dlq?.length ?? 0),
    [rows, dlq],
  );

  return (
    <div className="page page-with-pad">
      <div className="page-header">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
          }}
        >
          <div>
            <h1>Audit sinks</h1>
            <p className="muted" style={{ fontSize: 13, maxWidth: 720 }}>
              Stream the audit log to S3, Datadog, Splunk, or a generic HTTPS
              endpoint. Sinks auto-disable after 100 consecutive failures and
              short-circuit to a dead-letter queue after 10 — replay from the
              DLQ tab once the upstream is healthy.
            </p>
          </div>
          {canAdmin && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (!canConfigureSinks) return;
                setShowCreate(true);
              }}
              aria-disabled={!canConfigureSinks || undefined}
              aria-describedby={
                !canConfigureSinks ? "audit-sinks-scope-banner" : undefined
              }
            >
              + New sink {canConfigureSinks ? "" : "🔒"}
            </button>
          )}
        </div>
        {/* rbac-meta-audit: header banner so the operator sees which
            scopes are missing without having to click a disabled
            button to find out. */}
        {!canExecuteActions && canAdmin ? (
          <div
            className="muted small"
            style={{ marginTop: 4 }}
            data-testid="audit-sinks-scope-banner"
          >
            DLQ replay requires audit:execute_actions. Circuit reset requires
            audit:configure_sinks.
          </div>
        ) : null}
      </div>

      {err ? (
        <Notice
          tone="danger"
          title="Couldn’t load audit sinks"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void reload()}
            >
              Retry
            </button>
          }
        >
          {err}
        </Notice>
      ) : null}

      <div style={{ margin: "12px 0 16px" }}>
        <StatStrip cells={stats} />
      </div>

      {/* Inline value-prop near the empty/create surface — explains
          the durability semantics so operators don't worry about lost
          events while their SIEM is briefly unreachable. */}
      {(rows?.length ?? 0) === 0 && canAdmin && (
        <ValuePropCard
          title="Reliable SIEM streaming, by design"
          body="Moosewave streams every audit event with at-least-once delivery, signed batches, and exponential-backoff retries. Failed batches land in the DLQ for replay — nothing is silently dropped."
        />
      )}

      <AuditSinkTabs
        value={tab}
        sinkCount={sinkCount}
        dlqCount={dlqCount}
        onChange={setTab}
      >
        {tab === "sinks" ? (
          <AuditSinkTable
            rows={rows}
            loading={loading}
            canAdmin={canAdmin}
            onCreate={() => setShowCreate(true)}
            onOpen={(s) => setDetailFor(s)}
            onToggle={async (s) => {
              const res = await api.auditSinkPatch(s.id, {
                enabled: !s.enabled,
              });
              if (res.error) {
                toast.error(res.error.message);
                return;
              }
              await loadSinks();
            }}
            onResetCircuit={async (s) => {
              const res = await api.auditSinkCircuitReset(s.id);
              if (res.error) {
                toast.error(res.error.message);
                return;
              }
              toast.success("Breaker reset");
              await loadSinks();
            }}
          />
        ) : tab === "dlq" ? (
          <AuditSinkDLQTable
            entries={dlq}
            loading={loading}
            sinksById={sinksById}
            canAdmin={canExecuteActions}
            onReplay={async (entry) => {
              const res = await api.auditSinkDLQReplay(entry.id);
              if (res.error) {
                toast.error(res.error.message);
                return;
              }
              toast.success(`Replayed ${res.data?.rows ?? 0} rows`);
              await Promise.all([loadDLQ(), loadSinks()]);
            }}
            onAfterBulkReplay={async () => {
              await Promise.all([loadDLQ(), loadSinks()]);
            }}
          />
        ) : (
          <AuditSinkReplayTab
            sinks={rows ?? []}
            canExecute={canExecuteActions}
          />
        )}
      </AuditSinkTabs>

      {showCreate && (
        <CreateSinkModal
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await reload();
          }}
        />
      )}

      {editing && (
        <EditSinkModal
          key={editing.id}
          sink={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await loadSinks();
          }}
        />
      )}

      {detailFor && (
        <SinkDetailSlideover
          sink={detailFor}
          dlqForSink={(dlq ?? []).filter((d) => d.sink_id === detailFor.id)}
          canAdmin={canAdmin}
          onClose={() => setDetailFor(null)}
          onEdit={() => {
            // Keep the slideover mounted behind the edit modal so
            // cancel returns to the detail view instead of dropping
            // the operator back on the bare list.
            setEditing(detailFor);
          }}
          onDelete={() => {
            // Same pattern for delete: confirm dialog stacks on top
            // of the slideover. On success the parent's load() clears
            // the sink and the slideover unmounts naturally because
            // detailFor no longer matches any row.
            setDeleting(detailFor);
          }}
          onToggle={async () => {
            const res = await api.auditSinkPatch(detailFor.id, {
              enabled: !detailFor.enabled,
            });
            if (res.error) {
              toast.error(res.error.message);
              return;
            }
            await loadSinks();
          }}
          onResetCircuit={async () => {
            const res = await api.auditSinkCircuitReset(detailFor.id);
            if (res.error) {
              toast.error(res.error.message);
              return;
            }
            toast.success("Breaker reset");
            await loadSinks();
          }}
          onTest={async () => {
            const res = await api.auditSinkTestExisting(detailFor.id);
            if (res.error) {
              toast.error(`Test failed: ${res.error.message}`);
              return;
            }
            toast.success("Test event delivered");
          }}
        />
      )}

      {deleting && (
        <DeleteSinkModal
          sink={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

/* ---------- create modal ---------- */

/** @internal Exported for focused lifecycle behavior tests. */
export function CreateSinkModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
}): ReactElement {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("datadog");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [kindSwitchTarget, setKindSwitchTarget] = useState<Kind | null>(null);
  const [outputFormat, setOutputFormat] =
    useState<AuditSinkOutputFormat>("postwave_native");
  const [webhookFormat, setWebhookFormat] =
    useState<AuditSinkWebhookFormat>("postwave_v1");
  const operationRef = useRef(false);

  const spec = getKindSpec(kind);
  const operationActive = busy || testing;
  const fieldDraftDirty =
    hasPopulatedValues(config) || hasPopulatedValues(credentials);
  const draftDirty =
    name.length > 0 ||
    kind !== "datadog" ||
    fieldDraftDirty ||
    outputFormat !== "postwave_native" ||
    webhookFormat !== "postwave_v1";

  const zeroizeDraft = useCallback((): void => {
    setName("");
    setConfig({});
    setCredentials({});
    setErrors({});
  }, []);

  const discardAndClose = useCallback((): void => {
    if (operationRef.current) return;
    zeroizeDraft();
    setDiscardConfirmOpen(false);
    setKindSwitchTarget(null);
    onClose();
  }, [onClose, zeroizeDraft]);

  const requestClose = (): void => {
    if (operationRef.current || operationActive) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    zeroizeDraft();
    onClose();
  };

  useAuditSinkDraftLifecycle({
    ownerId: "audit-sink-create",
    draftLabel: "New audit sink draft",
    operationLabel: "Audit sink create or test",
    dirty: draftDirty,
    operationActive,
    operationRef,
    onDiscard: discardAndClose,
  });

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Name is required";
    for (const f of spec.fields) {
      if (!f.required) continue;
      const v = (f.store === "config" ? config : credentials)[f.key] ?? "";
      if (!v.trim()) e[f.key] = `${f.label} is required`;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const buildInput = (): AuditSinkInput => ({
    kind,
    name: name.trim(),
    enabled: true,
    config: { ...config },
    credentials: { ...credentials },
    output_format: outputFormat,
    // webhook_format is only meaningful for kind=http; the server
    // ignores it on other kinds, but we send it consistently so the
    // create response echoes back the selected value.
    webhook_format: webhookFormat,
  });

  const create = async (): Promise<void> => {
    if (operationRef.current || !validate()) return;
    operationRef.current = true;
    setBusy(true);
    setDiscardConfirmOpen(false);
    try {
      const res = await api.auditSinkCreate(buildInput());
      if (res.error) {
        toast.error(res.error.message);
        return;
      }
      setCredentials({});
      toast.success("Sink created");
      await onCreated();
    } catch {
      toast.error("The audit sink couldn't be created. Try again.");
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    if (operationRef.current || !validate()) return;
    operationRef.current = true;
    setTesting(true);
    setDiscardConfirmOpen(false);
    try {
      const res = await api.auditSinkTest(buildInput());
      if (res.error) {
        toast.error(`Test failed: ${res.error.message}`);
        return;
      }
      toast.success("Test event delivered — credentials look good");
    } catch {
      toast.error("The test request couldn't be completed. Try again.");
    } finally {
      operationRef.current = false;
      setTesting(false);
    }
  };

  const applyKind = (next: Kind): void => {
    setKind(next);
    setConfig({});
    setCredentials({});
    setErrors({});
    setKindSwitchTarget(null);
  };

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        closeOnBackdrop={!operationActive}
        closeOnEscape={!operationActive}
        closeDisabled={operationActive}
        title="New audit sink"
        description="Configure a destination, send a test event to validate credentials, then create."
      >
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <FormField label="Name" error={errors.name} required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Datadog prod"
              autoComplete="off"
              aria-label="Name"
              disabled={operationActive}
            />
          </FormField>

          <FormField label="Destination" required>
            <select
              value={kind}
              aria-label="Destination"
              disabled={operationActive}
              onChange={(e) => {
                const next = e.target.value as Kind;
                if (next === kind) return;
                if (fieldDraftDirty) setKindSwitchTarget(next);
                else applyKind(next);
              }}
            >
              {SINK_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {spec.description}
            </p>
          </FormField>

          <KindFieldSet
            spec={spec}
            config={config}
            credentials={credentials}
            errors={errors}
            setConfig={setConfig}
            setCredentials={setCredentials}
            disabled={operationActive}
          />

          <FormField label="Output format">
            <OutputFormatSelector
              value={outputFormat}
              onChange={setOutputFormat}
              idPrefix="create"
              disabled={operationActive}
            />
            <OCSFMappingInfo format={outputFormat} />
          </FormField>

          {kind === "http" ? (
            <FormField label="Webhook signature format">
              <WebhookFormatSelector
                value={webhookFormat}
                onChange={setWebhookFormat}
                idPrefix="create"
                disabled={operationActive}
              />
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {webhookFormat === "standard_webhooks"
                  ? "Standard Webhooks (RFC 9499): webhook-id, webhook-timestamp, webhook-signature: v1,<base64>. Required by Microsoft Sentinel CCF, Splunk Cloud SIEM."
                  : "Legacy Moosewave header: X-Postwave-Signature: sha256=<hex(hmac(secret, body))>. Kept for back-compat with existing receivers."}
              </p>
            </FormField>
          ) : null}

          <ModalFooter>
            <button
              type="button"
              onClick={requestClose}
              disabled={operationActive}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void test()}
              disabled={busy || testing}
              aria-label="Send one canary audit event using these credentials"
            >
              {testing ? "Testing…" : "Test delivery"}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || testing}
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </ModalFooter>
        </form>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard this audit sink draft?"
        description="The configuration has not been saved. Write-only credentials will be cleared from this device."
        confirmLabel="Discard sink draft"
        danger
        busy={operationActive}
        onClose={() => setDiscardConfirmOpen(false)}
        onConfirm={discardAndClose}
      />
      <ConfirmModal
        open={kindSwitchTarget !== null}
        title="Discard destination fields and switch?"
        description="Changing destination clears the current configuration and every write-only credential field."
        confirmLabel="Discard fields and switch"
        danger
        busy={operationActive}
        onClose={() => setKindSwitchTarget(null)}
        onConfirm={() => {
          if (kindSwitchTarget) applyKind(kindSwitchTarget);
        }}
      />
    </>
  );
}

/* ---------- edit modal ---------- */

/** @internal Exported for focused lifecycle behavior tests. */
export function EditSinkModal({
  sink,
  onClose,
  onSaved,
}: {
  sink: AuditSink;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): ReactElement {
  const spec = getKindSpec(sink.kind);
  const [name, setName] = useState(sink.name);
  const [config, setConfig] = useState<Record<string, string>>(() =>
    coerceToStringMap(sink.config),
  );
  const [rotating, setRotating] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [signingKeyBusy, setSigningKeyBusy] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [rotationDiscardConfirmOpen, setRotationDiscardConfirmOpen] =
    useState(false);
  const [outputFormat, setOutputFormat] = useState<AuditSinkOutputFormat>(
    sink.output_format ?? "postwave_native",
  );
  const [webhookFormat, setWebhookFormat] = useState<AuditSinkWebhookFormat>(
    sink.webhook_format ?? "postwave_v1",
  );
  const initialConfigRef = useRef(coerceToStringMap(sink.config));
  const operationRef = useRef(false);
  const operationActive = busy || signingKeyBusy;
  const credentialsDirty = hasPopulatedValues(credentials);
  const draftDirty =
    name !== sink.name ||
    !stringMapsEqual(config, initialConfigRef.current) ||
    rotating ||
    credentialsDirty ||
    outputFormat !== (sink.output_format ?? "postwave_native") ||
    webhookFormat !== (sink.webhook_format ?? "postwave_v1");

  const zeroizeCredentials = useCallback((): void => {
    setCredentials({});
  }, []);

  const discardAndClose = useCallback((): void => {
    if (operationRef.current || signingKeyBusy) return;
    zeroizeCredentials();
    setName("");
    setConfig({});
    setErrors({});
    setRotating(false);
    setDiscardConfirmOpen(false);
    setRotationDiscardConfirmOpen(false);
    onClose();
  }, [onClose, signingKeyBusy, zeroizeCredentials]);

  const requestClose = (): void => {
    if (operationRef.current || operationActive) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    zeroizeCredentials();
    onClose();
  };

  useAuditSinkDraftLifecycle({
    ownerId: `audit-sink-edit-${sink.id}`,
    draftLabel: `Changes to ${sink.name}`,
    operationLabel: "Audit sink update or key rotation",
    dirty: draftDirty,
    operationActive,
    operationRef,
    onDiscard: discardAndClose,
  });

  const save = async (): Promise<void> => {
    if (operationRef.current || signingKeyBusy) return;
    const validationErrors = getEditSinkErrors(
      spec,
      name,
      config,
      rotating,
      credentials,
    );
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    const patch = buildEditSinkPatch({
      sink,
      name,
      config,
      rotating,
      credentials,
      outputFormat,
      webhookFormat,
    });
    operationRef.current = true;
    setBusy(true);
    setDiscardConfirmOpen(false);
    try {
      const res = await api.auditSinkPatch(sink.id, patch);
      if (res.error) {
        toast.error(res.error.message);
        return;
      }
      zeroizeCredentials();
      toast.success(
        rotating ? "Sink updated · credentials rotated" : "Sink updated",
      );
      await onSaved();
    } catch {
      toast.error("The audit sink couldn't be updated. Try again.");
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  const stopRotating = (): void => {
    zeroizeCredentials();
    setRotating(false);
    setRotationDiscardConfirmOpen(false);
    setErrors({});
  };

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        closeOnBackdrop={!operationActive}
        closeOnEscape={!operationActive}
        closeDisabled={operationActive}
        title={`Edit ${sink.name}`}
        description="Rename, edit non-secret config, or rotate credentials. Kind cannot be changed — delete + recreate if you need a different destination."
      >
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <FormField label="Name" error={errors.name} required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              aria-label="Name"
              disabled={operationActive}
            />
          </FormField>

          <FormField label="Destination">
            <input type="text" value={spec.label} disabled />
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {spec.description}
            </p>
          </FormField>

          {/* Only render non-secret config fields in edit mode. Credentials
            live under their own "Rotate" toggle so the operator has to
            opt into rotation explicitly. */}
          {spec.fields
            .filter((f) => f.store === "config")
            .map((f) => (
              <FormField
                key={f.key}
                label={f.label}
                helpText={f.helpText}
                helpUrl={f.helpUrl}
                tooltipText={f.tooltipText}
                required={f.required}
                error={errors[f.key]}
              >
                <input
                  type="text"
                  value={config[f.key] ?? ""}
                  placeholder={f.placeholder}
                  autoComplete="off"
                  aria-label={f.label}
                  disabled={operationActive}
                  onChange={(e) =>
                    setConfig({ ...config, [f.key]: e.target.value })
                  }
                />
              </FormField>
            ))}

          <div
            style={{
              borderTop: "1px solid var(--pw-border)",
              marginTop: 16,
              paddingTop: 16,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <input
                type="checkbox"
                checked={rotating}
                disabled={operationActive}
                onChange={(e) => {
                  if (e.target.checked) {
                    setRotating(true);
                  } else if (credentialsDirty) {
                    setRotationDiscardConfirmOpen(true);
                  } else {
                    stopRotating();
                  }
                }}
              />
              <span>
                <strong>Rotate credentials</strong>{" "}
                <span className="muted" style={{ fontSize: 12 }}>
                  — DLQ + breaker state are preserved
                </span>
              </span>
            </label>
            {rotating && (
              <KindFieldSet
                spec={spec}
                config={{}}
                credentials={credentials}
                errors={errors}
                setConfig={() => {
                  /* config fields hidden in rotate mode */
                }}
                setCredentials={setCredentials}
                credentialsOnly
                disabled={operationActive}
              />
            )}
          </div>

          <FormField label="Output format">
            <OutputFormatSelector
              value={outputFormat}
              onChange={setOutputFormat}
              idPrefix={`edit-${sink.id}`}
              disabled={operationActive}
            />
            <OCSFMappingInfo format={outputFormat} />
          </FormField>

          {sink.kind === "http" ? (
            <>
              <FormField label="Webhook signature format">
                <WebhookFormatSelector
                  value={webhookFormat}
                  onChange={setWebhookFormat}
                  idPrefix={`edit-${sink.id}`}
                  disabled={operationActive}
                />
                <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {webhookFormat === "standard_webhooks"
                    ? "RFC 9499 / standardwebhooks.com headers. Sentinel CCF & Splunk Cloud SIEM use this."
                    : "Legacy Moosewave header. Existing receivers keep working without a change."}
                </p>
              </FormField>
              <SigningKeyPanel
                sink={sink}
                onOperationChange={setSigningKeyBusy}
              />
            </>
          ) : null}

          <ModalFooter>
            <button
              type="button"
              onClick={requestClose}
              disabled={operationActive}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={operationActive}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </ModalFooter>
        </form>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard audit sink changes?"
        description="Unsaved configuration changes will be lost. Any write-only replacement credentials will be cleared from this device."
        confirmLabel="Discard changes"
        danger
        busy={operationActive}
        onClose={() => setDiscardConfirmOpen(false)}
        onConfirm={discardAndClose}
      />
      <ConfirmModal
        open={rotationDiscardConfirmOpen}
        title="Discard replacement credentials?"
        description="Turning off credential rotation clears every replacement credential currently entered. Stored server credentials are not changed."
        confirmLabel="Discard credentials"
        danger
        busy={operationActive}
        onClose={() => setRotationDiscardConfirmOpen(false)}
        onConfirm={stopRotating}
      />
    </>
  );
}

/* ---------- detail slideover ---------- */

function SinkDetailSlideover({
  sink,
  dlqForSink,
  canAdmin,
  onClose,
  onEdit,
  onDelete,
  onToggle,
  onResetCircuit,
  onTest,
}: {
  sink: AuditSink;
  dlqForSink: AuditSinkDLQEntry[];
  canAdmin: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => Promise<void>;
  onResetCircuit: () => Promise<void>;
  onTest: () => Promise<void>;
}): ReactElement {
  const spec = getKindSpec(sink.kind);
  const [testing, setTesting] = useState(false);
  // Per-action busy state so a double-click on Pause / Resume / Reset
  // doesn't fire two PATCH requests in flight. Each handler short-
  // circuits while its own toggle is already in motion.
  const [toggling, setToggling] = useState(false);
  const [resetting, setResetting] = useState(false);
  const actionRef = useRef(false);
  const instanceId = useId();
  const operationActive = testing || toggling || resetting;

  useBlockingLifecycleOperation(
    `audit-sink-detail-${sink.id}-${instanceId}`,
    `Audit sink operation for ${sink.name}`,
    operationActive,
    "Wait for the audit sink action to finish before leaving Moosewave.",
  );

  const runAction = async (
    setActive: (active: boolean) => void,
    action: () => Promise<void>,
  ): Promise<void> => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActive(true);
    try {
      await action();
    } catch {
      toast.error("The audit sink action couldn't be completed. Try again.");
    } finally {
      actionRef.current = false;
      setActive(false);
    }
  };

  return (
    <>
      <div
        className="slideover-overlay"
        onClick={() => {
          if (!operationActive) onClose();
        }}
        aria-hidden="true"
      />
      <div
        className="slideover"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-sink-slideover-title"
      >
        <button
          type="button"
          className="slideover-close"
          onClick={onClose}
          disabled={operationActive}
          aria-label="Close"
        >
          ×
        </button>
        <div
          id="audit-sink-slideover-title"
          className="page-title"
          style={{ fontSize: 16 }}
        >
          {sink.name}
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          <span className="badge">{sink.kind}</span>{" "}
          {sink.enabled ? (
            <span className="badge success">enabled</span>
          ) : (
            <span className="badge warning">disabled</span>
          )}{" "}
          <AuditSinkCircuitBadge sink={sink} />
        </div>

        <div>
          <div className="label">Last delivery</div>
          <div style={{ fontSize: 13 }}>
            {sink.last_success_at ? (
              <>
                {formatAuditSinkRelative(sink.last_success_at)}{" "}
                <span className="muted" style={{ fontSize: 12 }}>
                  ({sink.last_success_at})
                </span>
              </>
            ) : (
              <span className="muted">never</span>
            )}
          </div>
        </div>

        {sink.last_failure_at && (
          <div>
            <div className="label">Last failure</div>
            <div style={{ fontSize: 13 }}>
              {formatAuditSinkRelative(sink.last_failure_at)}{" "}
              <span className="muted" style={{ fontSize: 12 }}>
                ({sink.last_failure_at})
              </span>
            </div>
            {sink.last_error && (
              <pre
                className="mono"
                style={{
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  background: "var(--pw-bg-elev)",
                  padding: 8,
                  borderRadius: 4,
                  marginTop: 4,
                }}
              >
                {sink.last_error}
              </pre>
            )}
          </div>
        )}

        <div>
          <div className="label">Failures before auto-disable</div>
          <AuditSinkFailureMeter
            pct={Math.min(
              100,
              Math.round(
                (sink.consecutive_failures /
                  Math.max(1, sink.auto_disable_after)) *
                  100,
              ),
            )}
            label={`${sink.consecutive_failures} / ${sink.auto_disable_after}`}
          />
        </div>

        {sink.circuit_state !== "closed" && sink.cooldown_until && (
          <Notice tone="warning">
            Circuit is <strong>{sink.circuit_state.replace("_", "-")}</strong>.
            Next probe {formatAuditSinkRelative(sink.cooldown_until)}.{" "}
            {/* sse-pinned-tail (Audit UX, P1): auto-recovery countdown.
                Live ticker so the operator sees "Reopens in 47s" rather
                than a static absolute timestamp. */}
            <AuditSinkCircuitRecoveryCountdown until={sink.cooldown_until} />
            {canAdmin && (
              <>
                {" "}
                <button
                  type="button"
                  className="link-button"
                  disabled={operationActive}
                  onClick={() => {
                    void runAction(setResetting, onResetCircuit);
                  }}
                >
                  {resetting ? "Resetting…" : "Reset breaker now"}
                </button>
              </>
            )}
          </Notice>
        )}

        {/* sse-pinned-tail (Audit UX, P1): circuit-state legend tooltip
            + history timeline. Helps operators triage "what does
            half-open mean again?" without bouncing to docs. */}
        <AuditSinkCircuitHealthLegend sink={sink} />

        <div>
          <div className="label">Configuration</div>
          <table className="data-table" style={{ width: "100%", fontSize: 12 }}>
            <tbody>
              {spec.fields
                .filter((f) => f.store === "config")
                .map((f) => (
                  <tr key={f.key}>
                    <td className="muted" style={{ width: "40%" }}>
                      {f.label}
                    </td>
                    <td className="mono">
                      {String(sink.config?.[f.key] ?? "—") || "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            Credentials are encrypted at rest and never returned to the UI. Use
            Edit → Rotate credentials to replace them.
          </p>
        </div>

        {dlqForSink.length > 0 && (
          <Notice tone="warning">
            <strong>{dlqForSink.length}</strong> pending DLQ{" "}
            {dlqForSink.length === 1 ? "entry" : "entries"} for this sink.
            Switch to the Dead letter queue tab to replay.
          </Notice>
        )}

        {canAdmin && (
          <>
            <div className="label" style={{ marginTop: 16 }}>
              Actions
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                disabled={operationActive}
                onClick={() => {
                  void runAction(setTesting, onTest);
                }}
              >
                {testing ? "Sending…" : "Send test event"}
              </button>
              <button
                type="button"
                disabled={operationActive}
                onClick={() => {
                  void runAction(setToggling, onToggle);
                }}
              >
                {toggling
                  ? "Working…"
                  : sink.enabled
                    ? "Pause delivery"
                    : "Resume delivery"}
              </button>
              <button type="button" onClick={onEdit} disabled={operationActive}>
                Edit / rotate credentials
              </button>
            </div>

            <div
              style={{
                marginTop: 24,
                paddingTop: 16,
                borderTop: "1px solid var(--pw-border)",
              }}
            >
              <div className="label" style={{ color: "var(--pw-danger)" }}>
                Danger zone
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Deletes the sink, its encrypted credentials, and abandons any
                pending DLQ entries. This cannot be undone.
              </p>
              <button
                type="button"
                className="btn btn-danger"
                onClick={onDelete}
                disabled={operationActive}
              >
                Delete sink
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/* ---------- delete (type-to-confirm) ---------- */

function DeleteSinkModal({
  sink,
  onClose,
  onDeleted,
}: {
  sink: AuditSink;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}): ReactElement {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const operationRef = useRef(false);
  const instanceId = useId();
  const matches = text.trim() === sink.name;

  useBlockingLifecycleOperation(
    `audit-sink-delete-${sink.id}-${instanceId}`,
    `Deleting audit sink ${sink.name}`,
    busy,
    "Wait for audit sink deletion to finish before leaving Moosewave.",
  );

  const destroy = async (): Promise<void> => {
    if (!matches || operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    try {
      const res = await api.auditSinkDelete(sink.id);
      if (res.error) {
        toast.error(res.error.message);
        return;
      }
      setText("");
      toast.success("Sink deleted");
      await onDeleted();
    } catch {
      toast.error("The audit sink couldn't be deleted. Try again.");
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      title="Delete audit sink"
      description="This permanently removes the sink, its encrypted credentials, and any pending DLQ entries."
    >
      <p style={{ fontSize: 13 }}>
        Type <strong>{sink.name}</strong> to confirm deletion.
      </p>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoComplete="off"
        placeholder={sink.name}
      />
      <ModalFooter>
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!matches || busy}
          onClick={() => void destroy()}
        >
          {busy ? "Deleting…" : "Delete sink"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

/* ---------- helpers ---------- */

function getEditSinkErrors(
  spec: AuditSinkKindSpec,
  name: string,
  config: Record<string, string>,
  rotating: boolean,
  credentials: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = "Name is required";
  for (const field of spec.fields) {
    if (!field.required) continue;
    if (field.store === "credentials" && !rotating) continue;
    const values = field.store === "config" ? config : credentials;
    if (!(values[field.key] ?? "").trim()) {
      errors[field.key] = `${field.label} is required`;
    }
  }
  return errors;
}

interface EditSinkPatchDraft {
  sink: AuditSink;
  name: string;
  config: Record<string, string>;
  rotating: boolean;
  credentials: Record<string, string>;
  outputFormat: AuditSinkOutputFormat;
  webhookFormat: AuditSinkWebhookFormat;
}

function buildEditSinkPatch({
  sink,
  name,
  config,
  rotating,
  credentials,
  outputFormat,
  webhookFormat,
}: EditSinkPatchDraft): AuditSinkPatch {
  const patch: AuditSinkPatch = {};
  if (name.trim() !== sink.name) patch.name = name.trim();
  const nextConfig: Record<string, unknown> = { ...config };
  // The worker-owned cursor is intentionally absent from the form but must
  // survive the server's full config replacement on every edit.
  if (sink.config.cursor != null) nextConfig.cursor = sink.config.cursor;
  patch.config = nextConfig;
  if (rotating) patch.credentials = { ...credentials };
  if (outputFormat !== (sink.output_format ?? "postwave_native")) {
    patch.output_format = outputFormat;
  }
  if (webhookFormat !== (sink.webhook_format ?? "postwave_v1")) {
    patch.webhook_format = webhookFormat;
  }
  return patch;
}

function hasPopulatedValues(values: Record<string, string>): boolean {
  return Object.values(values).some((value) => value.length > 0);
}

function stringMapsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? "") !== (right[key] ?? "")) return false;
  }
  return true;
}

function coerceToStringMap(
  input: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v == null) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean")
      out[k] = String(v);
    // Skip nested objects — `cursor` is a number stored by the worker
    // inside config; it's not user-editable, so we don't echo it back
    // into the edit form. The server's PATCH does a full replace of
    // config, but the cursor lives under a JSONB key we don't touch.
  }
  // Drop the worker-managed cursor so the edit form never shows it.
  delete out.cursor;
  return out;
}
