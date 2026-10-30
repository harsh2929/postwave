import {
  type CSSProperties,
  type ReactElement,
  useEffect,
  useState,
} from "react";

import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { Icon, type IconName } from "../Icon";
import { Notice } from "../Notice";
import { VerificationBulkPanel } from "./VerificationBulkPanel";
import { VerificationPanel } from "./VerificationPanel";
import { ActionCenter } from "./ActionCenter";
import { AuthChecksMatrixCard } from "./AuthChecksMatrixCard";
import { BlocklistAutoSuppressCard } from "./BlocklistAutoSuppressCard";
import { BlocklistHitsTable } from "./BlocklistHitsTable";
import { BotOpenSignaturesPanel } from "./BotOpenSignaturesPanel";
import { BounceClassBreakdownChart } from "./BounceClassBreakdownChart";
import { CampaignOptionsProvider } from "./CampaignSelect";
import { DeliverabilityControlPanel } from "./DeliverabilityControlPanel";
import { DiagnosticianCard } from "./DiagnosticianCard";
import { DnsHealthTable } from "./DnsHealthTable";
import { DomainWarmupPanel } from "./DomainWarmupPanel";
import { EqScoreLookupCard } from "./EqScoreLookupCard";
import { FeedbackHistoryPanel } from "./FeedbackHistoryPanel";
import { HygienePlaybooks } from "./HygienePlaybooks";
import { IntelligentRetryCard } from "./IntelligentRetryCard";
import { IspBreakdownCard } from "./IspBreakdownCard";
import { PlacementReportCard } from "./PlacementReportCard";
import { ProviderConfigCard } from "./ProviderConfigCard";
import { ReplyMailboxCard } from "./ReplyMailboxCard";
import { ScoreCard } from "./ScoreCard";
import { SnapshotHistoryCard } from "./SnapshotHistoryCard";
import { SoftBounceRecoveryCard } from "./SoftBounceRecoveryCard";
import { SpamTrapGuardCard } from "./SpamTrapGuardCard";
import { WebhookErrorsTable } from "./WebhookErrorsTable";
import {
  deliverabilityRefreshReceipt,
  type DeliverabilityHubData,
  type DeliverabilitySurfaceKey,
} from "../../pages/useDeliverabilityHubData";
import { setSection } from "../../lib/store";

export type DeliverabilityHubTab =
  | "overview"
  | "identity"
  | "controls"
  | "recovery"
  | "diagnostics"
  | "verification";

interface TabDefinition {
  value: DeliverabilityHubTab;
  label: string;
  description: string;
  icon: IconName;
}

export const DELIVERABILITY_HUB_TABS: readonly TabDefinition[] = [
  {
    value: "overview",
    label: "Overview",
    description: "Risk and priorities",
    icon: "chart-bars",
  },
  {
    value: "identity",
    label: "Identity & providers",
    description: "DNS and infrastructure",
    icon: "shield-check",
  },
  {
    value: "controls",
    label: "Sending controls",
    description: "Guardrails and policy",
    icon: "lock",
  },
  {
    value: "recovery",
    label: "Recovery",
    description: "Failures and repair",
    icon: "clock",
  },
  {
    value: "diagnostics",
    label: "Diagnostics",
    description: "Explain and validate",
    icon: "mail",
  },
  {
    value: "verification",
    label: "Verification",
    description: "List hygiene before you send",
    icon: "shield-check",
  },
] as const;

export const DELIVERABILITY_HUB_TAB_VALUES = DELIVERABILITY_HUB_TABS.map(
  ({ value }) => value,
);

const TAB_HEADINGS: Record<
  DeliverabilityHubTab,
  { eyebrow: string; title: string; description: string }
> = {
  overview: {
    eyebrow: "Prioritize",
    title: "Reputation at a glance",
    description:
      "Start with current risk, then move from evidence to the smallest safe corrective action.",
  },
  identity: {
    eyebrow: "Authenticate",
    title: "Identity and provider health",
    description:
      "Verify the infrastructure recipients use to decide whether a message belongs in the inbox.",
  },
  controls: {
    eyebrow: "Protect",
    title: "Sending guardrails",
    description:
      "Inspect warmup, filtering, routing, volume policy, and automatic suppression before changing traffic.",
  },
  recovery: {
    eyebrow: "Recover",
    title: "Failure evidence and repair",
    description:
      "Trace rejected or risky traffic, understand what automation caught, and verify recovery outcomes.",
  },
  diagnostics: {
    eyebrow: "Investigate",
    title: "Placement diagnostics",
    description:
      "Compare ISP, authentication, seed-test, and message-level evidence without guessing at root cause.",
  },
  verification: {
    eyebrow: "Prevent",
    title: "Email verification",
    description:
      "Catch undeliverable addresses and spam traps before you send to them, rather than learning from the bounce.",
  },
};

