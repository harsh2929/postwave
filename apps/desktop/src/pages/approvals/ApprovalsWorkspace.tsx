import {
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useMemo,
  useRef,
} from "react";

import { ApprovalDetailSlideover } from "../../components/ApprovalDetailSlideover";
import { HeroEmptyState } from "../../components/HeroEmptyState";
import { Icon, type IconName } from "../../components/Icon";
import { InlineHelp } from "../../components/InlineHelp";
import { Modal, ModalFooter } from "../../components/Modal";
import { Notice } from "../../components/Notice";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { StatStrip, type StatCell } from "../../components/StatStrip";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import type { DecodedApproval } from "../../lib/approvals-helpers";
import { HERO } from "../../lib/heroAssets";
import type { RemoteResourceController } from "../../hooks/useRemoteResource";
import type {
  ApprovalHistoryStatus,
  ApprovalSort,
  ApprovalWorkspaceTab,
} from "./approvals-route";
import {
  approvalResourceSummary,
  canRejectApproval,
  formatApprovalInstant,
  formatApprovalRelative,
} from "./approvals-view-model";
import {
  REJECTION_REASON_LIMIT,
  type ApprovalsController,
} from "./useApprovalsController";

const TABS: ReadonlyArray<{
  id: ApprovalWorkspaceTab;
  label: string;
  kicker: string;
  description: string;
  icon: IconName;
}> = [
  {
    id: "pending",
    label: "Pending",
    kicker: "Decide now",
    description: "Current requests awaiting review",
    icon: "clock",
  },
  {
    id: "history",
    label: "History",
    kicker: "Trace decisions",
    description: "Resolved records in the loaded window",
    icon: "chart-bars",
  },
  {
    id: "governance",
    label: "Governance",
    kicker: "Release controls",
    description: "Verified boundaries and held capabilities",
    icon: "shield-check",
  },
];

const TAB_CONTEXT: Record<
  ApprovalWorkspaceTab,
  { eyebrow: string; title: string; description: string }
> = {
  pending: {
    eyebrow: "Live decision queue",
    title: "Review the request—not merely its identifier.",
    description:
      "Inspect the exact server record, record a safe rejection when necessary, and keep approval execution held until immutable content evidence is available.",
  },
  history: {
    eyebrow: "Decision evidence",
    title: "Find what was decided without inventing a total.",
    description:
      "Search and sort the latest bounded server window. Every count on this page describes loaded evidence, never the complete lifetime history.",
  },
  governance: {
    eyebrow: "Fail-closed control plane",
    title: "Expose only governance the backend can prove.",
    description:
      "Unsafe chain, delegation, and signed-link claims remain visibly held until authorization, atomicity, and completion semantics pass release evidence.",
  },
};

