import { type ReactElement, useId, useState } from "react";

import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import {
  REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE,
  REFERRAL_ATTRIBUTION_RUNTIME_UNAVAILABLE_REASON,
  REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
  REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON,
  REFERRAL_PROGRAM_MUTATIONS_AVAILABLE,
  REFERRAL_PROGRAM_MUTATIONS_UNAVAILABLE_REASON,
  REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE,
  REFERRAL_PUBLIC_WIDGET_INSTALL_UNAVAILABLE_REASON,
  REFERRAL_SUBSCRIBER_LINKS_AVAILABLE,
  REFERRAL_SUBSCRIBER_LINKS_UNAVAILABLE_REASON,
} from "../../lib/referral-operational-availability";
import type { ReferralMilestone } from "../../lib/api-client";
import { fmtDateTime } from "../../lib/format-date";
import { LeaderboardCard } from "./LeaderboardCard";
import { ReferralStatsCards } from "./ReferralStatsCards";
import {
  KIND_LABELS,
  parseReward,
} from "../../pages/referrals/referral-program";
import type { ReferralProgramState } from "../../pages/referrals/useReferralProgramController";

import "../../styles-referrals.css";

type ReferralWorkspace = "overview" | "advocates" | "rewards" | "distribution";

type ReferralPresentationStatus =
  | "active"
  | "degraded"
  | "empty"
  | "initial-loading"
  | "refreshing"
  | "unavailable";

const REFERRAL_WORKSPACES: ReadonlyArray<{
  description: string;
  id: ReferralWorkspace;
  label: string;
}> = [
  {
    id: "overview",
    label: "Overview",
    description: "Snapshot state",
  },
  {
    id: "advocates",
    label: "Advocates",
    description: "Credited leaders",
  },
  {
    id: "rewards",
    label: "Rewards",
    description: "Release boundary",
  },
  {
    id: "distribution",
    label: "Distribution",
    description: "Delivery readiness",
  },
];

const REFERRAL_TAB_ITEMS = REFERRAL_WORKSPACES.map(({ id }) => ({
  value: id,
}));

const STATUS_COPY: Record<
  ReferralPresentationStatus,
  { label: string; detail: string }
> = {
  active: {
    label: "Snapshot verified",
    detail:
      "The current authenticated program response is verified for inspection.",
  },
  degraded: {
    label: "Last verified",
    detail: "Refresh failed; the last verified program remains visible.",
  },
  empty: {
    label: "Not configured",
    detail: "No active referral program was found.",
  },
  "initial-loading": {
    label: "Checking program",
    detail: "Loading verified program state.",
  },
  refreshing: {
    label: "Refreshing",
    detail: "Showing the last verified program while it refreshes.",
  },
  unavailable: {
    label: "Unavailable",
    detail: "The current program could not be verified.",
  },
};

export interface ReferralsPageContentProps {
  canAdmin: boolean;
  canManageProgram: boolean;
  milestones: ReferralMilestone[];
  state: ReferralProgramState;
  onCreate: () => void;
  onEdit: (index?: number) => void;
  onInstallWebsite?: () => void;
  onRefresh: () => void;
}

export function referralPresentationStatus(
  state: ReferralProgramState,
): ReferralPresentationStatus {
  if (state.loading && !state.program) return "initial-loading";
  if (state.error && state.program) return "degraded";
  if (state.error) return "unavailable";
  if (state.loading && state.program) return "refreshing";
  if (state.empty) return "empty";
  return state.program ? "active" : "unavailable";
}

function ReferralLoopIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 7h-5V2" />
      <path d="M20 7a9 9 0 1 0 1 8" />
      <path d="M8.5 12.5 11 15l4.5-5" />
    </svg>
  );
}

function ShieldIcon(): ReactElement {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6Z" />
      <path d="m9.5 12 1.7 1.7 3.7-4" />
    </svg>
  );
}

function RefreshIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 7v5h-5" />
      <path d="M4 17v-5h5" />
      <path d="M6.1 9A7 7 0 0 1 18 6l2 1" />
      <path d="M17.9 15A7 7 0 0 1 6 18l-2-1" />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function GrowthLoopMap({
  status,
}: {
  status: ReferralPresentationStatus;
}): ReactElement {
  const verified = status === "active" || status === "refreshing";
  return (
    <aside className="ref-growth-map" aria-label="Referral readiness path">
      <div className="ref-growth-map-heading">
        <span>Referral readiness path</span>
        <span className={verified ? "is-ready" : undefined}>
          {verified ? "Snapshot verified" : "Awaiting verification"}
        </span>
      </div>
      <ol className="ref-growth-steps">
        <li>
          <span className="ref-growth-step-index">01</span>
          <span>
            <strong>Inspect</strong>
            <small>Program snapshot</small>
          </span>
        </li>
        <li>
          <span className="ref-growth-step-index">02</span>
          <span>
            <strong>Review</strong>
            <small>Historical signals</small>
          </span>
        </li>
        <li className="is-gated">
          <span className="ref-growth-step-index">03</span>
          <span>
            <strong>Qualify</strong>
            <small>Live attribution</small>
          </span>
        </li>
        <li className="is-gated">
          <span className="ref-growth-step-index">04</span>
          <span>
            <strong>Release</strong>
            <small>Rewards + widget</small>
          </span>
        </li>
      </ol>
      <p className="ref-growth-map-foot">
        Historical inspection is available. Live attribution, reward operations,
        subscriber links, and website installation remain gated.
      </p>
    </aside>
  );
}

interface ReferralHeroProps extends Pick<
  ReferralsPageContentProps,
  | "canAdmin"
  | "canManageProgram"
  | "onCreate"
  | "onEdit"
  | "onInstallWebsite"
  | "onRefresh"
  | "state"
> {
  installReasonId: string;
  programReasonId: string;
  status: ReferralPresentationStatus;
}

