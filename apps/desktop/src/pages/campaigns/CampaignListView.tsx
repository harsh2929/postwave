import type { ReactElement } from "react";

import { RateBar } from "../../components/dashboard/RateBar";
import { HeroEmptyState } from "../../components/HeroEmptyState";
import { fmtDayMonth } from "../../lib/format-date";
import { HERO } from "../../lib/heroAssets";
import type { Campaign } from "../../lib/api-client";
import { isResendEligible } from "../campaigns-row-actions";
import {
  CAMPAIGN_LIST_COLUMNS,
  type CampaignSortKey,
  campaignRowId,
  campaignStatusBadge,
  formatCampaignPercent,
  isCampaignAbTest,
} from "./campaigns-page-utils";
import type { CampaignsControllerProps } from "./campaigns-page-types";
import "../../styles-action-availability.css";

const CAMPAIGN_LIST_MIN_WIDTH = 880;

function CampaignListHeader({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state, view } = controller;
  const columns: Array<[CampaignSortKey, string]> = [
    ["name", "Name"],
    ["status", "Status"],
    ["sent", "Sent"],
    ["open", "Open"],
    ["click", "Click"],
  ];
  return (
    <div
      className="list-header"
      style={{
        gridTemplateColumns: CAMPAIGN_LIST_COLUMNS,
        minWidth: CAMPAIGN_LIST_MIN_WIDTH,
      }}
    >
      <div>
        <input
          type="checkbox"
          aria-label="Select all on page"
          checked={view.allPageSelected}
          onChange={controller.bulkActions.toggleSelectAll}
        />
      </div>
      {columns.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="pw-sort-th"
          onClick={() => controller.bulkActions.toggleSort(key)}
          aria-label={
            state.sortBy === key
              ? `${label}, sorted ${state.sortDir === "asc" ? "ascending" : "descending"}. Activate to reverse the order.`
              : `Sort by ${label}`
          }
        >
          {label}
          {state.sortBy === key ? (state.sortDir === "asc" ? " ▲" : " ▼") : ""}
        </button>
      ))}
      <div aria-hidden="true" />
    </div>
  );
}

function CampaignMutationRows({
  controller,
}: CampaignsControllerProps): ReactElement {
  return (
    <>
      {controller.creation.pendingCampaignCreates.map((variables, index) => (
        <div
          key={`pending-camp-${variables.name}-${index}`}
          className="list-row pw-pending-row"
          style={{
            gridTemplateColumns: CAMPAIGN_LIST_COLUMNS,
            minWidth: CAMPAIGN_LIST_MIN_WIDTH,
            pointerEvents: "none",
          }}
          aria-label={`Creating ${variables.name}`}
        >
          <div />
          <div
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {variables.name}
          </div>
          <div>
            <span className="badge">Saving…</span>
          </div>
          <div className="muted">—</div>
          <div className="muted">—</div>
          <div className="muted">—</div>
          <div className="muted">You</div>
        </div>
      ))}
      {controller.creation.failedCampaignCreates.map((variables, index) => (
        <div
          key={`failed-camp-${variables.name}-${index}`}
          className="list-row pw-failed-row"
          style={{
            gridTemplateColumns: CAMPAIGN_LIST_COLUMNS,
            minWidth: CAMPAIGN_LIST_MIN_WIDTH,
          }}
          aria-label={`Failed to create ${variables.name}`}
        >
          <div />
          <div
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {variables.name}
            <button
              type="button"
              className="pw-retry-link"
              disabled={!controller.canMutate}
              aria-describedby={
                !controller.canMutate
                  ? "campaign-create-retry-guidance"
                  : undefined
              }
              onClick={() => {
                if (!controller.canMutate) return;
                void controller.creation.createCampaignMut
                  .mutateAsync(variables)
                  .catch(() => {
                    /* surfaced via failed-row */
                  });
              }}
            >
              Sync failed — Retry
            </button>
          </div>
          <div>
            <span className="badge danger">Failed</span>
          </div>
          <div className="muted">—</div>
          <div className="muted">—</div>
          <div className="muted">—</div>
          <div className="muted">You</div>
        </div>
      ))}
    </>
  );
}

