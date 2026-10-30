import type { ReactElement } from "react";

import { Icon } from "../../components/Icon";
import { TraceRequestLookup } from "../../components/audit/TraceRequestLookup";
import type { AuditPageController } from "./useAuditPageController";

export function getAuditHeaderSubtitle(
  controller: AuditPageController,
): string {
  const { phase, rows, totalCount, totalConfidence, stats } = controller.data;
  if (phase === "hard-error") return "Evidence window unavailable";
  if (rows && totalCount !== null) {
    const approximation = totalConfidence === "approximate" ? "~" : "";
    const rangeStart = rows.length === 0 ? 0 : 1;
    return `Showing ${rangeStart}-${rows.length.toLocaleString()} of ${approximation}${totalCount.toLocaleString()}`;
  }
  if (rows && stats && typeof stats.totalEvents === "number") {
    return `${stats.totalEvents.toLocaleString()} events in this result window`;
  }
  if (rows) return `${rows.length.toLocaleString()} loaded events`;
  return "Loading evidence window…";
}

export function AuditPageHeader({
  controller,
}: {
  controller: AuditPageController;
}): ReactElement {
  const { data } = controller;
  const refreshPending = data.loading || data.refreshing;
  const stale = data.stale;

  return (
    <header className="audit-masthead" aria-labelledby="audit-page-title">
      <div className="audit-masthead-glow" aria-hidden="true" />
      <div className="audit-masthead-heading">
        <div className="audit-masthead-eyebrow">
          <span className="audit-masthead-eyebrow-icon">
            <Icon name="shield-check" size={15} />
          </span>
          Investigation workspace
        </div>
        <h1 id="audit-page-title" className="audit-masthead-title">
          Audit log
        </h1>
        <p className="audit-masthead-subtitle">
          Reconstruct who changed what, when it happened, and which request
          connected the evidence.
        </p>
        <div className="audit-masthead-context" aria-label="Result context">
          <span
            className="audit-result-window"
            data-testid="audit-pagination-header"
          >
            <Icon name="chart-bars" size={14} />
            {getAuditHeaderSubtitle(controller)}
          </span>
          <span className="audit-evidence-scope">
            <Icon name="lock" size={14} />
            Private evidence
          </span>
        </div>
      </div>

      <div className="audit-command-deck">
        <div className="audit-trace-slot">
          <div className="audit-command-label">Trace a known request</div>
          <p className="audit-command-hint">
            Start with an exact request ID from an error, response, or log line.
          </p>
          <TraceRequestLookup />
        </div>

        <div
          className="audit-monitoring-panel"
          aria-label="Audit monitoring controls"
        >
          <div className="audit-monitoring-heading">
            <span className="audit-command-label">Snapshot health</span>
            <span className="audit-monitoring-mode">Manual refresh</span>
          </div>
          <div className="audit-monitoring-controls">
            <button
              type="button"
              className="btn btn-sm audit-refresh-action"
              onClick={() => void data.load()}
              disabled={refreshPending}
              aria-describedby="audit-refresh-status"
            >
              <Icon name="clock" size={14} />
              {refreshPending ? "Refreshing…" : "Refresh now"}
            </button>
          </div>
          <p
            id="audit-monitor-description"
            className="audit-monitoring-note"
            role="note"
          >
            Live streaming is on release hold until reconnects can resume from a
            server cursor without skipping evidence. Refresh reloads the current
            event page; totals and summaries are companion reads and may settle
            independently.
          </p>
          <p
            id="audit-refresh-status"
            className="audit-refresh-status"
            role="status"
            aria-live="polite"
          >
            {refreshPending
              ? stale
                ? "Retrying while the last verified rows remain visible."
                : "Refreshing the current result window."
              : stale
                ? `Refresh failed. Last verified rows remain visible; last successful refresh was ${data.refreshAgeLabel}.`
                : `Last refreshed ${data.refreshAgeLabel}.`}
          </p>
        </div>
      </div>
    </header>
  );
}

export function AuditVisibilityBanner({
  controller,
}: {
  controller: AuditPageController;
}): ReactElement {
  const hasPrivateProjection = controller.scopes.hasScope("audit:read_pii");
  return (
    <section
      className={`audit-visibility-banner${hasPrivateProjection ? " is-verified" : " is-unverified"}`}
      aria-labelledby="audit-visibility-title"
      data-testid="audit-visibility-banner"
    >
      <span className="audit-visibility-icon" aria-hidden="true">
        <Icon name={hasPrivateProjection ? "shield-check" : "lock"} size={17} />
      </span>
      <div className="audit-visibility-copy">
        <h2 id="audit-visibility-title">Private evidence boundary</h2>
        <p>
          Visible to <strong>{controller.visibleToLabel}</strong>.
        </p>
        <p>
          {hasPrivateProjection
            ? "The active identity's scope check reports audit:read_pii. The desktop workspace remains closed unless both protected read scopes are present."
            : "PII projection is not server-verified. This view must remain behind the route privacy boundary; Moosewave does not claim that these events are masked."}
        </p>
      </div>
      <span className="audit-verification-state">
        {hasPrivateProjection ? "Scope check passed" : "Verification required"}
      </span>
    </section>
  );
}

const RELEASE_HOLDS = [
  {
    id: "evidence",
    eyebrow: "Evidence operations",
    title: "Exports remain unavailable",
    capabilities: "CSV export · signed manifests · evidence schedules",
    reason:
      "Release requires complete cursor traversal, spreadsheet-safe encoding, durable restricted-file cleanup, and manifests that are signed against the exact delivered artifact.",
  },
  {
    id: "governance",
    eyebrow: "Governance operations",
    title: "Sensitive workflows remain unavailable",
    capabilities: "Portal sessions · AI/NLQ investigation · retention changes",
    reason:
      "Release requires non-consuming portal review, explicit third-party AI disclosure and consent, and an authoritative retention-policy history with verified enforcement.",
  },
  {
    id: "monitoring",
    eyebrow: "Continuous monitoring",
    title: "Live tail remains unavailable",
    capabilities: "Streaming · reconnect resume · gap reconciliation",
    reason:
      "Release requires a server resume cursor and exactly-once backfill across the list-to-stream handoff and every reconnect. Snapshot refresh remains available.",
  },
] as const;

export function AuditReleaseHolds(): ReactElement {
  return (
    <section
      className="audit-release-section"
      aria-labelledby="audit-release-title"
      data-testid="audit-release-holds"
    >
      <div className="audit-release-heading">
        <div>
          <span className="audit-section-kicker">Release boundaries</span>
          <h2 id="audit-release-title">
            Evidence tools held until proof exists
          </h2>
        </div>
        <p>
          The event explorer remains available. Operations that create, export,
          share, or reinterpret protected evidence are intentionally not mounted
          in this checkpoint.
        </p>
      </div>
      <div className="audit-release-grid">
        {RELEASE_HOLDS.map((hold) => (
          <article
            key={hold.id}
            className="audit-release-card"
            aria-labelledby={`audit-release-${hold.id}-title`}
          >
            <div className="audit-release-card-topline">
              <span className="audit-release-card-icon" aria-hidden="true">
                <Icon name="lock" size={16} />
              </span>
              <span className="audit-release-card-eyebrow">{hold.eyebrow}</span>
              <span className="audit-hold-badge">Release hold</span>
            </div>
            <h3 id={`audit-release-${hold.id}-title`}>{hold.title}</h3>
            <p className="audit-release-capabilities">{hold.capabilities}</p>
            <p className="audit-release-reason">{hold.reason}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
