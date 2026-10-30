import { type ReactElement, useId } from "react";

import { SectionHeader } from "../../components/SectionHeader";
import type { ReferralMilestone } from "../../lib/api-client";
import { fmtDateTime } from "../../lib/format-date";
import { KIND_LABELS, parseReward } from "./referral-program";
import type { ReferralProgramState } from "./useReferralProgramController";

import "../../styles-action-availability.css";

const COLUMNS = "120px 1fr 160px 100px";

interface ReferralProgramOverviewProps {
  canMutate: boolean;
  milestones: ReferralMilestone[];
  onCreate: () => void;
  onEdit: (index?: number) => void;
  onRemove: (count: number) => void;
  state: ReferralProgramState;
}

function MilestoneActions({
  canMutate,
  count,
  index,
  onEdit,
  onRemove,
}: {
  canMutate: boolean;
  count: number;
  index: number;
  onEdit: (index?: number) => void;
  onRemove: (count: number) => void;
}): ReactElement {
  const permissionReasonId = useId();
  return (
    <div className="list-row-actions">
      <button
        type="button"
        className="list-row-action pw-discoverable-unavailable"
        aria-label={`Edit milestone at ${count} referrals`}
        aria-disabled={!canMutate || undefined}
        aria-describedby={!canMutate ? permissionReasonId : undefined}
        onClick={() => {
          if (canMutate) onEdit(index);
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      </button>
      <button
        type="button"
        className="list-row-action danger pw-discoverable-unavailable"
        aria-label={`Remove milestone at ${count} referrals`}
        aria-disabled={!canMutate || undefined}
        aria-describedby={!canMutate ? permissionReasonId : undefined}
        onClick={() => {
          if (canMutate) onRemove(count);
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        </svg>
      </button>
      {!canMutate ? (
        <span id={permissionReasonId} className="visually-hidden">
          Program changes require workspace-admin access and a currently
          verified program response. You can inspect this milestone but cannot
          edit or remove it now.
        </span>
      ) : null}
    </div>
  );
}

function MilestoneList({
  canMutate,
  milestones,
  onEdit,
  onRemove,
}: Pick<
  ReferralProgramOverviewProps,
  "canMutate" | "milestones" | "onEdit" | "onRemove"
>): ReactElement | null {
  if (milestones.length === 0) return null;
  return (
    <>
      <SectionHeader
        title="Milestones"
        description="Stored reward thresholds from the last verified program configuration, sorted from lowest to highest."
        helpText="These are configuration records for inspection. Live signup qualification, immutable reward grants, and fulfillment remain review-gated."
        actions={
          canMutate ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onEdit()}
            >
              Add milestone
            </button>
          ) : null
        }
      />
      <div className="list">
        <div className="list-header" style={{ gridTemplateColumns: COLUMNS }}>
          <div>Referrals</div>
          <div>Reward</div>
          <div>Kind</div>
          <div></div>
        </div>
        {milestones.map((milestone, index) => {
          const parsed = parseReward(milestone.reward_label);
          const kind = milestone.reward_kind ?? parsed.kind;
          const label =
            milestone.reward_kind && parsed.kind === milestone.reward_kind
              ? parsed.label
              : milestone.reward_kind
                ? milestone.reward_label
                : parsed.label;
          return (
            <div
              key={milestone.count}
              className="list-row"
              style={{ gridTemplateColumns: COLUMNS }}
            >
              <div className="tabular">{milestone.count.toLocaleString()}</div>
              <div
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {label || milestone.reward_label || "-"}
              </div>
              <div className="muted">{KIND_LABELS[kind]}</div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 6,
                }}
              >
                <MilestoneActions
                  canMutate={canMutate}
                  count={milestone.count}
                  index={index}
                  onEdit={onEdit}
                  onRemove={onRemove}
                />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function ReferralProgramOverview({
  canMutate,
  milestones,
  onCreate,
  onEdit,
  onRemove,
  state,
}: ReferralProgramOverviewProps): ReactElement {
  if (state.loading && !state.program) {
    return (
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div
          className="skel"
          style={{ height: 14, width: 140, marginBottom: 8 }}
        />
        <div className="skel" style={{ height: 12, width: 220 }} />
      </div>
    );
  }
  if (state.error && !state.program) {
    return (
      <div className="empty-state" style={{ marginBottom: 16 }}>
        <div className="empty-state-icon">·</div>
        <h3>Program unavailable</h3>
        <p>
          The current program could not be verified. Retry the read before
          making changes so an existing configuration is never overwritten.
        </p>
      </div>
    );
  }
  if (state.empty) {
    return (
      <div className="empty-state" style={{ marginBottom: 16 }}>
        <div className="empty-state-icon">·</div>
        <h3>No saved referral program</h3>
        <p>
          No active configuration was returned. Historical inspection remains
          available; new program activation stays unavailable until the live
          attribution and reward runtime is release-qualified.
        </p>
        {canMutate ? (
          <button type="button" className="btn btn-primary" onClick={onCreate}>
            Create program
          </button>
        ) : null}
      </div>
    );
  }
  if (!state.program) return <></>;
  return (
    <>
      {state.error ? (
        <div className="notice" role="alert">
          <span>
            Refresh failed. Showing the last verified program; changes remain
            unavailable until the latest version is confirmed.
          </span>
        </div>
      ) : state.loading ? (
        <div className="notice" role="status" aria-live="polite">
          <span>Refreshing program · showing the last verified version</span>
        </div>
      ) : null}
      <div
        className="card"
        style={{
          padding: 16,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Active program
            </span>
            <span className="badge success">Active</span>
          </div>
          <div className="muted tabular" style={{ fontSize: 12, marginTop: 4 }}>
            {milestones.length} milestone{milestones.length === 1 ? "" : "s"} ·
            Updated {fmtDateTime(state.program.updatedAt)}
          </div>
        </div>
        {canMutate ? (
          <button type="button" className="btn" onClick={() => onEdit()}>
            Edit
          </button>
        ) : null}
      </div>
      <MilestoneList
        canMutate={canMutate}
        milestones={milestones}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    </>
  );
}
