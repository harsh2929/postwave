// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  ChevronsUpDown,
  Copy,
  FlaskConical,
  FolderInput,
  Pause,
  Play,
  Plus,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { RelativeTime } from "@/components/relative-time";
import type { Campaign, CreateCampaignInput } from "@/lib/campaigns-api";

import {
  campaignRate,
  type CampaignRateKey,
  campaignStatusLabel,
  campaignStatusVariant,
  type CampaignSortKey,
  type SortOrder,
} from "./campaign-list-helpers";

const SENT_STATUSES: readonly Campaign["status"][] = ["sent", "sending"];

/** Header + body columns: select, campaign, status, subject, open, click, updated, actions. */
const COLUMN_COUNT = 8;

/**
 * A list rate (the 0..1 fraction the list endpoint sends) as a percentage, or
 * an em dash when the server sent none — "no rate yet" is not "0%".
 */
function RateCell({
  campaign,
  rateKey,
}: {
  campaign: Campaign;
  rateKey: CampaignRateKey;
}) {
  const rate = campaignRate(campaign, rateKey);
  return (
    <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-muted-foreground">
      {rate === null ? (
        <span title="No rate yet">—</span>
      ) : (
        `${(rate * 100).toFixed(1)}%`
      )}
    </td>
  );
}

/** A/B setup only makes sense for still-editable, A/B-capable campaigns. */
function canRunAbTest(campaign: Campaign): boolean {
  if (
    SENT_STATUSES.includes(campaign.status) ||
    campaign.status === "cancelled"
  ) {
    return false;
  }
  return (
    campaign.campaign_type === "ab_test" ||
    campaign.campaign_type === undefined ||
    campaign.campaign_type === "regular"
  );
}