function CampaignLoadingRows(): ReactElement {
  return (
    <div>
      {[0, 1, 2, 3, 4].map((index) => (
        <div
          key={index}
          className="skel-row"
          style={{
            gridTemplateColumns: CAMPAIGN_LIST_COLUMNS,
            minWidth: CAMPAIGN_LIST_MIN_WIDTH,
          }}
        >
          <div className="skel skel-cell lg" />
          <div className="skel skel-cell sm" />
          <div className="skel skel-cell sm" />
          <div className="skel skel-cell sm" />
          <div className="skel skel-cell sm" />
          <div className="skel skel-cell" />
        </div>
      ))}
    </div>
  );
}

function CampaignEmptyRows({
  controller,
}: CampaignsControllerProps): ReactElement {
  if (controller.state.stale) {
    return (
      <div className="list-empty">
        <div className="empty-state">
          <div className="empty-state-icon">!</div>
          <h3>
            {controller.state.query
              ? "No matches in the retained snapshot"
              : "No campaigns in the retained snapshot"}
          </h3>
          <p>
            Refresh failed, so this is not a verified current empty state. Try
            again before acting on the absence of campaigns.
          </p>
        </div>
      </div>
    );
  }
  if (controller.state.query) {
    return (
      <div className="list-empty">
        <div className="empty-state">
          <div className="empty-state-icon">·</div>
          <h3>No matches for &ldquo;{controller.state.query}&rdquo;</h3>
          <p>Clear search to see all campaigns.</p>
        </div>
      </div>
    );
  }
  return (
    <HeroEmptyState
      tone="blue"
      eyebrow="Send"
      title="Ship campaigns that land — and prove it."
      subtitle="Every send tracks opens, clicks, bounces, and revenue. A/B test from day one, no extra setup."
      primaryCta={
        controller.canMutate
          ? { label: "New campaign", onClick: controller.creation.openCreate }
          : undefined
      }
      imageSrc={HERO.campaigns}
      imageAlt="A designer's desk with a campaign editor open"
    />
  );
}

function CampaignListRow({
  campaign,
  controller,
  index,
}: CampaignsControllerProps & {
  campaign: Campaign;
  index: number;
}): ReactElement {
  const { state } = controller;
  const isAbTest = isCampaignAbTest(campaign);
  return (
    <div
      key={String(campaign.id ?? index)}
      className={`list-row${
        state.selected?.id != null && state.selected.id === campaign.id
          ? " is-selected"
          : ""
      }`}
      style={{
        gridTemplateColumns: CAMPAIGN_LIST_COLUMNS,
        minWidth: CAMPAIGN_LIST_MIN_WIDTH,
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <input
          type="checkbox"
          aria-label={`Select ${campaign.name ?? campaign.subject ?? "campaign"}`}
          checked={state.selectedIds.has(campaignRowId(campaign))}
          onChange={() =>
            controller.bulkActions.toggleSelect(campaignRowId(campaign))
          }
        />
      </div>
      <div
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "flex",
          gap: 6,
          alignItems: "center",
        }}
      >
        {campaign.name ?? campaign.subject ?? "Untitled"}
        {isAbTest ? (
          <button
            type="button"
            data-abresults-trigger="true"
            className="btn btn-xs"
            onClick={() => {
              state.setAbModalCampaign(campaign);
              state.setAbMetric("open_rate");
            }}
            aria-label={`View A/B test results for ${campaign.name ?? campaign.subject ?? "campaign"}`}
          >
            A/B Results
          </button>
        ) : null}
      </div>
      <div>{campaignStatusBadge(campaign.status)}</div>
      <div className="muted tabular">
        {fmtDayMonth(campaign.sent_at ?? campaign.created_at)}
      </div>
      <div
        className="tabular"
        style={{ display: "flex", flexDirection: "column", gap: 3 }}
        aria-label={`Open rate: ${formatCampaignPercent(campaign.open_rate)}`}
      >
        <span>{formatCampaignPercent(campaign.open_rate)}</span>
        <RateBar value={campaign.open_rate ?? null} tone="good" />
      </div>
      <div
        className="tabular muted"
        style={{ display: "flex", flexDirection: "column", gap: 3 }}
        aria-label={`Click rate: ${formatCampaignPercent(campaign.click_rate)}`}
      >
        <span>{formatCampaignPercent(campaign.click_rate)}</span>
        <RateBar value={campaign.click_rate ?? null} max={0.2} tone="good" />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 6,
          minWidth: 0,
        }}
      >
        <div className="list-row-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost pw-discoverable-unavailable"
            onClick={() => {
              if (
                !controller.canAdminMutateCampaignSnapshot ||
                state.cloningId === String(campaign.id)
              ) {
                return;
              }
              void controller.rowActions.cloneCampaign(campaign);
            }}
            aria-disabled={
              !controller.canAdminMutateCampaignSnapshot || undefined
            }
            aria-describedby={
              !controller.canAdminMutateCampaignSnapshot
                ? "campaign-list-admin-guidance"
                : undefined
            }
            disabled={
              !controller.canAdminMutateCampaignSnapshot ||
              state.cloningId === String(campaign.id)
            }
          >
            {state.cloningId === String(campaign.id) ? "Cloning…" : "Clone"}
          </button>
          {isResendEligible(campaign.status) ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost pw-discoverable-unavailable"
              onClick={() => {
                if (controller.canAdminMutateCampaignSnapshot) {
                  controller.rowActions.openResend(campaign);
                }
              }}
              aria-disabled={
                !controller.canAdminMutateCampaignSnapshot || undefined
              }
              aria-describedby={
                !controller.canAdminMutateCampaignSnapshot
                  ? "campaign-list-admin-guidance"
                  : undefined
              }
              disabled={!controller.canAdminMutateCampaignSnapshot}
            >
              Resend
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-ghost pw-discoverable-unavailable"
            disabled={!controller.canMutateCampaignSnapshot}
            onClick={() => {
              if (!controller.canMutateCampaignSnapshot) return;
              state.setMoveTarget(campaign);
              state.setMovePick(
                typeof campaign.folder_id === "string"
                  ? campaign.folder_id
                  : "",
              );
            }}
            aria-disabled={!controller.canMutateCampaignSnapshot || undefined}
            aria-describedby={
              !controller.canMutateCampaignSnapshot
                ? "campaign-list-write-guidance"
                : undefined
            }
          >
            Move
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => state.setSelected(campaign)}
            aria-label={`Open ${campaign.name ?? campaign.subject ?? "campaign"}`}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