function durationLabel(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function verifiedLabel(value: number | null): string {
  if (value === null) return "Not yet verified";
  return `Verified ${formatApprovalRelative(new Date(value).toISOString())}`;
}

function statusClass(row: DecodedApproval): string {
  return `approval-status is-${row.status}`;
}

function tabCount(
  tab: ApprovalWorkspaceTab,
  controller: ApprovalsController,
): ReactNode {
  if (tab === "pending") return controller.pendingWindowCount ?? "—";
  if (tab === "history") return controller.historyWindowCount ?? "—";
  return "Held";
}

function statsFor(controller: ApprovalsController): StatCell[] {
  const { stats } = controller;
  const historyMetric = (value: string): string =>
    controller.historyResource.stale ? `Stale · ${value}` : value;
  const historyHint = (hint: string): string =>
    controller.historyResource.stale
      ? `${hint} The History read failed, so this value is retained and stale.`
      : hint;
  return [
    {
      label: "Pending · loaded window",
      value:
        controller.pendingWindowCount === null
          ? "—"
          : controller.pendingWindowCount.toLocaleString(),
      hint: "Rows returned by the bounded pending-request query; this is not an all-time total.",
    },
    {
      label: "Approved · loaded 7d",
      value:
        controller.historyResource.data === null
          ? "—"
          : historyMetric(stats.approvedSevenDays.toLocaleString()),
      hint: historyHint(
        "Approved rows in the loaded history window whose decision timestamp falls in the last seven days.",
      ),
    },
    {
      label: "Rejected · loaded 7d",
      value:
        controller.historyResource.data === null
          ? "—"
          : historyMetric(stats.rejectedSevenDays.toLocaleString()),
      hint: historyHint(
        "Rejected rows in the loaded history window whose decision timestamp falls in the last seven days.",
      ),
    },
    {
      label: "Avg decision · loaded rows",
      value:
        controller.historyResource.data === null
          ? "—"
          : historyMetric(durationLabel(stats.averageDecisionMinutes)),
      hint: historyHint(
        "Mean request-to-decision time among resolved rows with valid timestamps in the loaded window.",
      ),
    },
  ];
}

export function ApprovalsWorkspace({
  controller,
}: {
  controller: ApprovalsController;
}): ReactElement {
  const tabs = useTabsInteraction<ApprovalWorkspaceTab>({
    activation: "manual",
    value: controller.tab,
    items: TABS.map((tab) => ({ value: tab.id })),
    onChange: controller.setTab,
  });
  const context = TAB_CONTEXT[controller.tab];
  const statCells = useMemo(() => statsFor(controller), [controller]);
  return (
    <div className="page approvals-page" data-active-tab={controller.tab}>
      <section className="approvals-masthead">
        <PageHeader
          eyebrow="Governance control room"
          title="Approvals"
          subtitle="A last-verified review workspace that keeps sensitive reads admin-scoped and high-consequence execution fail-closed."
          actions={
            controller.tab === "governance"
              ? undefined
              : [
                  {
                    label: controller.decisionBusy
                      ? "Decision in flight…"
                      : controller.refreshing
                        ? "Refreshing…"
                        : "Refresh evidence",
                    onClick: () => void controller.refreshAll(),
                    disabled: controller.refreshing,
                    title: controller.decisionBusy
                      ? "The current decision must reconcile before another read starts."
                      : controller.refreshing
                        ? "A queue and history refresh is already running."
                        : "Refresh both bounded server windows.",
                  },
                ]
          }
          meta={
            <div
              className="approvals-trust-strip"
              aria-label="Workspace guarantees"
            >
              <span>
                <Icon name="lock" size={14} /> Admin-scoped reads
              </span>
              <span>
                <Icon name="shield-check" size={14} /> Strict response contract
              </span>
              <span>
                <Icon name="eye-off" size={14} /> Raw metadata withheld
              </span>
            </div>
          }
        />
        <div className="approvals-masthead-graphic" aria-hidden="true">
          <span className="approvals-orbit approvals-orbit-one" />
          <span className="approvals-orbit approvals-orbit-two" />
          <span className="approvals-signal approvals-signal-request" />
          <span className="approvals-signal approvals-signal-review" />
          <span className="approvals-signal approvals-signal-proof" />
        </div>
      </section>

      <div
        ref={tabs.listRef}
        className="approvals-route-tabs"
        {...tabs.listProps}
        aria-label="Approval workspaces"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            {...tabs.getTabProps(tab.id)}
            className={`approvals-route-tab${controller.tab === tab.id ? " is-active" : ""}`}
          >
            <span className="approvals-route-tab-icon" aria-hidden="true">
              <Icon name={tab.icon} size={17} />
            </span>
            <span className="approvals-route-tab-copy">
              <span className="approvals-route-tab-kicker">{tab.kicker}</span>
              <strong>{tab.label}</strong>
              <span>{tab.description}</span>
            </span>
            <span className="approvals-route-tab-count">
              {tabCount(tab.id, controller)}
            </span>
          </button>
        ))}
      </div>

      <section
        className="approvals-tab-context"
        aria-labelledby="approvals-context-title"
      >
        <div>
          <span className="approvals-context-eyebrow">{context.eyebrow}</span>
          <h2 id="approvals-context-title">{context.title}</h2>
          <p>{context.description}</p>
        </div>
        <div className="approvals-verification-receipt" role="note">
          <Icon name="clock" size={16} />
          <span>
            Queue: {verifiedLabel(controller.pendingResource.lastVerifiedAt)}
            <br />
            History: {verifiedLabel(controller.historyResource.lastVerifiedAt)}
          </span>
        </div>
      </section>

      {controller.tab === "governance" ? null : <StatStrip cells={statCells} />}

      {TABS.map((tab) => (
        <section
          key={tab.id}
          className="approvals-tab-panel"
          {...tabs.getPanelProps(tab.id)}
        >
          {tab.id === controller.tab ? (
            tab.id === "governance" ? (
              <ApprovalGovernanceHold />
            ) : (
              <ApprovalQueueWorkspace controller={controller} />
            )
          ) : null}
        </section>
      ))}

      {controller.detail ? (
        <ApprovalDetailSlideover
          row={controller.detail}
          onClose={controller.closeDetail}
          canDecide={!controller.decisionBusy}
          onReject={controller.openReject}
        />
      ) : null}
      <RejectApprovalModal controller={controller} />
    </div>
  );
}

