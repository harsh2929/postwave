import type { ReactElement } from "react";

import { CampaignCalendar } from "../../components/campaigns/CampaignCalendar";
import {
  ChoiceGroup,
  type ChoiceGroupOption,
} from "../../components/ChoiceGroup";
import { Notice } from "../../components/Notice";
import { PresenceIndicator } from "../../components/PresenceIndicator";
import { PendingSyncStatus } from "../../components/PendingSyncStatus";
import { StatStrip } from "../../components/StatStrip";
import type { CampaignFilter, CampaignViewMode } from "./campaigns-page-utils";
import { campaignStatusTone } from "./campaigns-page-utils";
import type { CampaignsControllerProps } from "./campaigns-page-types";

const CAMPAIGN_FILTER_OPTIONS: readonly ChoiceGroupOption<CampaignFilter>[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
  { value: "sent", label: "Sent" },
];

const CAMPAIGN_VIEW_OPTIONS: readonly ChoiceGroupOption<CampaignViewMode>[] = [
  { value: "list", label: "List" },
  { value: "calendar", label: "Calendar" },
];

function CampaignsHeader({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state, view } = controller;
  return (
    <>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div>
            <h1 className="page-title">Campaigns</h1>
            <div className="page-subtitle">
              {state.rows
                ? `${view.filtered.length.toLocaleString()} ${
                    view.filtered.length === 1 ? "campaign" : "campaigns"
                  } · ${
                    state.refreshing
                      ? "complete last-confirmed snapshot · revalidating"
                      : state.stale
                        ? "complete last-confirmed snapshot"
                        : "complete workspace snapshot"
                  }`
                : state.loading
                  ? "Loading…"
                  : "Unavailable"}
            </div>
          </div>
          <PresenceIndicator />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (!controller.canMutate) return;
            controller.creation.openCreate();
          }}
          disabled={!controller.canMutate}
          aria-disabled={!controller.canMutate || undefined}
          aria-describedby={
            !controller.canMutate ? "campaign-create-permission" : undefined
          }
          data-tour="campaigns-new-button"
        >
          New campaign
        </button>
        {!controller.canMutate ? (
          <span
            id="campaign-create-permission"
            className="muted"
            style={{ fontSize: 11 }}
          >
            Viewer access is read-only; an editor or admin can create campaigns.
          </span>
        ) : null}
      </div>
      <PendingSyncStatus resource="campaigns" />
      <StatStrip cells={view.statCells} />
    </>
  );
}

