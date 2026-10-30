// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { campaignStatusLabel } from "@/app/(dashboard)/app/campaigns/campaign-list-helpers";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import {
  CAMPAIGN_SCHEDULING_AVAILABLE,
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
} from "@/lib/campaign-operational-availability";
import {
  CAMPAIGN_SCHEDULING_RELEASE_HOLD,
  type Campaign,
} from "@/lib/campaigns-api";
import { rescheduleCampaign } from "@/lib/campaign-schedule-api";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";

export type CampaignViewMode = "list" | "calendar";
export const CAMPAIGN_VIEW_MODES: readonly CampaignViewMode[] = [
  "list",
  "calendar",
];

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function firstOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * The local day a campaign sits on: its scheduled time, else when it was
 * sent. Null for a campaign with neither (a draft never scheduled).
 */
export function campaignCalendarDay(campaign: Campaign): string | null {
  const ref = campaign.scheduled_at ?? campaign.sent_at;
  if (!ref) return null;
  const time = Date.parse(ref);
  if (Number.isNaN(time)) return null;
  return ymd(new Date(time));
}

/** The 6-week (42-day) Sunday-first grid covering `anchor`'s month. */
export function campaignMonthCells(anchor: Date): Date[] {
  const first = firstOfMonth(anchor);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function campaignLabel(campaign: Campaign): string {
  return (
    campaign.name?.trim() || campaign.subject?.trim() || "Untitled campaign"
  );
}

/** Desktop `isDraggable`: only drafts and scheduled campaigns can move. */
export function campaignScheduleEditable(campaign: Campaign): boolean {
  const status = (campaign.status ?? "draft").toLowerCase();
  return status === "draft" || status === "scheduled";
}

/** List / Calendar switch for the campaigns page (desktop ChoiceGroup). */
export function CampaignViewToggle({
  value,
  onChange,
}: {
  value: CampaignViewMode;
  onChange: (next: CampaignViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Campaign view"
      className="inline-flex rounded-md border bg-background p-0.5"
    >
      {CAMPAIGN_VIEW_MODES.map((mode) => (
        <Button
          key={mode}
          type="button"
          size="sm"
          variant={value === mode ? "secondary" : "ghost"}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          {mode === "list" ? "List" : "Calendar"}
        </Button>
      ))}
    </div>
  );
}

const defaultNow = () => new Date();

/**
 * Month calendar of campaigns placed on their scheduled (else sent) day —
 * desktop parity campaigns-23/-24 (components/campaigns/CampaignCalendar.tsx).
 *
 * Rescheduling is release-held. Desktop's calendar carries a per-campaign
 * Reschedule control for drafts and scheduled campaigns, disabled behind
 * `CAMPAIGN_SCHEDULING_AVAILABLE = false` with the reason attached through
 * aria-describedby; web mirrors that exactly. The day picker and the real
 * POST /api/v1/campaigns/{id}/schedule only render once the flag is lifted,
 * and the transport refuses before sending while it is not. No drag handle
 * is offered in either state: drag is a pointer-only affordance the held
 * control already stands in for.
 */
export function CampaignCalendar({
  campaigns,
  now = defaultNow,
  onRescheduled,
}: {
  campaigns: readonly Campaign[];
  /** Injectable clock for the initial month and "Today". */
  now?: () => Date;
  /** Called after a successful reschedule so the host can refetch. */
  onRescheduled?: () => void | Promise<void>;
}) {
  const [anchor, setAnchor] = useState(() => firstOfMonth(now()));
  const [reschedule, setReschedule] = useState<{
    campaign: Campaign;
    date: string;
  } | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const headingId = useId();
  const holdId = useId();
  const scheduleReasonId = useId();
  const rescheduleDateId = useId();

  async function submitReschedule() {
    if (!reschedule || rescheduling || !CAMPAIGN_SCHEDULING_AVAILABLE) return;
    const at = new Date(`${reschedule.date}T09:00:00`);
    if (!reschedule.date || Number.isNaN(at.getTime())) {
      toast.error("Pick a valid day to move this campaign to.");
      return;
    }
    setRescheduling(true);
    try {
      await rescheduleCampaign(reschedule.campaign.id, at.toISOString());
      toast.success(`Moved ${campaignLabel(reschedule.campaign)}`);
      setReschedule(null);
      await onRescheduled?.();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Reschedule failed"));
    } finally {
      setRescheduling(false);
    }
  }

  const byDay = useMemo(() => {
    const map = new Map<string, Campaign[]>();
    for (const campaign of campaigns) {
      const day = campaignCalendarDay(campaign);
      if (!day) continue;
      const list = map.get(day) ?? [];
      list.push(campaign);
      map.set(day, list);
    }
    return map;
  }, [campaigns]);
  const undated = useMemo(
    () => campaigns.filter((campaign) => !campaignCalendarDay(campaign)).length,
    [campaigns],
  );

  const cells = useMemo(() => campaignMonthCells(anchor), [anchor]);
  const weeks = Array.from({ length: 6 }, (_, index) =>
    cells.slice(index * 7, index * 7 + 7),
  );
  const monthLabel = anchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const todayKey = ymd(now());

  return (
    <section
      className="grid gap-3"
      aria-labelledby={headingId}
      aria-describedby={holdId}
      data-testid="campaign-calendar"
    >
      <Alert id={holdId} variant="warning" role="status">
        <strong>Schedule changes are paused.</strong>{" "}
        {CAMPAIGN_SCHEDULING_RELEASE_HOLD} The calendar shows where campaigns
        sit; open one to review it.
      </Alert>
      {CAMPAIGN_SCHEDULING_AVAILABLE ? null : (
        <p id={scheduleReasonId} className="text-xs text-muted-foreground">
          {CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON}
        </p>
      )}
      <nav
        aria-label="Campaign calendar months"
        className="flex flex-wrap items-center gap-2"
      >
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Previous month"
          onClick={() =>
            setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))
          }
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <h2
          id={headingId}
          aria-live="polite"
          className="min-w-40 text-center text-base font-semibold"
        >
          {monthLabel}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Next month"
          onClick={() =>
            setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))
          }
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setAnchor(firstOfMonth(now()))}
        >
          Today
        </Button>
      </nav>
      <div
        role="region"
        aria-label={`${monthLabel} campaign schedule`}
        tabIndex={0}
        className="overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full min-w-[42rem] table-fixed border-collapse text-sm">
          <caption className="sr-only">{monthLabel} campaign schedule</caption>
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              {DOW.map((day) => (
                <th key={day} scope="col" className="px-2 py-1.5 font-medium">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, weekIndex) => (
              <tr key={`week-${weekIndex}`}>
                {week.map((date) => {
                  const key = ymd(date);
                  const inMonth = date.getMonth() === anchor.getMonth();
                  const items = byDay.get(key) ?? [];
                  const dayName = date.toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  });
                  return (
                    <td
                      key={key}
                      data-day={key}
                      className={cn(
                        "h-24 border-t border-l p-1 align-top first:border-l-0",
                        !inMonth && "bg-muted/20 text-muted-foreground",
                      )}
                    >
                      <div
                        className={cn(
                          "mb-1 text-xs tabular-nums",
                          key === todayKey && "font-semibold text-primary",
                        )}
                      >
                        {date.getDate()}
                      </div>
                      {items.length > 0 ? (
                        <ul
                          aria-label={`Campaigns on ${dayName}`}
                          className="grid gap-1"
                        >
                          {items.map((campaign) => {
                            const label = campaignLabel(campaign);
                            const editable = campaignScheduleEditable(campaign);
                            return (
                              <li
                                key={campaign.id}
                                className="flex min-w-0 items-stretch gap-1"
                              >
                                <Link
                                  href={asRoute(
                                    `/app/campaigns/${encodeURIComponent(campaign.id)}`,
                                  )}
                                  className="block min-w-0 grow truncate rounded border-l-2 border-primary/60 bg-muted/40 px-1.5 py-0.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  {label}
                                  <span className="text-muted-foreground">
                                    {" "}
                                    · {campaignStatusLabel(campaign.status)}
                                  </span>
                                </Link>
                                {editable ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-6 shrink-0"
                                    aria-label={`Reschedule ${label}`}
                                    disabled={
                                      rescheduling ||
                                      !CAMPAIGN_SCHEDULING_AVAILABLE
                                    }
                                    title={
                                      CAMPAIGN_SCHEDULING_AVAILABLE
                                        ? undefined
                                        : CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON
                                    }
                                    aria-describedby={
                                      CAMPAIGN_SCHEDULING_AVAILABLE
                                        ? undefined
                                        : scheduleReasonId
                                    }
                                    onClick={() =>
                                      setReschedule({
                                        campaign,
                                        date:
                                          campaignCalendarDay(campaign) ?? key,
                                      })
                                    }
                                  >
                                    <CalendarClock
                                      className="size-3.5"
                                      aria-hidden
                                    />
                                  </Button>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {undated > 0 ? (
        <p className="text-xs text-muted-foreground">
          {undated.toLocaleString()} campaign{undated === 1 ? " has" : "s have"}{" "}
          no scheduled or sent date and {undated === 1 ? "is" : "are"} not on
          the calendar. Switch to List to see {undated === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {CAMPAIGN_SCHEDULING_AVAILABLE && reschedule ? (
        <form
          aria-label={`Reschedule ${campaignLabel(reschedule.campaign)}`}
          className="flex flex-wrap items-end gap-2 rounded-md border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitReschedule();
          }}
        >
          <div>
            <Label htmlFor={rescheduleDateId}>
              New day for {campaignLabel(reschedule.campaign)}
            </Label>
            <Input
              id={rescheduleDateId}
              type="date"
              required
              value={reschedule.date}
              disabled={rescheduling}
              onChange={(event) =>
                setReschedule({ ...reschedule, date: event.target.value })
              }
            />
          </div>
          <Button type="submit" size="sm" disabled={rescheduling}>
            {rescheduling ? "Rescheduling…" : "Reschedule"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={rescheduling}
            onClick={() => setReschedule(null)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
    </section>
  );
}