function ApprovalQueueWorkspace({
  controller,
}: {
  controller: ApprovalsController;
}): ReactElement {
  const holdId = useId();
  const resource = controller.activeResource;
  const hasVerifiedData = resource.data !== null;
  return (
    <div className="approvals-queue-workspace">
      <Notice
        tone="warning"
        title="Approval execution is release-held"
        announcement="off"
        className="approvals-execution-hold"
      >
        <span id={holdId}>
          The API does not yet return an immutable content, audience, schedule,
          and follow-up receipt bundle. Exact record inspection and safe
          rejection remain available; approval execution does not.
        </span>
      </Notice>
      <ApprovalFilters controller={controller} />
      <ApprovalRemoteState
        resource={resource}
        onRetry={controller.refreshAll}
      />
      {controller.tab === "pending" ? (
        <ApprovalRemoteState
          resource={controller.historyResource}
          onRetry={controller.refreshAll}
          subject="History metrics"
        />
      ) : null}
      {resource.data === null && resource.transport !== "error" ? (
        <ApprovalQueueSkeleton />
      ) : hasVerifiedData ? (
        <ApprovalQueueResult controller={controller} holdId={holdId} />
      ) : null}
    </div>
  );
}

function ApprovalFilters({
  controller,
}: {
  controller: ApprovalsController;
}): ReactElement {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    controller.applyQuery();
  };
  const filtered =
    controller.view.query ||
    (controller.tab === "history" && controller.view.status !== "all") ||
    controller.view.sort !== "newest";
  return (
    <form className="approvals-filter-bar" role="search" onSubmit={submit}>
      <label className="approvals-search-field">
        <span>Search loaded records</span>
        <input
          className="input"
          type="search"
          value={controller.queryDraft}
          maxLength={120}
          placeholder="Resource, requester, status, or reason"
          onChange={(event) => controller.setQueryDraft(event.target.value)}
        />
      </label>
      <button type="submit" className="btn approvals-filter-apply">
        Apply search
      </button>
      {controller.tab === "history" ? (
        <label className="approvals-filter-field">
          <span>Status</span>
          <select
            className="input"
            value={controller.view.status}
            onChange={(event) =>
              controller.setStatus(event.target.value as ApprovalHistoryStatus)
            }
          >
            <option value="all">All resolved states</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="expired">Expired</option>
            <option value="unverified">Unverified</option>
          </select>
        </label>
      ) : null}
      <label className="approvals-filter-field">
        <span>Sort</span>
        <select
          className="input"
          value={controller.view.sort}
          onChange={(event) =>
            controller.setSort(event.target.value as ApprovalSort)
          }
        >
          <option value="newest">Newest request</option>
          <option value="oldest">Oldest request</option>
          <option value="resource">Resource</option>
          <option value="requester">Requester</option>
          {controller.tab === "history" ? (
            <option value="status">Status</option>
          ) : null}
        </select>
      </label>
      {filtered ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={controller.resetFilters}
        >
          Reset
        </button>
      ) : null}
      <div className="approvals-filter-truth" role="note">
        Latest {controller.tab === "pending" ? "pending" : "combined"} server
        window · up to 200 records
      </div>
    </form>
  );
}