interface Props {
  data: DeliverabilityHubData;
  tab: DeliverabilityHubTab;
  onTabChange: (tab: DeliverabilityHubTab) => void;
}

export function DeliverabilityHubWorkspace({
  data,
  tab,
  onTabChange,
}: Props): ReactElement {
  const [visited, setVisited] = useState<Record<DeliverabilityHubTab, boolean>>(
    () => ({
      overview: tab === "overview",
      identity: tab === "identity",
      controls: tab === "controls",
      recovery: tab === "recovery",
      diagnostics: tab === "diagnostics",
      verification: tab === "verification",
    }),
  );
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: DELIVERABILITY_HUB_TABS,
    onChange: onTabChange,
  });

  useEffect(() => {
    setVisited((current) =>
      current[tab] ? current : { ...current, [tab]: true },
    );
  }, [tab]);

  const heading = TAB_HEADINGS[tab];
  const staleSurfaces = staleSurfaceLabels(data);
  const summaryError = data.errors.summary;

  return (
    <div className="dhw-page" aria-busy={data.loading || undefined}>
      <DeliverabilityHero data={data} />

      {summaryError ? (
        <Notice
          tone={data.summary ? "warning" : "danger"}
          announcement="assertive"
          action={<RefreshButton data={data} compact />}
        >
          {data.summary
            ? "The newest score could not be verified. The last verified score remains visible."
            : summaryError}
        </Notice>
      ) : null}
      {staleSurfaces.length > 0 ? (
        <Notice tone="warning" announcement="polite">
          Some evidence could not refresh. Last verified data remains visible
          where available: {staleSurfaces.join(", ")}.
        </Notice>
      ) : null}

      <nav className="dhw-workspaces" aria-label="Deliverability workspaces">
        <div
          ref={tabs.listRef}
          className="dhw-tabs"
          {...tabs.listProps}
          aria-label="Deliverability workspaces"
        >
          {DELIVERABILITY_HUB_TABS.map((item, index) => (
            <button
              key={item.value}
              type="button"
              {...tabs.getTabProps(item.value)}
              className={tab === item.value ? "is-active" : undefined}
            >
              <span className="dhw-tab-index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="dhw-tab-icon" aria-hidden="true">
                <Icon name={item.icon} size={16} />
              </span>
              <span className="dhw-tab-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </div>
      </nav>

      <section className="dhw-workspace-heading" aria-live="polite">
        <div>
          <span>{heading.eyebrow}</span>
          <h2>{heading.title}</h2>
        </div>
        <p>{heading.description}</p>
      </section>

      {DELIVERABILITY_HUB_TABS.map(({ value }) =>
        visited[value] || value === tab ? (
          <section
            key={value}
            className="dhw-panel"
            {...tabs.getPanelProps(value)}
          >
            <DeliverabilityPanel
              tab={value}
              data={data}
              active={value === tab}
              onTabChange={onTabChange}
            />
          </section>
        ) : null,
      )}
    </div>
  );
}

function DeliverabilityHero({ data }: { data: DeliverabilityHubData }) {
  const summary = data.summary;
  const sampleQualified = summary?.sample_qualified ?? false;
  const score = summary && sampleQualified ? Math.round(summary.score) : null;
  const scoreAngle = `${Math.max(0, Math.min(100, score ?? 0)) * 3.6}deg`;
  const breachCount =
    summary?.breaches.filter(({ severity }) => severity !== "info").length ?? 0;
  const criticalCount =
    summary?.breaches.filter(({ severity }) => severity === "critical")
      .length ?? 0;
  const statusTone =
    criticalCount > 0 || (score !== null && score < 50)
      ? "danger"
      : summary !== null && !sampleQualified
        ? "neutral"
        : breachCount > 0 || (score !== null && score < 75)
          ? "warning"
          : score === null
            ? "neutral"
            : "healthy";
  const ringStyle = {
    "--dhw-score-angle": scoreAngle,
  } as CSSProperties & Record<"--dhw-score-angle", string>;

  return (
    <header className="dhw-hero" data-tone={statusTone}>
      <div className="dhw-hero-copy">
        <div className="dhw-kicker">
          <span className="dhw-kicker-mark">
            <Icon name="shield-check" size={16} />
          </span>
          Deliverability command center
        </div>
        <h1>Protect every send before reputation pays the price.</h1>
        <p>
          One operational path from identity and recipient feedback to policy,
          recovery, and placement evidence—using independently refreshed,
          contract-checked evidence from each service.
        </p>
        <div className="dhw-hero-actions">
          <RefreshButton data={data} />
          <span className="dhw-freshness" role="status" aria-live="polite">
            <i aria-hidden="true" />
            {deliverabilityRefreshReceipt(data)}
          </span>
        </div>
        <dl className="dhw-hero-facts">
          <Metric
            label="7-day sends"
            value={number(summary?.totals.sends_7d)}
          />
          <Metric
            label="Active signals"
            value={summary ? String(breachCount) : "—"}
          />
          <Metric label="Bounce rate" value={percent(summary?.bounce_rate)} />
          <Metric
            label="Complaint rate"
            value={percent(summary?.complaint_rate)}
          />
        </dl>
      </div>

      <div
        className="dhw-model"
        aria-label={
          sampleQualified
            ? "Latest computed reputation score"
            : "Deliverability model evidence qualification"
        }
      >
        <div className="dhw-model-head">
          <span>
            {sampleQualified
              ? "Latest computed score"
              : "Evidence qualification"}
          </span>
          <span className={`dhw-state dhw-state-${statusTone}`}>
            {summary?.auto_throttled
              ? "Repair active"
              : summary?.status ||
                (data.initialLoading ? "Loading" : "Unverified")}
          </span>
        </div>
        <div className="dhw-model-body">
          <div className="dhw-score-ring" style={ringStyle}>
            <div>
              <strong>{score ?? "—"}</strong>
              <small>
                {summary && !sampleQualified
                  ? "sample pending"
                  : score === null
                    ? "No score"
                    : "out of 100"}
              </small>
            </div>
          </div>
          <div className="dhw-model-summary">
            <span>Reputation grade</span>
            <strong>{sampleQualified ? summary?.grade || "—" : "N/A"}</strong>
            <small>
              {scoreNarrative(
                score,
                criticalCount,
                breachCount,
                summary?.totals.sends_30d,
                summary?.minimum_sample_sends,
              )}
            </small>
          </div>
        </div>
        <div
          className="dhw-signal-path"
          aria-label="Deliverability decision path"
        >
          <SignalStep
            label="Identity"
            state={data.dns === null ? "pending" : "observed"}
          />
          <i aria-hidden="true" />
          <SignalStep
            label="Signals"
            state={
              summary === null
                ? "pending"
                : sampleQualified
                  ? "observed"
                  : "attention"
            }
          />
          <i aria-hidden="true" />
          <SignalStep
            label="Policy"
            state={
              summary?.auto_throttled
                ? "attention"
                : summary
                  ? "observed"
                  : "pending"
            }
          />
          <i aria-hidden="true" />
          <SignalStep
            label="Send"
            state={
              summary === null
                ? "pending"
                : sampleQualified
                  ? "observed"
                  : "attention"
            }
          />
        </div>
        <p className="dhw-model-provenance">
          {summary?.computed_at ? (
            <>
              Current campaign-cohort model · computed{" "}
              <time dateTime={summary.computed_at}>
                {dateTime(summary.computed_at)}
              </time>
            </>
          ) : (
            "Awaiting a verified computation timestamp"
          )}
        </p>
      </div>
    </header>
  );
}

function DeliverabilityPanel({
  tab,
  data,
  active,
  onTabChange,
}: {
  tab: DeliverabilityHubTab;
  data: DeliverabilityHubData;
  active: boolean;
  onTabChange: (tab: DeliverabilityHubTab) => void;
}): ReactElement {
  if (tab === "verification") {
    return (
      <div className="stack-lg">
        <VerificationPanel />
        <VerificationBulkPanel />
      </div>
    );
  }
  if (tab === "overview") {
    return <OverviewPanel data={data} onTabChange={onTabChange} />;
  }
  if (tab === "identity") return <IdentityPanel data={data} />;
  if (tab === "controls") return <ControlsPanel />;
  if (tab === "recovery") return <RecoveryPanel data={data} active={active} />;
  return <DiagnosticsPanel />;
}

function OverviewPanel({
  data,
  onTabChange,
}: {
  data: DeliverabilityHubData;
  onTabChange: (tab: DeliverabilityHubTab) => void;
}) {
  return (
    <div className="dhw-stack">
      <div className="dhw-grid dhw-grid-feature">
        <ScoreCard
          summary={data.summary}
          loading={data.initialLoading}
          onRepaired={() => void data.refresh()}
        />
        <ActionCenter
          breaches={data.summary?.breaches ?? null}
          loading={data.loading && data.summary === null}
          unavailable={Boolean(data.errors.summary && data.summary === null)}
          onOpenHubEvidence={() => onTabChange("identity")}
        />
      </div>
      <RemoteSurface title="Score history" surface="history" data={data}>
        <SnapshotHistoryCard
          data={data.history}
          loading={data.loading && data.history === null}
        />
      </RemoteSurface>
    </div>
  );
}

function IdentityPanel({ data }: { data: DeliverabilityHubData }) {
  return (
    <div className="dhw-stack">
      <div className="dhw-grid dhw-grid-halves">
        <RemoteSurface title="DNS health" surface="dns" data={data}>
          <DnsHealthTable
            rows={data.dns}
            loading={data.loading && data.dns === null}
          />
        </RemoteSurface>
        <RemoteSurface
          title="Blocklist observations"
          surface="hits"
          data={data}
        >
          <BlocklistHitsTable
            rows={data.hits}
            loading={data.loading && data.hits === null}
          />
        </RemoteSurface>
      </div>
      <ComponentShell
        title="Provider connections"
        description="Configure the infrastructure used to collect and act on deliverability evidence."
      >
        <ProviderConfigCard />
      </ComponentShell>
      <ComponentShell
        title="Reply capture"
        description="Inspect and manage the IMAP sources behind campaign reply ingestion."
      >
        <ReplyMailboxCard />
      </ComponentShell>
    </div>
  );
}

function ControlsPanel() {
  return (
    <div className="dhw-stack">
      <div className="dhw-grid dhw-grid-thirds">
        <ComponentShell>
          <DomainWarmupPanel />
        </ComponentShell>
        <ComponentShell>
          <BotOpenSignaturesPanel />
        </ComponentShell>
        <ComponentShell>
          <DeliverabilityControlPanel />
        </ComponentShell>
      </div>
      <div className="dhw-grid dhw-grid-halves">
        <CanonicalOwnerCard />
        <HygienePlaybooks />
      </div>
      <BlocklistAutoSuppressCard />
    </div>
  );
}

function RecoveryPanel({
  data,
  active,
}: {
  data: DeliverabilityHubData;
  active: boolean;
}) {
  return (
    <div className="dhw-stack">
      <div className="dhw-grid dhw-grid-halves">
        <SpamTrapGuardCard />
        <SoftBounceRecoveryCard />
      </div>
      <IntelligentRetryCard />
      <div className="dhw-grid dhw-grid-halves">
        <RemoteSurface title="Webhook failures" surface="webhooks" data={data}>
          <WebhookErrorsTable
            rows={data.webhookErrors}
            loading={data.loading && data.webhookErrors === null}
          />
        </RemoteSurface>
        <RemoteSurface title="Bounce classes" surface="bounces" data={data}>
          <BounceClassBreakdownChart
            data={data.bounces}
            loading={data.loading && data.bounces === null}
          />
        </RemoteSurface>
      </div>
      <ComponentShell
        title="Subscriber evidence"
        description="Look up the exact bounce and complaint trail behind a recipient-level decision."
      >
        <FeedbackHistoryPanel active={active} />
      </ComponentShell>
    </div>
  );
}

function DiagnosticsPanel() {
  return (
    <CampaignOptionsProvider>
      <div className="dhw-stack">
        <IspBreakdownCard />
        <div className="dhw-grid dhw-grid-halves">
          <AuthChecksMatrixCard />
          <PlacementReportCard />
        </div>
        <DiagnosticianCard />
        <EqScoreLookupCard />
      </div>
    </CampaignOptionsProvider>
  );
}

function RemoteSurface({
  title,
  surface,
  data,
  children,
}: {
  title: string;
  surface: DeliverabilitySurfaceKey;
  data: DeliverabilityHubData;
  children: ReactElement;
}): ReactElement {
  const error = data.errors[surface];
  const hasData = surfaceHasData(surface, data);
  if (error && !hasData) {
    return (
      <div className="dhw-surface-error">
        <span className="dhw-error-icon">
          <Icon name="alert-triangle" size={17} />
        </span>
        <div>
          <strong>{title} unavailable</strong>
          <p>{error}</p>
        </div>
        <RefreshButton data={data} compact />
      </div>
    );
  }
  return children;
}

function ComponentShell({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactElement;
}) {
  return (
    <section className="dhw-component-shell">
      {title ? (
        <header>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

function CanonicalOwnerCard(): ReactElement {
  return (
    <section className="card dhw-canonical-owner">
      <span>
        <Icon name="arrow-up-right" size={17} />
      </span>
      <div>
        <small>Canonical policy owner</small>
        <h3>Frequency caps live in Sending settings</h3>
        <p>
          Keep cross-channel limits in one authoring surface. Return here to
          inspect their effect alongside reputation evidence.
        </p>
      </div>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setSection("sending")}
      >
        Open Sending settings <Icon name="chevron-right" size={13} />
      </button>
    </section>
  );
}

function RefreshButton({
  data,
  compact = false,
}: {
  data: DeliverabilityHubData;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={compact ? "btn btn-sm" : "btn dhw-refresh"}
      onClick={() => void data.refresh()}
      disabled={data.loading || data.identityPending}
    >
      <span
        className={
          data.loading ? "dhw-refresh-glyph is-spinning" : "dhw-refresh-glyph"
        }
        aria-hidden="true"
      >
        ↻
      </span>
      {data.loading ? "Refreshing…" : compact ? "Retry" : "Refresh evidence"}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SignalStep({
  label,
  state,
}: {
  label: string;
  state: "pending" | "observed" | "attention";
}) {
  return (
    <span data-state={state}>
      <b aria-hidden="true" />
      {label}
    </span>
  );
}

function staleSurfaceLabels(data: DeliverabilityHubData): string[] {
  const labels: Record<DeliverabilitySurfaceKey, string> = {
    summary: "score",
    history: "history",
    dns: "DNS health",
    hits: "blocklists",
    webhooks: "webhook failures",
    bounces: "bounce classes",
  };
  return (Object.keys(data.errors) as DeliverabilitySurfaceKey[])
    .filter((key) => key !== "summary" && surfaceHasData(key, data))
    .map((key) => labels[key]);
}

function surfaceHasData(
  surface: DeliverabilitySurfaceKey,
  data: DeliverabilityHubData,
): boolean {
  if (surface === "summary") return data.summary !== null;
  if (surface === "history") return data.history !== null;
  if (surface === "dns") return data.dns !== null;
  if (surface === "hits") return data.hits !== null;
  if (surface === "webhooks") return data.webhookErrors !== null;
  return data.bounces !== null;
}

function number(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "—"
    : `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "at an unverified time"
    : date.toLocaleString();
}

function scoreNarrative(
  score: number | null,
  criticalCount: number,
  breachCount: number,
  sampleSize?: number,
  minimumSampleSize?: number,
): string {
  if (
    score === null &&
    sampleSize !== undefined &&
    minimumSampleSize !== undefined
  ) {
    return `${sampleSize.toLocaleString()} of ${minimumSampleSize.toLocaleString()} campaign sends required for rate scoring.`;
  }
  if (score === null) return "No verified score is available yet.";
  if (criticalCount > 0)
    return `${criticalCount} critical signal${criticalCount === 1 ? "" : "s"} need review.`;
  if (breachCount > 0)
    return `${breachCount} active signal${breachCount === 1 ? "" : "s"} should be triaged.`;
  return "No active threshold breach in this snapshot.";
}
