// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useMemo, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  History,
  PencilLine,
  Send,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import { listAuditLog, type AuditRow } from "@/lib/audit-api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import type { Campaign } from "@/lib/campaigns-api";
import { STALE } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";

/**
 * Campaign lifecycle timeline (CAMP-044). Derived from the campaign's own
 * timestamps (created / last-edited / scheduled / sent) since the backend
 * `/events` route is an SSE metrics stream, not a per-user audit log. The
 * "who changed what" half is `CampaignAuditFeed` below, which reads the
 * tenant audit log scoped to this campaign.
 */
interface TimelineEntry {
  key: string;
  label: string;
  iso: string;
  icon: typeof Send;
}

function buildEntries(campaign: Campaign): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    {
      key: "created",
      label: "Campaign created",
      iso: campaign.created_at,
      icon: FilePlus2,
    },
  ];
  if (campaign.scheduled_at) {
    entries.push({
      key: "scheduled",
      label: "Scheduled to send",
      iso: campaign.scheduled_at,
      icon: CalendarClock,
    });
  }
  if (campaign.sent_at) {
    entries.push({
      key: "sent",
      label: "Sent",
      iso: campaign.sent_at,
      icon: Send,
    });
  }
  if (
    campaign.updated_at &&
    campaign.updated_at !== campaign.created_at &&
    campaign.updated_at !== campaign.sent_at
  ) {
    entries.push({
      key: "updated",
      label: "Last edited",
      iso: campaign.updated_at,
      icon: PencilLine,
    });
  }
  return entries
    .filter((e) => e.iso && !Number.isNaN(new Date(e.iso).getTime()))
    .sort((a, b) => new Date(a.iso).getTime() - new Date(b.iso).getTime());
}

export function CampaignActivityTimeline({ campaign }: { campaign: Campaign }) {
  const entries = buildEntries(campaign);
  if (entries.length === 0) return null;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4" />
        <h2 className="text-base font-semibold">Activity</h2>
      </div>
      <ol className="space-y-3">
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <li key={entry.key} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Icon className="h-4 w-4" />
              </span>
              <div>
                <div className="font-medium">{entry.label}</div>
                <div
                  className="text-xs text-muted-foreground"
                  title={absoluteTime(entry.iso)}
                >
                  {timeAgo(entry.iso) || absoluteTime(entry.iso)}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------------------
 * Audit-scoped activity feed — parity row campaigns-62 (desktop
 * CampaignActivityFeed).
 * ---------------------------------------------------------------------- */

/** Desktop's back-fill size (campaign-activity-feed-helpers RING_CAP). */
export const CAMPAIGN_AUDIT_FEED_LIMIT = 20;

export const CAMPAIGN_AUDIT_RESTRICTED_MESSAGE =
  "The audit trail is limited to owners and admins: its rows carry actor identities, and the server requires the audit PII scope to list them. The lifecycle above comes from the campaign record itself.";

/**
 * Whether this identity may list audit rows. `GET /api/v1/audit` is gated on
 * audit:read + audit:read_pii, and read_pii is an admin-tier scope on the
 * session path, so only a non-viewer owner/admin is allowed. Anyone else is
 * told so instead of being handed a 403.
 */
export function canReadCampaignAudit(identity: MeResponse | null): boolean {
  if (!identity || identity.viewer_mode === true) return false;
  const role = effectiveAuthRole(identity);
  return role === "owner" || role === "admin";
}

/** "campaign.scheduled.personalized" → "Campaign scheduled personalized". */
export function describeAuditAction(action: string): string {
  const words = action.replace(/[._]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Audit event";
}

function auditActor(row: AuditRow): string {
  return row.actorLabel?.trim() || row.actorType || "system";
}

/**
 * Who did what to this campaign, newest first: the tenant audit log filtered
 * to `resource_type=campaign&resource_id={id}`, the same back-fill desktop's
 * slideover runs. Collapsible, like desktop's; collapsing stops the read.
 *
 * Desktop additionally tails its event bus; web has no bus, so this feed is a
 * read that refreshes on focus and on demand, and says so rather than
 * pretending to be live.
 */
export function CampaignAuditFeed({
  campaignId,
  campaignKey,
  identity,
  identityReady,
}: {
  campaignId: string;
  campaignKey: readonly unknown[];
  identity: MeResponse | null;
  identityReady: boolean;
}) {
  const listId = useId();
  const [open, setOpen] = useState(true);
  const canRead = canReadCampaignAudit(identity);
  const auditKey = useMemo(
    () => [...campaignKey, "audit", CAMPAIGN_AUDIT_FEED_LIMIT] as const,
    [campaignKey],
  );
  const auditQuery = useQuery({
    queryKey: auditKey,
    queryFn: ({ signal }) =>
      listAuditLog(
        {
          resourceType: "campaign",
          resourceId: campaignId,
          limit: CAMPAIGN_AUDIT_FEED_LIMIT,
        },
        { signal },
      ),
    enabled: identityReady && canRead && open && campaignId !== "",
    staleTime: STALE.list,
  });
  const rows = Array.isArray(auditQuery.data?.rows) ? auditQuery.data.rows : [];

  return (
    <section
      className="rounded-md border bg-card p-4"
      data-testid="campaign-audit-feed"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDown className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden />
          )}
          <History className="h-4 w-4" aria-hidden />
          <span className="text-base font-semibold">Audit trail</span>
          {rows.length > 0 ? (
            <span className="tabular-nums text-muted-foreground">
              {rows.length}
            </span>
          ) : null}
        </Button>
        <span className="flex-1" />
        {open && canRead && identityReady ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={auditQuery.isFetching}
            onClick={() => void auditQuery.refetch()}
          >
            {auditQuery.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        ) : null}
      </div>

      <div id={listId} hidden={!open} className="mt-3">
        {!identityReady ? (
          <p className="text-sm text-muted-foreground">Checking your access…</p>
        ) : !canRead ? (
          <p className="text-sm text-muted-foreground">
            {CAMPAIGN_AUDIT_RESTRICTED_MESSAGE}
          </p>
        ) : auditQuery.isPending ? (
          <div role="status" aria-label="Loading the audit trail" className="grid gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : auditQuery.isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p className="text-destructive">
              Couldn&apos;t load the audit trail:{" "}
              {apiErrorMessage(auditQuery.error)}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void auditQuery.refetch()}
            >
              Retry the audit trail
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No audited changes to this campaign yet.
          </p>
        ) : (
          <ol className="divide-y text-sm">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-baseline justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <span className="text-muted-foreground">{auditActor(row)}</span>{" "}
                  <span className="font-medium">
                    {describeAuditAction(row.action)}
                  </span>
                </div>
                <span
                  className="shrink-0 text-xs text-muted-foreground"
                  title={absoluteTime(row.at)}
                >
                  {timeAgo(row.at) || absoluteTime(row.at)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