function ApprovalRemoteState({
  resource,
  onRetry,
  subject = "Approval",
}: {
  resource: RemoteResourceController<DecodedApproval[]>;
  onRetry: () => Promise<void>;
  subject?: string;
}): ReactElement | null {
  if (resource.transport === "error" && resource.data === null) {
    return (
      <Notice
        tone="danger"
        title={
          resource.access === "denied"
            ? `${subject} access changed`
            : `${subject} evidence unavailable`
        }
        action={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void onRetry()}
          >
            Retry
          </button>
        }
      >
        {resource.failure?.message ??
          "The server could not verify this approval window."}
        {resource.failure?.requestId ? (
          <span className="approvals-request-reference">
            Reference {resource.failure.requestId}
          </span>
        ) : null}
      </Notice>
    );
  }
  if (resource.stale && resource.failure) {
    return (
      <Notice
        tone="warning"
        title={
          subject === "Approval"
            ? "Showing a retained, stale snapshot"
            : `Showing retained, stale ${subject.toLocaleLowerCase()}`
        }
        action={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void onRetry()}
          >
            Retry
          </button>
        }
      >
        {resource.failure.message} No decision action is enabled from unverified
        detail evidence.
      </Notice>
    );
  }
  if (resource.transport === "loading" && resource.data !== null) {
    return (
      <div className="approvals-inline-refresh" role="status">
        <span className="approvals-inline-refresh-dot" aria-hidden="true" />
        {subject === "Approval"
          ? "Refreshing while the last verified window remains visible."
          : `Refreshing ${subject.toLocaleLowerCase()} while the last verified window remains visible.`}
      </div>
    );
  }
  return null;
}

function ApprovalQueueSkeleton(): ReactElement {
  return (
    <div
      className="approvals-table-shell"
      role="status"
      aria-label="Loading approval records"
    >
      <div className="approvals-skeleton-header" aria-hidden="true">
        <Skeleton width="18%" height={13} />
        <Skeleton width="26%" height={13} />
        <Skeleton width="24%" height={13} />
        <Skeleton width="16%" height={13} />
      </div>
      {Array.from({ length: 5 }, (_, index) => (
        <div className="approvals-skeleton-row" key={index} aria-hidden="true">
          <Skeleton width="72%" height={14} />
          <Skeleton width="88%" height={14} />
          <Skeleton width="64%" height={14} />
          <Skeleton width="78%" height={14} />
        </div>
      ))}
      <span className="visually-hidden">Loading approval records…</span>
    </div>
  );
}