function ReferralHero({
  canAdmin,
  canManageProgram,
  installReasonId,
  onCreate,
  onEdit,
  onInstallWebsite,
  onRefresh,
  programReasonId,
  state,
  status,
}: ReferralHeroProps): ReactElement {
  const statusCopy = STATUS_COPY[status];
  const canChangeProgram =
    canManageProgram && REFERRAL_PROGRAM_MUTATIONS_AVAILABLE;
  const hasVerifiedPrimary =
    canAdmin &&
    !state.loading &&
    state.error === null &&
    (state.program !== null || state.empty);
  const canInstall =
    REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE &&
    REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE &&
    REFERRAL_SUBSCRIBER_LINKS_AVAILABLE &&
    canAdmin &&
    canChangeProgram &&
    state.program !== null &&
    onInstallWebsite !== undefined;
  const primaryLabel = state.empty ? "Create program" : "Edit program";

  return (
    <section className="ref-hero" aria-labelledby="referrals-page-title">
      <div className="ref-hero-copy">
        <div className="ref-eyebrow">
          <span className="ref-eyebrow-icon">
            <ReferralLoopIcon />
          </span>
          Growth operations
        </div>
        <div className="ref-status-row" role="status" aria-live="polite">
          <span className={`ref-status-chip is-${status}`}>
            <span className="ref-status-dot" aria-hidden="true" />
            {statusCopy.label}
          </span>
          {!canAdmin ? (
            <span className="ref-status-chip is-read-only">
              <ShieldIcon />
              Read-only access
            </span>
          ) : null}
          <span className="ref-status-detail">{statusCopy.detail}</span>
        </div>
        <h1 id="referrals-page-title">
          Understand your referral history. Qualify the loop before launch.
        </h1>
        <p>
          Review the current program snapshot, historical conversion summaries,
          and masked advocate rankings while unfinished attribution, rewards,
          and public delivery remain visibly gated.
        </p>
        <div className="ref-hero-actions">
          {hasVerifiedPrimary ? (
            <button
              type="button"
              className="btn btn-primary"
              aria-disabled={!canChangeProgram || undefined}
              aria-describedby={!canChangeProgram ? programReasonId : undefined}
              onClick={() => {
                if (canChangeProgram) {
                  if (state.empty) onCreate();
                  else onEdit();
                }
              }}
            >
              {primaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={state.loading}
            aria-busy={state.loading || undefined}
            onClick={onRefresh}
          >
            <RefreshIcon />
            {state.loading ? "Refreshing program…" : "Refresh program"}
          </button>
          <button
            type="button"
            className="btn ref-install-action"
            aria-disabled={!canInstall || undefined}
            aria-describedby={!canInstall ? installReasonId : undefined}
            onClick={() => {
              if (canInstall) onInstallWebsite?.();
            }}
          >
            Install on website
          </button>
        </div>
        {hasVerifiedPrimary && !canChangeProgram ? (
          <p id={programReasonId} className="ref-install-reason">
            <ShieldIcon />
            <span>
              <strong>Program changes are review-gated.</strong>{" "}
              {REFERRAL_PROGRAM_MUTATIONS_UNAVAILABLE_REASON}
            </span>
          </p>
        ) : null}
        {!canInstall ? (
          <p id={installReasonId} className="ref-install-reason">
            <ShieldIcon />
            <span>
              <strong>Website installation is review-gated.</strong>{" "}
              {REFERRAL_PUBLIC_WIDGET_INSTALL_UNAVAILABLE_REASON}
            </span>
          </p>
        ) : null}
      </div>
      <GrowthLoopMap status={status} />
    </section>
  );
}

function ReferralStateNotice({
  state,
  status,
}: {
  state: ReferralProgramState;
  status: ReferralPresentationStatus;
}): ReactElement | null {
  if (status === "initial-loading") {
    return (
      <div className="ref-state-notice is-loading" role="status">
        <span className="ref-state-mark" aria-hidden="true" />
        <span>
          <strong>Loading verified program state.</strong>
          Actions remain unavailable until the current tenant response is
          confirmed.
        </span>
      </div>
    );
  }
  if (status === "refreshing") {
    return (
      <div className="ref-state-notice is-loading" role="status">
        <span className="ref-state-mark" aria-hidden="true" />
        <span>
          <strong>Refreshing in the background.</strong>
          The last verified program remains visible; changes stay locked until
          the refresh completes.
        </span>
      </div>
    );
  }
  if (status === "degraded") {
    return (
      <div className="ref-state-notice is-warning" role="alert">
        <span className="ref-state-mark" aria-hidden="true">
          !
        </span>
        <span>
          <strong>Refresh failed; showing the last verified program.</strong>
          Changes are locked to prevent overwriting a newer configuration.
          {state.error ? ` ${state.error}` : ""}
        </span>
      </div>
    );
  }
  if (status === "unavailable") {
    return (
      <div className="ref-state-notice is-danger" role="alert">
        <span className="ref-state-mark" aria-hidden="true">
          !
        </span>
        <span>
          <strong>The referral program is unavailable.</strong>
          No program configuration is assumed or rendered as verified.
          {state.error ? ` ${state.error}` : ""}
        </span>
      </div>
    );
  }
  return null;
}

function ProgramSnapshot({
  milestones,
  state,
}: {
  milestones: ReferralMilestone[];
  state: ReferralProgramState;
}): ReactElement {
  if (state.loading && !state.program) {
    return (
      <section
        className="ref-program-snapshot is-loading"
        aria-label="Loading program snapshot"
        role="status"
      >
        <span className="ref-program-skeleton is-wide" aria-hidden="true" />
        <span className="ref-program-skeleton" aria-hidden="true" />
        <span className="visually-hidden">
          Loading the authenticated referral program snapshot…
        </span>
      </section>
    );
  }
  if (!state.program) {
    return (
      <section
        className="ref-program-snapshot is-empty"
        aria-labelledby="referral-program-snapshot-empty"
      >
        <span className="ref-program-empty-icon" aria-hidden="true">
          <ReferralLoopIcon />
        </span>
        <div>
          <span className="ref-readiness-state">
            {state.empty ? "Verified empty" : "Unavailable"}
          </span>
          <h3 id="referral-program-snapshot-empty">
            {state.empty
              ? "No active program snapshot"
              : "No verified program snapshot"}
          </h3>
          <p>
            {state.empty
              ? "The authenticated read returned no active configuration. Program creation remains gated while live attribution and expiry behavior are unqualified."
              : "The current configuration could not be verified, so this workspace does not infer milestones or an active program."}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      className="ref-program-snapshot"
      aria-labelledby="referral-program-snapshot-title"
      data-testid="referral-program-snapshot"
    >
      <header className="ref-program-snapshot-header">
        <div>
          <span className="ref-readiness-state">Authenticated snapshot</span>
          <h3 id="referral-program-snapshot-title">
            Stored program configuration
          </h3>
          <p>
            {milestones.length.toLocaleString()} stored{" "}
            {milestones.length === 1 ? "milestone" : "milestones"} · last
            updated {fmtDateTime(state.program.updatedAt)}
          </p>
        </div>
        <span className="ref-snapshot-badge">
          {state.program.active ? "Stored active record" : "Stored inactive"}
        </span>
      </header>

      {state.program.expiresAt ? (
        <p className="ref-expiry-note">
          Stored end date: {fmtDateTime(state.program.expiresAt)}. Expiry is not
          presented as runtime-enforced.
        </p>
      ) : null}

      {milestones.length > 0 ? (
        <div
          className="ref-program-table-wrap"
          role="region"
          aria-label="Stored milestone table"
        >
          <div className="ref-program-table-controls">
            <button
              type="button"
              className="btn"
              onClick={(event) => {
                event.currentTarget
                  .closest<HTMLElement>(".ref-program-table-wrap")
                  ?.scrollBy({ left: -240, behavior: "auto" });
              }}
            >
              <span aria-hidden="true">←</span>
              Previous columns
            </button>
            <button
              type="button"
              className="btn"
              onClick={(event) => {
                event.currentTarget
                  .closest<HTMLElement>(".ref-program-table-wrap")
                  ?.scrollBy({ left: 240, behavior: "auto" });
              }}
            >
              Next columns
              <span aria-hidden="true">→</span>
            </button>
          </div>
          <table aria-label="Stored referral program milestones">
            <thead>
              <tr>
                <th scope="col">Stored threshold</th>
                <th scope="col">Reward label</th>
                <th scope="col">Kind</th>
              </tr>
            </thead>
            <tbody>
              {milestones.map((milestone) => {
                const parsed = parseReward(milestone.reward_label);
                const kind = milestone.reward_kind ?? parsed.kind;
                const label =
                  milestone.reward_kind && parsed.kind === milestone.reward_kind
                    ? parsed.label
                    : milestone.reward_label;
                return (
                  <tr key={milestone.count}>
                    <td className="tabular">
                      {milestone.count.toLocaleString()} referrals
                    </td>
                    <td>{label || "No label stored"}</td>
                    <td>{KIND_LABELS[kind]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ref-expiry-note">
          This verified program snapshot contains no milestones.
        </p>
      )}

      <p className="ref-snapshot-caveat">
        <ShieldIcon />
        Configuration evidence only: this snapshot does not assert that signup
        credit, expiry, milestone unlocks, or reward fulfillment are operating
        end to end.
      </p>
    </section>
  );
}

function RewardsWorkspace(): ReactElement {
  const stateLabel = REFERRAL_PAYOUT_OPERATIONS_AVAILABLE
    ? "Qualified; UI release pending"
    : "Review-gated";
  return (
    <div className="ref-rewards-workspace">
      <header className="ref-panel-heading">
        <p className="ref-panel-kicker">Reward boundary</p>
        <h2>Protect earned value before exposing fulfillment controls.</h2>
        <p>
          The payout queue is intentionally not requested or mounted on this
          screen. Historical referral inspection does not authorize financial
          state changes.
        </p>
      </header>
      <section
        className="ref-gated-surface"
        aria-labelledby="referral-rewards-gated-title"
      >
        <div className="ref-gated-surface-icon">
          <ShieldIcon />
        </div>
        <div>
          <span className="ref-readiness-state">{stateLabel}</span>
          <h3 id="referral-rewards-gated-title">
            Reward operations stay closed
          </h3>
          <p>{REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON}</p>
          <ul className="ref-qualification-list">
            <li>Make queue reads observational and free of record creation.</li>
            <li>
              Snapshot the earning program, reward value, and currency on each
              payout.
            </li>
            <li>
              Record actor, transition evidence, and retry-safe fulfillment
              receipts.
            </li>
          </ul>
          <button
            type="button"
            className="btn"
            aria-disabled="true"
            aria-describedby="referral-rewards-gated-title"
          >
            Open payout queue
          </button>
        </div>
      </section>
      <p className="ref-safe-behavior" role="status">
        <CheckIcon />
        Safe behavior now: zero payout reads and zero payout mutation controls
        are mounted from this workspace.
      </p>
    </div>
  );
}

function DistributionWorkspace({
  canInstall,
  installReasonId,
  onInstallWebsite,
}: {
  canInstall: boolean;
  installReasonId: string;
  onInstallWebsite?: () => void;
}): ReactElement {
  return (
    <div className="ref-distribution-workspace">
      <header className="ref-panel-heading">
        <p className="ref-panel-kicker">Delivery boundary</p>
        <h2>Know what is inspectable—and what is not yet releasable.</h2>
        <p>
          Authenticated historical views are available today. Live attribution,
          subscriber links, reward operations, and public installation remain
          visibly held back.
        </p>
      </header>
      <div className="ref-readiness-grid">
        <article className="ref-readiness-card is-available">
          <span className="ref-readiness-icon">
            <CheckIcon />
          </span>
          <div>
            <span className="ref-readiness-state">Available with sign-in</span>
            <h3>Program snapshot</h3>
            <p>
              Inspect the authenticated program and milestone configuration
              without presenting it as proof of a working acquisition loop.
            </p>
          </div>
        </article>
        <article className="ref-readiness-card is-available">
          <span className="ref-readiness-icon">
            <CheckIcon />
          </span>
          <div>
            <span className="ref-readiness-state">Available with sign-in</span>
            <h3>Attribution insight</h3>
            <p>
              Review existing conversion summaries and server-masked advocate
              rankings. These historical views do not verify live signup
              attribution.
            </p>
          </div>
        </article>
        <article className="ref-readiness-card is-gated">
          <span className="ref-readiness-icon">
            <ShieldIcon />
          </span>
          <div>
            <span className="ref-readiness-state">Review-gated</span>
            <h3>Live attribution + subscriber links</h3>
            <p>
              {REFERRAL_ATTRIBUTION_RUNTIME_UNAVAILABLE_REASON}{" "}
              {REFERRAL_SUBSCRIBER_LINKS_UNAVAILABLE_REASON}
            </p>
          </div>
        </article>
        <article className="ref-readiness-card is-gated">
          <span className="ref-readiness-icon">
            <ShieldIcon />
          </span>
          <div>
            <span className="ref-readiness-state">Review-gated</span>
            <h3>Rewards + public website widget</h3>
            <p>
              {REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON}{" "}
              {REFERRAL_PUBLIC_WIDGET_INSTALL_UNAVAILABLE_REASON}
            </p>
            <button
              type="button"
              className="btn"
              aria-disabled={!canInstall || undefined}
              aria-describedby={!canInstall ? installReasonId : undefined}
              onClick={() => {
                if (canInstall) onInstallWebsite?.();
              }}
            >
              Install widget
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}

export function ReferralsPageContent({
  canAdmin,
  canManageProgram,
  milestones,
  onCreate,
  onEdit,
  onInstallWebsite,
  onRefresh,
  state,
}: ReferralsPageContentProps): ReactElement {
  const [workspace, setWorkspace] = useState<ReferralWorkspace>("overview");
  const instanceId = useId();
  const tabs = useTabsInteraction<ReferralWorkspace>({
    activation: "manual",
    items: REFERRAL_TAB_ITEMS,
    onChange: setWorkspace,
    value: workspace,
  });
  const installReasonId = `${instanceId}-install-reason`;
  const programReasonId = `${instanceId}-program-reason`;
  const status = referralPresentationStatus(state);
  const canInstall =
    REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE &&
    REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE &&
    REFERRAL_PROGRAM_MUTATIONS_AVAILABLE &&
    REFERRAL_SUBSCRIBER_LINKS_AVAILABLE &&
    canAdmin &&
    canManageProgram &&
    state.program !== null &&
    onInstallWebsite !== undefined;

  return (
    <div className="ref-page">
      <ReferralHero
        canAdmin={canAdmin}
        canManageProgram={canManageProgram}
        installReasonId={installReasonId}
        onCreate={onCreate}
        onEdit={onEdit}
        onInstallWebsite={onInstallWebsite}
        onRefresh={onRefresh}
        programReasonId={programReasonId}
        state={state}
        status={status}
      />
      <ReferralStateNotice state={state} status={status} />

      <div
        ref={tabs.listRef}
        {...tabs.listProps}
        className="ref-workspace-tabs"
        aria-label="Referral workspaces"
      >
        {REFERRAL_WORKSPACES.map((item) => {
          const selected = workspace === item.id;
          return (
            <button
              key={item.id}
              type="button"
              {...tabs.getTabProps(item.id)}
              className={selected ? "is-selected" : undefined}
            >
              <span>{item.label}</span>
              <small>{item.description}</small>
            </button>
          );
        })}
      </div>

      <section
        {...tabs.getPanelProps("overview")}
        className="ref-workspace-panel"
      >
        <header className="ref-panel-heading">
          <p className="ref-panel-kicker">Program pulse</p>
          <h2>
            Review historical records beside the stored milestone snapshot.
          </h2>
          <p>
            Existing recorded activity and authenticated configuration stay
            together for inspection. Neither is presented as proof of live
            attribution or reward delivery.
          </p>
        </header>
        <ReferralStatsCards />
        <ProgramSnapshot milestones={milestones} state={state} />
      </section>

      <section
        {...tabs.getPanelProps("advocates")}
        className="ref-workspace-panel"
      >
        <header className="ref-panel-heading">
          <p className="ref-panel-kicker">Advocate signal</p>
          <h2>
            Compare historical credited records without exposing identities.
          </h2>
          <p>
            Review server-masked ranks across creation-time windows while
            keeping full addresses out of the ranking surface.
          </p>
        </header>
        <LeaderboardCard />
      </section>

      <section
        {...tabs.getPanelProps("rewards")}
        className="ref-workspace-panel"
      >
        <header className="ref-panel-heading">
          <p className="ref-panel-kicker">Reward operations</p>
          <h2>Qualify immutable reward evidence before fulfillment.</h2>
          <p>
            No payout queue is mounted here. Non-mutating reads, earning and
            value snapshots, actor evidence, and retry-safe receipts must be
            qualified before controls are released.
          </p>
        </header>
        <RewardsWorkspace />
      </section>

      <section
        {...tabs.getPanelProps("distribution")}
        className="ref-workspace-panel"
      >
        <DistributionWorkspace
          canInstall={canInstall}
          installReasonId={installReasonId}
          onInstallWebsite={onInstallWebsite}
        />
      </section>
    </div>
  );
}