function CampaignsFilterToolbar({
  controller,
}: CampaignsControllerProps): ReactElement | null {
  const { state } = controller;
  if (!state.loading && (!state.rows || state.rows.length === 0)) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 12,
      }}
    >
      <input
        className="input"
        style={{ width: 280 }}
        placeholder="Search campaigns…"
        value={state.query}
        onChange={(event) => {
          state.setQuery(event.target.value);
          state.setPage(1);
        }}
      />
      <ChoiceGroup
        legend="Campaign status"
        value={state.filter}
        options={CAMPAIGN_FILTER_OPTIONS}
        onChange={(filter) => {
          state.setFilter(filter);
          state.setPage(1);
        }}
        className="chips"
        optionClassName="chip"
      />
      <select
        className="input"
        style={{ maxWidth: 200 }}
        value={state.folderFilter}
        onChange={(event) => {
          state.setFolderFilter(event.target.value);
          state.setPage(1);
        }}
        aria-label="Filter by folder"
      >
        <option value="">All folders</option>
        <option value="__uncategorised">Uncategorised</option>
        {state.folders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.name} ({folder.campaign_count})
          </option>
        ))}
      </select>
      <div style={{ width: 160 }}>
        <input
          className="input"
          style={{ width: "100%" }}
          placeholder="+ New folder"
          aria-label="New folder name"
          aria-describedby={
            controller.canMutateCampaignSnapshot
              ? "campaign-new-folder-help"
              : "campaign-new-folder-unavailable"
          }
          value={state.newFolderName}
          onChange={(event) => state.setNewFolderName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void controller.rowActions.createFolder();
            }
          }}
          disabled={!controller.canMutateCampaignSnapshot}
        />
        {controller.canMutateCampaignSnapshot ? (
          <span
            id="campaign-new-folder-help"
            className="muted"
            style={{ display: "block", fontSize: 11, marginTop: 2 }}
          >
            Press Enter to create.
          </span>
        ) : (
          <span
            id="campaign-new-folder-unavailable"
            className="muted"
            style={{ display: "block", fontSize: 11, marginTop: 2 }}
          >
            {controller.campaignMutationUnavailableReason}
          </span>
        )}
      </div>
      <span className="spacer" />
      <button
        type="button"
        className="btn"
        onClick={() => void controller.data.load()}
        disabled={state.loading || state.refreshing}
      >
        {state.loading || state.refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

function CampaignViewSwitcher({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <>
      <ChoiceGroup
        legend="Campaign view"
        value={state.viewMode}
        options={CAMPAIGN_VIEW_OPTIONS}
        onChange={state.setViewMode}
        className="tabs"
        optionClassName="tab"
        style={{ marginBottom: 8 }}
      />
      <div hidden={state.viewMode !== "calendar"}>
        <CampaignCalendar
          canMutate={controller.canMutateCampaignSnapshot}
          campaigns={controller.view.sorted}
          statusTone={campaignStatusTone}
          onOpen={(campaign) => state.setSelected(campaign)}
          onReschedule={(campaign, date) =>
            controller.rowActions.rescheduleFromCalendar(campaign, date)
          }
        />
      </div>
    </>
  );
}

function CampaignBulkToolbar({
  controller,
}: CampaignsControllerProps): ReactElement | null {
  const { state } = controller;
  if (state.selectedIds.size === 0) return null;
  return (
    <div
      className="pw-bulk-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        marginBottom: 8,
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        background: "var(--pw-bg-elev)",
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 13 }}>
        {state.selectedIds.size} selected
      </span>
      <span className="spacer" style={{ flex: 1 }} />
      <button
        type="button"
        className="btn btn-sm"
        disabled={state.bulkBusy || !controller.canMutateCampaignSnapshot}
        aria-describedby={
          !controller.canMutateCampaignSnapshot
            ? "campaign-bulk-write-guidance"
            : undefined
        }
        onClick={() => {
          if (!controller.canMutateCampaignSnapshot) return;
          state.setBulkMovePick("");
          state.setBulkMoveOpen(true);
        }}
      >
        Move to folder
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={state.bulkBusy || !controller.canMutateCampaignSnapshot}
        aria-describedby={
          !controller.canMutateCampaignSnapshot
            ? "campaign-bulk-write-guidance"
            : undefined
        }
        onClick={controller.bulkActions.promptBulkTag}
      >
        Tag
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={state.bulkBusy}
        onClick={() => void controller.bulkActions.bulkExportCsv()}
      >
        Export CSV
      </button>
      <button
        type="button"
        className="btn btn-sm btn-danger"
        disabled={state.bulkBusy || !controller.canMutateCampaignSnapshot}
        aria-describedby={
          !controller.canMutateCampaignSnapshot
            ? "campaign-bulk-write-guidance"
            : undefined
        }
        onClick={controller.bulkActions.promptBulkDelete}
      >
        {state.bulkBusy ? "Working…" : "Delete"}
      </button>
      {!controller.canMutateCampaignSnapshot ? (
        <span
          id="campaign-bulk-write-guidance"
          className="muted"
          style={{ fontSize: 11 }}
        >
          {controller.campaignMutationUnavailableReason}
        </span>
      ) : null}
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={controller.bulkActions.clearSelection}
      >
        Clear
      </button>
    </div>
  );
}

export function CampaignsTopPanels({
  controller,
}: CampaignsControllerProps): ReactElement {
  return (
    <>
      <CampaignsHeader controller={controller} />
      <CampaignsFilterToolbar controller={controller} />
      {controller.state.stale || controller.state.err ? (
        <Notice
          tone={controller.state.stale ? "warning" : "danger"}
          title={
            controller.state.stale
              ? "Showing last-confirmed campaigns"
              : "Campaigns are unavailable"
          }
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void controller.data.load()}
              disabled={controller.state.loading || controller.state.refreshing}
            >
              {controller.state.loading || controller.state.refreshing
                ? "Retrying…"
                : "Try again"}
            </button>
          }
          style={{ marginBottom: 12 }}
        >
          {controller.state.stale ? (
            <>
              {controller.state.refreshing
                ? "Rechecking the server. "
                : "Refresh failed. "}
              The retained snapshot contains{" "}
              {(controller.state.rows?.length ?? 0).toLocaleString()} loaded
              campaign
              {controller.state.rows?.length === 1 ? "" : "s"} and may no longer
              reflect current coverage or metrics
              {controller.state.lastConfirmedAt
                ? `; it was last confirmed at ${controller.state.lastConfirmedAt.toLocaleTimeString(
                    [],
                    { hour: "2-digit", minute: "2-digit" },
                  )}`
                : ""}
              .{controller.state.err ? ` ${controller.state.err}` : ""}
            </>
          ) : (
            <>
              No verified campaign snapshot is available.
              {controller.state.err ? ` ${controller.state.err}` : ""}
            </>
          )}
        </Notice>
      ) : null}
      <CampaignViewSwitcher controller={controller} />
      <CampaignBulkToolbar controller={controller} />
    </>
  );
}