function ApprovalQueueResult({
  controller,
  holdId,
}: {
  controller: ApprovalsController;
  holdId: string;
}): ReactElement {
  const scopeCount = (controller.activeResource.data ?? []).filter((row) =>
    controller.tab === "pending"
      ? row.status === "pending"
      : row.status !== "pending",
  ).length;
  const hasFilter = Boolean(
    controller.view.query ||
    (controller.tab === "history" && controller.view.status !== "all"),
  );
  if (controller.visibleRows.length === 0) {
    if (hasFilter && scopeCount > 0) {
      return (
        <section
          className="approvals-filter-empty"
          aria-labelledby="approval-no-match-title"
        >
          <span className="approvals-empty-mark" aria-hidden="true">
            <Icon name="eye" size={22} />
          </span>
          <div>
            <h3 id="approval-no-match-title">No loaded records match</h3>
            <p>
              Change the query or status filter; the underlying verified window
              is still intact.
            </p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={controller.resetFilters}
          >
            Reset filters
          </button>
        </section>
      );
    }
    if (controller.tab === "pending") {
      return (
        <HeroEmptyState
          tone="blue"
          eyebrow="Verified pending window"
          title="Nothing is waiting in the loaded queue."
          subtitle="New campaign, sequence, and automation-send review requests will appear here after the server returns them."
          imageSrc={HERO.approvals}
          imageAlt="Two colleagues meeting across a desk"
        />
      );
    }
    return (
      <section
        className="approvals-history-empty"
        aria-labelledby="approval-history-empty-title"
      >
        <Icon name="chart-bars" size={24} />
        <div>
          <h3 id="approval-history-empty-title">
            No resolved evidence in this window
          </h3>
          <p>
            This is a verified bounded result, not a claim that the workspace
            has never made a decision.
          </p>
        </div>
      </section>
    );
  }
  return (
    <>
      <div
        className="approvals-result-summary"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Showing {controller.visibleRows.length.toLocaleString()} of{" "}
        {scopeCount.toLocaleString()} loaded{" "}
        {controller.tab === "pending" ? "pending" : "resolved"} records.
      </div>
      <ApprovalTable controller={controller} holdId={holdId} />
    </>
  );
}

