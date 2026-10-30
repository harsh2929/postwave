import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { botOpensApi } from "../../lib/api-client";
import type { BotOpenSignature, BotOpenStats } from "../../lib/api/bot-opens";
import { Icon } from "../Icon";
import { Notice } from "../Notice";
import {
  parseBotOpenSignatures,
  parseBotOpenStats,
} from "./sending-control-response-contract";

import "../../styles-deliverability-controls.css";

interface SurfaceState<T> {
  data: T | null;
  loading: boolean;
  failed: boolean;
}

const INITIAL_SURFACE = { data: null, loading: true, failed: false } as const;
const NUM = new Intl.NumberFormat();
const PCT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});
const MAX_VISIBLE_SIGNATURES = 50;
const MAX_VISIBLE_BREAKDOWN_ROWS = 20;

export function BotOpenSignaturesPanel(): ReactElement {
  const [stats, setStats] =
    useState<SurfaceState<BotOpenStats>>(INITIAL_SURFACE);
  const [signatures, setSignatures] =
    useState<SurfaceState<BotOpenSignature[]>>(INITIAL_SURFACE);
  const statsRequestRef = useRef(0);
  const signaturesRequestRef = useRef(0);
  const mountedRef = useRef(true);

  const loadStats = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    const requestId = ++statsRequestRef.current;
    setStats((current) => ({ ...current, loading: true, failed: false }));
    try {
      const result = await botOpensApi.stats();
      if (!mountedRef.current || requestId !== statsRequestRef.current) return;
      const parsed = result.error ? null : parseBotOpenStats(result.data);
      setStats((current) =>
        parsed
          ? { data: parsed, loading: false, failed: false }
          : { ...current, loading: false, failed: true },
      );
    } catch {
      if (mountedRef.current && requestId === statsRequestRef.current) {
        setStats((current) => ({ ...current, loading: false, failed: true }));
      }
    }
  }, []);

  const loadSignatures = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    const requestId = ++signaturesRequestRef.current;
    setSignatures((current) => ({ ...current, loading: true, failed: false }));
    try {
      const result = await botOpensApi.listSignatures();
      if (!mountedRef.current || requestId !== signaturesRequestRef.current) {
        return;
      }
      const parsed = result.error ? null : parseBotOpenSignatures(result.data);
      setSignatures((current) =>
        parsed
          ? { data: parsed, loading: false, failed: false }
          : { ...current, loading: false, failed: true },
      );
    } catch {
      if (mountedRef.current && requestId === signaturesRequestRef.current) {
        setSignatures((current) => ({
          ...current,
          loading: false,
          failed: true,
        }));
      }
    }
  }, []);

  const refreshAll = useCallback((): void => {
    void loadStats();
    void loadSignatures();
  }, [loadSignatures, loadStats]);

  useEffect(() => {
    mountedRef.current = true;
    refreshAll();
    return () => {
      mountedRef.current = false;
      statsRequestRef.current += 1;
      signaturesRequestRef.current += 1;
    };
  }, [refreshAll]);

  const refreshing = stats.loading || signatures.loading;
  return (
    <section
      className="dhw-control-evidence dhw-bot-opens"
      aria-labelledby="dhw-bot-opens-title"
    >
      <header>
        <span className="dhw-control-evidence-icon">
          <Icon name="eye" size={17} />
        </span>
        <div>
          <small>Engagement classification</small>
          <h3 id="dhw-bot-opens-title">Bot-open evidence</h3>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={refreshAll}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh evidence"}
        </button>
      </header>

      <p className="dhw-control-evidence-summary">
        Separates recorded human opens from known prefetchers, image proxies,
        scanners, and link-unfurling agents. Classification is evidence, not a
        guarantee of human attention.
      </p>

      <Notice
        tone="neutral"
        announcement="off"
        title="Read-only rule inventory"
      >
        Signature creation and deletion stay outside this panel until the
        service can preview validation impact and provide a rollback-safe
        mutation receipt.
      </Notice>

      <EvidenceError
        failed={stats.failed}
        retained={stats.data !== null}
        label="Open-classification statistics"
        loading={stats.loading}
        onRetry={loadStats}
      />
      <StatsEvidence state={stats} />

      <EvidenceError
        failed={signatures.failed}
        retained={signatures.data !== null}
        label="Signature inventory"
        loading={signatures.loading}
        onRetry={loadSignatures}
      />
      <SignatureEvidence state={signatures} />
    </section>
  );
}

function EvidenceError({
  failed,
  retained,
  label,
  loading,
  onRetry,
}: {
  failed: boolean;
  retained: boolean;
  label: string;
  loading: boolean;
  onRetry: () => Promise<void>;
}): ReactElement | null {
  if (!failed) return null;
  return (
    <div className="dhw-control-evidence-error" role="alert">
      <Icon name="alert-triangle" size={16} />
      <span>
        {label} could not be verified.
        {retained ? " The last verified data remains visible." : ""}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void onRetry()}
        disabled={loading}
      >
        Retry
      </button>
    </div>
  );
}