function CampaignListContent({
  controller,
}: CampaignsControllerProps): ReactElement {
  if (controller.state.loading && !controller.state.rows)
    return <CampaignLoadingRows />;
  if (controller.state.err && !controller.state.rows) {
    return (
      <div className="list-empty">
        <div className="empty-state">
          <div className="empty-state-icon">!</div>
          <h3>Campaign data unavailable</h3>
          <p>
            No verified snapshot is available. Use Try again above to reload
            this workspace.
          </p>
        </div>
      </div>
    );
  }
  if (controller.view.pageRows.length === 0) {
    return <CampaignEmptyRows controller={controller} />;
  }
  return (
    <>
      {controller.view.pageRows.map((campaign, index) => (
        <CampaignListRow
          key={String(campaign.id ?? index)}
          campaign={campaign}
          controller={controller}
          index={index}
        />
      ))}
    </>
  );
}

export function CampaignListView({
  controller,
}: CampaignsControllerProps): ReactElement | null {
  if (controller.state.viewMode !== "list") return null;
  return (
    <>
      <div
        className="list"
        data-tour="campaigns-list"
        style={{ overflowX: "auto" }}
      >
        <CampaignListHeader controller={controller} />
        <CampaignMutationRows controller={controller} />
        <CampaignListContent controller={controller} />
      </div>
      <div className="pw-action-status" style={{ marginTop: 6 }}>
        {!controller.canMutate ? (
          <span id="campaign-create-retry-guidance">
            Ask a workspace editor or admin to retry campaign creation.
          </span>
        ) : null}{" "}
        {!controller.canAdminMutateCampaignSnapshot ? (
          <span id="campaign-list-admin-guidance">
            {controller.campaignAdminMutationUnavailableReason}
          </span>
        ) : null}{" "}
        {!controller.canMutateCampaignSnapshot ? (
          <span id="campaign-list-write-guidance">
            {controller.campaignMutationUnavailableReason}
          </span>
        ) : null}
      </div>
      <div className="pagination">
        <button
          type="button"
          className="btn btn-sm"
          disabled={controller.state.page <= 1}
          onClick={() =>
            controller.state.setPage((page) => Math.max(1, page - 1))
          }
        >
          Prev
        </button>
        <span>
          Page {controller.state.page} of {controller.view.totalPages}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={controller.state.page >= controller.view.totalPages}
          onClick={() =>
            controller.state.setPage((page) =>
              Math.min(controller.view.totalPages, page + 1),
            )
          }
        >
          Next
        </button>
      </div>
    </>
  );
}