function ApprovalTable({
  controller,
  holdId,
}: {
  controller: ApprovalsController;
  holdId: string;
}): ReactElement {
  return (
    <div className="approvals-table-shell">
      <table
        className="approvals-table"
        aria-label={`${controller.tab === "pending" ? "Pending" : "Resolved"} approval records`}
        aria-rowcount={controller.visibleRows.length + 1}
        aria-colcount={6}
      >
        <thead>
          <tr>
            <th scope="col">Requested</th>
            <th scope="col">Resource</th>
            <th scope="col">Review context</th>
            <th scope="col">Requester</th>
            <th scope="col">State</th>
            <th scope="col" className="approvals-actions-heading">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {controller.visibleRows.map((row) => (
            <ApprovalTableRow
              key={row.id}
              row={row}
              controller={controller}
              holdId={holdId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApprovalTableRow({
  row,
  controller,
  holdId,
}: {
  row: DecodedApproval;
  controller: ApprovalsController;
  holdId: string;
}): ReactElement {
  const exactRequested = formatApprovalInstant(row.requestedAt);
  return (
    <tr data-approval-id={row.id}>
      <td data-label="Requested" className="approval-time-cell">
        <time dateTime={row.requestedAt} title={exactRequested}>
          <strong>{formatApprovalRelative(row.requestedAt)}</strong>
          <span>{exactRequested}</span>
        </time>
      </td>
      <td data-label="Resource">
        <span className="approval-resource-type">{row.resourceLabel}</span>
        <code className="approval-resource-id">{row.resourceId}</code>
      </td>
      <td data-label="Review context">
        <span className="approval-context-copy">
          {row.notes ?? "No review context was supplied."}
        </span>
      </td>
      <td data-label="Requester">
        {row.requestedByActorLabel ?? "Requester unavailable"}
      </td>
      <td data-label="State">
        <span className={statusClass(row)}>{row.statusLabel}</span>
      </td>
      <td data-label="Actions">
        <div className="approval-row-actions">
          <button
            type="button"
            className="btn btn-sm"
            aria-label={`Details for ${row.resourceLabel} ${row.resourceId}`}
            onClick={() => controller.openDetail(row)}
          >
            Details
          </button>
          {row.status === "pending" ? (
            <span className="approval-row-hold" aria-describedby={holdId}>
              <Icon name="lock" size={12} />
              {canRejectApproval(row)
                ? "Exact review required"
                : "Decision held"}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ApprovalGovernanceHold(): ReactElement {
  const holds = [
    {
      title: "Multi-stage chains",
      icon: "git-branch" as const,
      detail:
        "Held until each stage is bound to the base approval, authenticated against its required role, and completed once inside the canonical transaction.",
    },
    {
      title: "Delegated authority",
      icon: "users" as const,
      detail:
        "Held until an eligible delegate can be proven to gain a bounded permission window and conflicting or invalid windows fail visibly.",
    },
    {
      title: "Signed decision links",
      icon: "key" as const,
      detail:
        "Held until the approver is bound, the requester is excluded, and token consumption plus the decision commit atomically.",
    },
  ];
  return (
    <div className="approvals-governance">
      <Notice
        tone="danger"
        title="Release hold: governance execution is not exposed"
      >
        This panel intentionally mounts no chain, delegation, or public-decision
        transport. Visual controls cannot compensate for missing authorization
        and transaction invariants.
      </Notice>
      <div className="approvals-governance-grid">
        {holds.map((hold, index) => (
          <article key={hold.title} className="approval-governance-card">
            <span className="approval-governance-index">0{index + 1}</span>
            <Icon name={hold.icon} size={22} />
            <h3>{hold.title}</h3>
            <p>{hold.detail}</p>
            <span className="approval-governance-state">
              <Icon name="lock" size={12} /> Held fail-closed
            </span>
          </article>
        ))}
      </div>
      <section
        className="approval-governance-proof"
        aria-labelledby="approval-proof-title"
      >
        <div>
          <span className="approvals-context-eyebrow">
            Release acceptance evidence
          </span>
          <h3 id="approval-proof-title">
            What must be true before these controls return
          </h3>
        </div>
        <ol>
          <li>
            One transactional approval state machine with tenant and resource
            binding.
          </li>
          <li>
            Real approver eligibility, two-person enforcement, expiry, and
            version checks.
          </li>
          <li>
            Idempotent decision receipts with durable downstream follow-up
            state.
          </li>
          <li>
            Concurrent-decision, replay, RLS, and signed-link integration
            evidence.
          </li>
        </ol>
      </section>
    </div>
  );
}

function RejectApprovalModal({
  controller,
}: {
  controller: ApprovalsController;
}): ReactElement {
  const reasonHelpId = useId();
  const reasonErrorId = useId();
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const count = controller.rejectionReason.length;
  const describedBy = [
    reasonHelpId,
    controller.rejectionError ? reasonErrorId : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Modal
      open={controller.rejectFor !== null}
      onClose={controller.closeReject}
      title="Record a rejection"
      description="This records a governance decision. It does not claim that requester notification or another downstream action completed."
      initialFocusRef={reasonRef}
      closeOnBackdrop={!controller.decisionBusy}
      closeOnEscape={!controller.decisionBusy}
      closeDisabled={controller.decisionBusy}
      role="alertdialog"
    >
      {controller.rejectFor ? (
        <div className="approval-reject-target" role="note">
          <span>Request</span>
          <strong>{approvalResourceSummary(controller.rejectFor)}</strong>
        </div>
      ) : null}
      <div className="field approval-reject-field">
        <label className="field-label" htmlFor="approval-rejection-reason">
          Reason
          <InlineHelp text="Give the requester a corrective next step. Do not include credentials, recipient data, or other secrets." />
        </label>
        <textarea
          ref={reasonRef}
          id="approval-rejection-reason"
          className="input"
          value={controller.rejectionReason}
          maxLength={REJECTION_REASON_LIMIT}
          rows={5}
          aria-invalid={controller.rejectionError ? true : undefined}
          aria-describedby={describedBy}
          placeholder="Explain the failed gate and the safe change required."
          onChange={(event) =>
            controller.setRejectionReason(event.target.value)
          }
        />
        <div className="approval-reject-meta">
          <span id={reasonHelpId}>
            Required · stored on the approval record
          </span>
          <span className="tabular">
            {count}/{REJECTION_REASON_LIMIT}
          </span>
        </div>
        {controller.rejectionError ? (
          <div id={reasonErrorId} className="field-error" role="alert">
            {controller.rejectionError}
          </div>
        ) : null}
      </div>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={controller.closeReject}
          disabled={controller.decisionBusy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void controller.submitRejection()}
          disabled={controller.decisionBusy}
        >
          {controller.decisionBusy ? "Recording…" : "Record rejection"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