export function CampaignsTable({
  canWrite,
  campaigns,
  failedCampaignCreates,
  loading,
  hasFilter,
  filterKind,
  searchTerm,
  onClearFilters,
  activeCampaignId,
  selected,
  allOnPageSelected,
  onToggleRow,
  onToggleAllOnPage,
  sort,
  order,
  onSort,
  onDeleteCampaign,
  onDuplicateCampaign,
  onMoveCampaign,
  onOpenCreate,
  onRetryCreate,
  onSelectCampaign,
  onTransitionCampaign,
  pendingCampaignCreates,
  readOnlyMessage,
  transitioningId,
}: {
  canWrite: boolean;
  campaigns: readonly Campaign[];
  failedCampaignCreates: readonly CreateCampaignInput[];
  loading: boolean;
  hasFilter: boolean;
  filterKind: "search" | "status" | "none";
  searchTerm: string;
  onClearFilters: () => void;
  activeCampaignId: string | null;
  selected: Set<string>;
  allOnPageSelected: boolean;
  onToggleRow: (id: string) => void;
  onToggleAllOnPage: () => void;
  sort: CampaignSortKey;
  order: SortOrder;
  onSort: (key: CampaignSortKey) => void;
  onDeleteCampaign: (campaign: Campaign) => void | Promise<void>;
  onDuplicateCampaign: (campaign: Campaign) => void | Promise<void>;
  /** Opens the folder picker for one campaign. */
  onMoveCampaign: (campaign: Campaign) => void;
  onOpenCreate: () => void;
  onRetryCreate: (input: CreateCampaignInput) => void;
  onSelectCampaign: (campaign: Campaign) => void;
  onTransitionCampaign: (
    campaign: Campaign,
    action: "pause" | "resume" | "cancel",
  ) => void | Promise<void>;
  pendingCampaignCreates: readonly CreateCampaignInput[];
  readOnlyMessage: string;
  transitioningId: string | null;
}) {
  const someSelected = selected.size > 0 && !allOnPageSelected;
  // Clone is a plain POST with no idempotency key, so a second click before the
  // first response lands creates a second draft the operator never learns about
  // (only one toast's "Open" action survives, and the second router.push wins).
  // The ref closes the window between the click and the re-render that state
  // alone would leave open.
  const duplicatingRef = useRef<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const handleDuplicateClick = useCallback(
    async (campaign: Campaign) => {
      if (duplicatingRef.current !== null) return;
      duplicatingRef.current = campaign.id;
      setDuplicatingId(campaign.id);
      try {
        await onDuplicateCampaign(campaign);
      } finally {
        duplicatingRef.current = null;
        setDuplicatingId(null);
      }
    },
    [onDuplicateCampaign],
  );
  const empty =
    campaigns.length === 0 &&
    pendingCampaignCreates.length === 0 &&
    failedCampaignCreates.length === 0;

  return (
    <div
      role="region"
      aria-label="Campaigns"
      tabIndex={0}
      className="overflow-x-auto rounded-md border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th scope="col" className="w-10 px-4 py-2">
              <Checkbox
                aria-label="Select all campaigns on this page"
                className="h-6 w-6"
                checked={allOnPageSelected}
                disabled={!canWrite}
                indeterminate={someSelected}
                onChange={onToggleAllOnPage}
                title={!canWrite ? readOnlyMessage : undefined}
              />
            </th>
            <SortHeader
              label="Campaign"
              sortKey="name"
              sort={sort}
              order={order}
              onSort={onSort}
            />
            <SortHeader
              label="Status"
              sortKey="status"
              sort={sort}
              order={order}
              onSort={onSort}
            />
            <SortHeader
              label="Subject"
              sortKey="subject"
              sort={sort}
              order={order}
              onSort={onSort}
            />
            <SortHeader
              label="Open rate"
              sortKey="open_rate"
              sort={sort}
              order={order}
              onSort={onSort}
            />
            <SortHeader
              label="Click rate"
              sortKey="click_rate"
              sort={sort}
              order={order}
              onSort={onSort}
            />
            <SortHeader
              label="Updated"
              sortKey="updated_at"
              sort={sort}
              order={order}
              onSort={onSort}
            />
            <th scope="col" className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {pendingCampaignCreates.map((vars, index) => (
            <tr
              key={`pending-camp-${vars.name}-${index}`}
              className="pw-pending-row"
              aria-label={`Creating ${vars.name}`}
            >
              <td className="px-4 py-3" />
              <td className="px-4 py-3 font-medium">{vars.name}</td>
              <td className="px-4 py-3">
                <Badge variant="outline">Saving</Badge>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {vars.subject}
              </td>
              <td className="px-4 py-3" />
              <td className="px-4 py-3" />
              <td className="px-4 py-3 text-muted-foreground">-</td>
              <td className="px-4 py-3" />
            </tr>
          ))}
          {failedCampaignCreates.map((vars, index) => (
            <tr
              key={`failed-camp-${vars.name}-${index}`}
              className="pw-failed-row"
              aria-label={`Failed to create ${vars.name}`}
            >
              <td className="px-4 py-3" />
              <td className="px-4 py-3 font-medium">{vars.name}</td>
              <td className="px-4 py-3">
                <Badge variant="destructive">Failed</Badge>
              </td>
              <td className="px-4 py-3" colSpan={4}>
                <button
                  type="button"
                  className="pw-retry-link"
                  disabled={!canWrite}
                  title={!canWrite ? readOnlyMessage : undefined}
                  onClick={() => onRetryCreate(vars)}
                >
                  Sync failed - Retry
                </button>
              </td>
              <td className="px-4 py-3" />
            </tr>
          ))}
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <tr key={`camp-sk-${i}`} aria-hidden>
                <td className="px-4 py-3.5">
                  <div className="h-4 w-4 rounded bg-muted" />
                </td>
                <td className="px-4 py-3.5">
                  <div className="h-4 w-40 rounded bg-muted" />
                </td>
                <td className="px-4 py-3.5">
                  <div className="h-5 w-16 rounded-full bg-muted" />
                </td>
                <td className="px-4 py-3.5">
                  <div className="h-4 w-56 rounded bg-muted" />
                </td>
                <td className="px-4 py-3.5">
                  <div className="ml-auto h-4 w-10 rounded bg-muted" />
                </td>
                <td className="px-4 py-3.5">
                  <div className="ml-auto h-4 w-10 rounded bg-muted" />
                </td>
                <td className="px-4 py-3.5">
                  <div className="h-4 w-20 rounded bg-muted" />
                </td>
                <td className="px-4 py-3.5">
                  <div className="ml-auto h-4 w-20 rounded bg-muted" />
                </td>
              </tr>
            ))
          ) : empty ? (
            <tr>
              <td className="px-4 py-8" colSpan={COLUMN_COUNT}>
                {hasFilter ? (
                  <div className="py-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      {filterKind === "search" && searchTerm
                        ? `No campaigns match “${searchTerm}”.`
                        : "No campaigns match this filter."}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={onClearFilters}
                    >
                      {filterKind === "search"
                        ? "Clear search"
                        : "Clear filter"}
                    </Button>
                  </div>
                ) : (
                  <EmptyState
                    icon={Send}
                    title="No campaigns yet"
                    description="Your sent and scheduled campaigns land here. Compose your first one - it only takes a minute."
                    action={
                      <Button
                        type="button"
                        disabled={!canWrite}
                        title={!canWrite ? readOnlyMessage : undefined}
                        onClick={onOpenCreate}
                      >
                        <Plus className="h-4 w-4" />
                        New campaign
                      </Button>
                    }
                  />
                )}
              </td>
            </tr>
          ) : (
            campaigns.map((campaign) => {
              const isSelected = selected.has(campaign.id);
              const isActive = activeCampaignId === campaign.id;
              const isSent = SENT_STATUSES.includes(campaign.status);
              return (
                <tr
                  key={campaign.id}
                  data-testid="campaign-row"
                  data-id={campaign.id}
                  data-status={campaign.status}
                  aria-selected={isActive}
                  // Selecting a row is not decoration: it reveals
                  // SelectedCampaignActions, which is the ONLY route to
                  // Schedule and Send from this page. Mouse-only selection
                  // therefore put both verbs out of reach of a keyboard user
                  // (WCAG 2.1.1). The row carries aria-selected already, so it
                  // is a selectable thing; tabIndex makes it reachable and the
                  // keydown handler makes it activatable.
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    // Only when the ROW itself has focus. With focus on the
                    // name link or an action button, the browser synthesises
                    // that control's own activation and stealing the key here
                    // would fire two different things off one press.
                    if (event.target !== event.currentTarget) return;
                    // Space scrolls the page by default.
                    event.preventDefault();
                    onSelectCampaign(campaign);
                  }}
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (
                      target.closest("button") ||
                      target.closest("a") ||
                      target.closest("input")
                    ) {
                      return;
                    }
                    onSelectCampaign(campaign);
                  }}
                  className={`cursor-pointer transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                    isActive
                      ? "bg-primary/5 ring-1 ring-inset ring-primary/30"
                      : isSelected
                        ? "bg-primary/5"
                        : ""
                  }`}
                >
                  <td className="w-10 px-4 py-3">
                    <Checkbox
                      aria-label={`Select ${campaign.name}`}
                      className="h-6 w-6"
                      checked={isSelected}
                      disabled={!canWrite}
                      onChange={() => onToggleRow(campaign.id)}
                      title={!canWrite ? readOnlyMessage : undefined}
                    />
                  </td>
                  <td className="max-w-[16rem] px-4 py-3">
                    <Link
                      href={`/app/campaigns/${campaign.id}`}
                      title={campaign.name}
                      className="flex min-h-8 items-center truncate font-medium underline-offset-4 hover:underline"
                    >
                      {campaign.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {/* No sr-only status echo: StatusBadge already renders the
                        status as visible text, and `campaignStatusLabel` is
                        just the capitalised status — so the extra span made a
                        screen reader announce "Draft - draft" on every row.
                        Seen in the accessibility tree while walking the page
                        with real data on 2026-08-21. */}
                    <StatusBadge status={campaign.status} />
                  </td>
                  <td
                    className="max-w-[20rem] truncate px-4 py-3 text-muted-foreground"
                    title={campaign.subject}
                  >
                    {campaign.subject}
                  </td>
                  <RateCell campaign={campaign} rateKey="open_rate" />
                  <RateCell campaign={campaign} rateKey="click_rate" />
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    <RelativeTime iso={campaign.updated_at} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {campaign.status === "sending" ||
                      campaign.status === "scheduled" ? (
                        <Tooltip label="Pause">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Pause"
                            disabled={
                              !canWrite || transitioningId === campaign.id
                            }
                            title={!canWrite ? readOnlyMessage : undefined}
                            onClick={() =>
                              void onTransitionCampaign(campaign, "pause")
                            }
                          >
                            <Pause className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                      ) : null}
                      {campaign.status === "paused" ? (
                        <Tooltip label="Resume">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Resume"
                            disabled={
                              !canWrite || transitioningId === campaign.id
                            }
                            title={!canWrite ? readOnlyMessage : undefined}
                            onClick={() =>
                              void onTransitionCampaign(campaign, "resume")
                            }
                          >
                            <Play className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                      ) : null}
                      {isSent ? (
                        <Tooltip label="View report">
                          <Button
                            asChild
                            variant="ghost"
                            size="icon"
                            aria-label="View report"
                          >
                            <Link
                              href={`/app/campaigns/${campaign.id}/analytics`}
                            >
                              <BarChart3 className="h-4 w-4" />
                            </Link>
                          </Button>
                        </Tooltip>
                      ) : null}
                      {["draft", "scheduled", "sending", "paused"].includes(
                        campaign.status,
                      ) ? (
                        <ConfirmDialog
                          title="Cancel campaign?"
                          description={`"${campaign.name}" will stop sending and cannot be resumed.`}
                          confirmLabel="Cancel campaign"
                          onConfirm={() =>
                            onTransitionCampaign(campaign, "cancel")
                          }
                          trigger={
                            <Tooltip label="Cancel campaign">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label="Cancel campaign"
                                disabled={
                                  !canWrite || transitioningId === campaign.id
                                }
                                title={!canWrite ? readOnlyMessage : undefined}
                              >
                                <XCircle className="h-4 w-4" />
                              </Button>
                            </Tooltip>
                          }
                        />
                      ) : null}
                      <Tooltip label="Duplicate">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Duplicate ${campaign.name}`}
                          disabled={!canWrite || duplicatingId === campaign.id}
                          title={!canWrite ? readOnlyMessage : undefined}
                          onClick={() => void handleDuplicateClick(campaign)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </Tooltip>
                      <Tooltip label="Move to folder">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Move ${campaign.name} to a folder`}
                          disabled={!canWrite}
                          title={!canWrite ? readOnlyMessage : undefined}
                          onClick={() => onMoveCampaign(campaign)}
                        >
                          <FolderInput className="h-4 w-4" />
                        </Button>
                      </Tooltip>
                      {canRunAbTest(campaign) && canWrite ? (
                        <Tooltip label="A/B test">
                          <Button
                            asChild
                            variant="ghost"
                            size="icon"
                            aria-label="A/B test"
                          >
                            <Link href={`/app/campaigns/${campaign.id}/ab`}>
                              <FlaskConical className="h-4 w-4" />
                            </Link>
                          </Button>
                        </Tooltip>
                      ) : null}
                      <ConfirmDialog
                        title="Delete campaign?"
                        // The list holds the delete for a few seconds and offers
                        // Undo, so "this cannot be undone" was wrong at the one
                        // moment it mattered. Past the window it is true, which
                        // is what the second sentence says.
                        description={`"${campaign.name}" will be removed from this workspace. You can undo it for a few seconds; after that it can't be recovered.`}
                        confirmLabel="Delete"
                        onConfirm={() => onDeleteCampaign(campaign)}
                        trigger={
                          <Tooltip label="Delete">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${campaign.name}`}
                              className="text-destructive hover:text-destructive"
                              disabled={!canWrite}
                              title={!canWrite ? readOnlyMessage : undefined}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </Tooltip>
                        }
                      />
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  order,
  onSort,
}: {
  label: string;
  sortKey: CampaignSortKey;
  sort: CampaignSortKey;
  order: SortOrder;
  onSort: (key: CampaignSortKey) => void;
}) {
  const active = sort === sortKey;
  return (
    <th
      scope="col"
      aria-sort={
        active ? (order === "asc" ? "ascending" : "descending") : undefined
      }
      className="px-4 py-2 text-left font-medium"
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex min-h-8 items-center gap-1 rounded-sm py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active ? (
          order === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </th>
  );
}

function StatusBadge({ status }: { status: Campaign["status"] }) {
  return (
    <Badge variant={campaignStatusVariant(status)}>
      {campaignStatusLabel(status)}
    </Badge>
  );
}