function StatsEvidence({
  state,
}: {
  state: SurfaceState<BotOpenStats>;
}): ReactElement | null {
  if (state.loading && !state.data) {
    return (
      <div className="dhw-bot-stats-skeleton" aria-busy="true">
        {[0, 1, 2, 3].map((item) => (
          <div className="skel" key={item} />
        ))}
        <span className="visually-hidden" role="status">
          Loading bot-open statistics
        </span>
      </div>
    );
  }
  if (!state.data) return null;

  const stats = state.data;
  const classified = stats.human_opens + stats.bot_opens;
  const consistent = classified <= stats.total_opens;
  const visibleBreakdown = stats.by_signature.slice(
    0,
    MAX_VISIBLE_BREAKDOWN_ROWS,
  );
  const since = validDateLabel(stats.since);
  return (
    <section className="dhw-bot-stats" aria-labelledby="dhw-bot-stats-title">
      <div className="dhw-control-subhead">
        <div>
          <h4 id="dhw-bot-stats-title">Observed open split</h4>
          <p>
            {since
              ? "Events reported since " + since + "."
              : "Window start unverified."}{" "}
            No closing snapshot time is supplied by this response.
          </p>
        </div>
        {state.loading ? <span role="status">Refreshing…</span> : null}
      </div>

      {!consistent ? (
        <Notice tone="warning" announcement="polite">
          The classified counts exceed total opens. Counts remain visible as
          received, but the percentage is withheld until the service reconciles
          them.
        </Notice>
      ) : null}

      <dl className="dhw-bot-stat-grid">
        <Stat label="Total opens" value={NUM.format(stats.total_opens)} />
        <Stat
          label="Human classified"
          value={NUM.format(stats.human_opens)}
          tone="healthy"
        />
        <Stat
          label="Bot / prefetch"
          value={NUM.format(stats.bot_opens)}
          tone="warning"
        />
        <Stat
          label="Bot share"
          value={
            consistent && stats.total_opens > 0
              ? PCT.format(stats.bot_opens / stats.total_opens)
              : "—"
          }
        />
      </dl>

      {visibleBreakdown.length > 0 ? (
        <div className="dhw-bot-breakdown">
          <h5>Bot-classified opens by matching label</h5>
          <ul>
            {visibleBreakdown.map((bucket, index) => (
              <li key={bucket.label + "-" + String(index)}>
                <span>
                  {boundedText(bucket.label, 96, "Unlabelled signature")}
                </span>
                <strong>{NUM.format(bucket.opens)}</strong>
              </li>
            ))}
          </ul>
          {stats.by_signature.length > visibleBreakdown.length ? (
            <p>
              Showing {visibleBreakdown.length.toLocaleString()} of{" "}
              {stats.by_signature.length.toLocaleString()} reported labels.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="dhw-bot-empty-line">
          No per-signature classification rows were returned for this window.
        </p>
      )}
    </section>
  );
}

function SignatureEvidence({
  state,
}: {
  state: SurfaceState<BotOpenSignature[]>;
}): ReactElement | null {
  if (state.loading && !state.data) {
    return (
      <div className="dhw-control-evidence-skeleton" aria-busy="true">
        <div className="skel" />
        <div className="skel" />
        <span className="visually-hidden" role="status">
          Loading bot-open signature inventory
        </span>
      </div>
    );
  }
  if (!state.data) return null;

  const visible = state.data.slice(0, MAX_VISIBLE_SIGNATURES);
  return (
    <section
      className="dhw-bot-signatures"
      aria-labelledby="dhw-bot-signatures-title"
    >
      <div className="dhw-control-subhead">
        <div>
          <h4 id="dhw-bot-signatures-title">
            Classification signatures ({state.data.length.toLocaleString()})
          </h4>
          <p>
            Patterns are bounded previews; no hover is required to read them.
          </p>
        </div>
        {state.loading ? <span role="status">Refreshing…</span> : null}
      </div>

      {visible.length > 0 ? (
        <ul>
          {visible.map((signature) => (
            <SignatureRow key={signature.id} signature={signature} />
          ))}
        </ul>
      ) : (
        <div className="dhw-control-evidence-empty">
          <Icon name="eye-off" size={18} />
          <div>
            <strong>No signatures returned</strong>
            <p>
              No conclusion was drawn about whether classification is active.
            </p>
          </div>
        </div>
      )}
      {state.data.length > visible.length ? (
        <p className="dhw-bot-list-limit">
          Showing the first {visible.length.toLocaleString()} of{" "}
          {state.data.length.toLocaleString()} signatures to keep this workspace
          responsive.
        </p>
      ) : null}
    </section>
  );
}

function SignatureRow({
  signature,
}: {
  signature: BotOpenSignature;
}): ReactElement {
  return (
    <li className="dhw-bot-signature" data-enabled={signature.enabled}>
      <div className="dhw-bot-signature-copy">
        <strong>
          {boundedText(signature.label, 96, "Unlabelled signature")}
        </strong>
        <span>{boundedText(signature.kind, 48, "Unknown kind")}</span>
      </div>
      <div className="dhw-bot-signature-badges">
        <span data-tone={signature.enabled ? "healthy" : "neutral"}>
          {signature.enabled ? "Enabled" : "Disabled"}
        </span>
        <span>{signature.is_default ? "Built-in" : "Workspace"}</span>
      </div>
      <div className="dhw-bot-pattern">
        <small>Bounded match preview</small>
        <code>{patternPreview(signature.pattern)}</code>
      </div>
    </li>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "healthy" | "warning" | "neutral";
}): ReactElement {
  return (
    <div data-tone={tone}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function patternPreview(value: string): string {
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�").trim();
  if (!safe) return "(empty pattern)";
  if (safe.length <= 72) return safe;
  return safe.slice(0, 44) + "…" + safe.slice(-16);
}

function boundedText(value: string, maximum: number, fallback: string): string {
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  if (!safe) return fallback;
  if (safe.length <= maximum) return safe;
  return safe.slice(0, Math.max(1, maximum - 1)) + "…";
}

function validDateLabel(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}
