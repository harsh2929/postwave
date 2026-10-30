/**
 * CampaignCalendar (G13 of the campaigns 2026 pack)
 *
 * Month grid of campaigns placed on their scheduled_at (or sent_at for
 * sent ones). Click a card opens the slideover; drafts/scheduled rows
 * can be dragged to a new day to reschedule (PATCH scheduled_at via the
 * parent's onReschedule). Sent campaigns are pinned (non-draggable).
 *
 * Uses native HTML5 drag events — no DnD dependency.
 */

import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { type Campaign } from "../../lib/api-client";
import {
  CAMPAIGN_SCHEDULING_AVAILABLE,
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
} from "../../lib/campaign-operational-availability";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import { useDiscardOnlyDraftLifecycle } from "../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../ConfirmModal";

interface Props {
  canMutate: boolean;
  campaigns: Campaign[];
  /** Status color for a campaign, reusing the list's statusBadge logic. */
  statusTone: (status: string | undefined) => string;
  onOpen: (c: Campaign) => void;
  /** Reschedule a draggable campaign to the given local day (ISO). */
  onReschedule: (
    c: Campaign,
    isoDate: string,
  ) => boolean | void | Promise<boolean | void>;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** The day a campaign sits on: scheduled_at, else sent_at. */
function campaignDay(c: Campaign): string | null {
  const ref = c.scheduled_at ?? c.sent_at;
  if (!ref) return null;
  const t = Date.parse(ref);
  if (Number.isNaN(t)) return null;
  return ymd(new Date(t));
}

function isDraggable(c: Campaign): boolean {
  const s = (c.status ?? "draft").toLowerCase();
  return s === "draft" || s === "scheduled";
}

function CampaignMonthGrid({
  anchor,
  byDay,
  campaigns,
  cells,
  dragOverDay,
  monthLabel,
  operationActive,
  scheduleReasonId,
  statusTone,
  onDragOverDay,
  onDrop,
  onOpen,
  onStartReschedule,
}: {
  anchor: Date;
  byDay: ReadonlyMap<string, Campaign[]>;
  campaigns: Campaign[];
  cells: Date[];
  dragOverDay: string | null;
  monthLabel: string;
  operationActive: boolean;
  scheduleReasonId: string;
  statusTone: Props["statusTone"];
  onDragOverDay: (day: string | null) => void;
  onDrop: (campaign: Campaign, day: string) => void;
  onOpen: (campaign: Campaign) => void;
  onStartReschedule: (campaign: Campaign) => void;
}): ReactElement {
  const weeks = Array.from({ length: 6 }, (_, weekIndex) =>
    cells.slice(weekIndex * 7, weekIndex * 7 + 7),
  );
  return (
    <div
      role="grid"
      aria-label={`${monthLabel} campaign schedule`}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: 1,
        background: "var(--pw-border)",
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      <div
        role="row"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 1,
        }}
      >
        {DOW.map((day) => (
          <div
            key={day}
            role="columnheader"
            style={{
              background: "var(--pw-bg-elev)",
              padding: "4px 6px",
              fontSize: 11,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            {day}
          </div>
        ))}
      </div>
      {weeks.map((week, weekIndex) => (
        <div
          key={`week-${weekIndex}`}
          role="row"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
            gap: 1,
          }}
        >
          {week.map((date) => {
            const key = ymd(date);
            const inMonth = date.getMonth() === anchor.getMonth();
            const items = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                role="gridcell"
                tabIndex={-1}
                aria-label={`${date.toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}, ${items.length} campaign${items.length === 1 ? "" : "s"}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  onDragOverDay(key);
                }}
                onDragLeave={() => {
                  if (dragOverDay === key) onDragOverDay(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  onDragOverDay(null);
                  const id = event.dataTransfer.getData("text/campaign-id");
                  const campaign = campaigns.find(
                    (candidate) => String(candidate.id) === id,
                  );
                  if (campaign) onDrop(campaign, key);
                }}
                style={{
                  background:
                    dragOverDay === key
                      ? "color-mix(in srgb, var(--pw-accent) 12%, var(--pw-bg))"
                      : "var(--pw-bg)",
                  minHeight: 84,
                  padding: 4,
                  opacity: inMonth ? 1 : 0.45,
                }}
              >
                <div
                  className="muted tabular"
                  style={{ fontSize: 10, marginBottom: 2 }}
                >
                  {date.getDate()}
                </div>
                <div role="list" aria-label={`Campaigns on ${key}`}>
                  {items.map((campaign) => {
                    const label = campaignLabel(campaign);
                    const status = campaign.status ?? "draft";
                    const scheduleEditable = isDraggable(campaign);
                    const movable =
                      scheduleEditable && CAMPAIGN_SCHEDULING_AVAILABLE;
                    return (
                      <div
                        key={String(campaign.id)}
                        role="listitem"
                        draggable={movable && !operationActive}
                        onDragStart={(event) => {
                          event.dataTransfer.setData(
                            "text/campaign-id",
                            String(campaign.id),
                          );
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        style={{
                          display: "grid",
                          gridTemplateColumns: scheduleEditable
                            ? "minmax(0, 1fr) auto"
                            : "1fr",
                          gap: 2,
                          fontSize: 11,
                          marginBottom: 2,
                          borderRadius: 3,
                          borderLeft: `3px solid ${statusTone(campaign.status)}`,
                          background: "var(--pw-bg-elev)",
                        }}
                      >
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => onOpen(campaign)}
                          aria-label={`Open ${label}, ${status}`}
                          style={{
                            minWidth: 0,
                            minHeight: 28,
                            padding: "2px 4px",
                            justifyContent: "flex-start",
                            overflow: "hidden",
                            textAlign: "left",
                          }}
                        >
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {label} <span className="muted">· {status}</span>
                          </span>
                        </button>
                        {scheduleEditable ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label={`Reschedule ${label}`}
                            style={{ minWidth: 28, minHeight: 28, padding: 2 }}
                            onClick={() => onStartReschedule(campaign)}
                            disabled={
                              operationActive || !CAMPAIGN_SCHEDULING_AVAILABLE
                            }
                            aria-describedby={
                              !CAMPAIGN_SCHEDULING_AVAILABLE
                                ? scheduleReasonId
                                : undefined
                            }
                          >
                            ↪
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function CampaignCalendar({
  canMutate,
  campaigns,
  statusTone,
  onOpen,
  onReschedule,
}: Props): ReactElement {
  // Anchor month: default to the current month. We avoid Date.now() at
  // module scope (fine inside an event-free render — this is client UI).
  const [anchor, setAnchor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const [reschedulePick, setReschedulePick] = useState<Campaign | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const monthHeadingId = useId();
  const instructionsId = useId();
  const scheduleReasonId = useId();
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const operation = usePersistentLifecycleOperation({
    ownerId: `campaign-calendar-reschedule-${String(
      reschedulePick?.id ?? "picker",
    )}`,
    label: "Campaign calendar reschedule",
    detail:
      "Wait for the campaign reschedule request to finish before leaving Moosewave.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const discardRescheduleDraft = useCallback((): void => {
    setReschedulePick(null);
    setRescheduleDate("");
    setDiscardConfirmOpen(false);
  }, []);
  const requestRescheduleClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (reschedulePick) {
      setDiscardConfirmOpen(true);
      return;
    }
    discardRescheduleDraft();
  }, [discardRescheduleDraft, operation.promiseRef, reschedulePick]);
  useDiscardOnlyDraftLifecycle({
    ownerId: `campaign-calendar-reschedule-${String(
      reschedulePick?.id ?? "picker",
    )}`,
    label: "Campaign calendar reschedule draft",
    dirty: reschedulePick !== null,
    operationRef: operation.promiseRef,
    discard: discardRescheduleDraft,
    detail:
      "This campaign and target date have not been rescheduled. Return to the calendar or explicitly discard the draft.",
    operationDetail:
      "Wait for the campaign reschedule request to finish before leaving Moosewave.",
  });

  const byDay = useMemo(() => {
    const m = new Map<string, Campaign[]>();
    for (const c of campaigns) {
      const day = campaignDay(c);
      if (!day) continue;
      const arr = m.get(day) ?? [];
      arr.push(c);
      m.set(day, arr);
    }
    return m;
  }, [campaigns]);

  // Build the 6-week grid covering the anchor month.
  const cells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay()); // back to Sunday
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
    }
    return out;
  }, [anchor]);

  const monthLabel = anchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const startReschedule = (campaign: Campaign): void => {
    if (
      !CAMPAIGN_SCHEDULING_AVAILABLE ||
      !canMutate ||
      operation.promiseRef.current
    ) {
      return;
    }
    setReschedulePick(campaign);
    setRescheduleDate(campaignDay(campaign) ?? ymd(new Date()));
    setDiscardConfirmOpen(false);
  };

  useEffect(() => {
    if (!reschedulePick) return;
    const frame = window.requestAnimationFrame(() =>
      dateInputRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [reschedulePick]);

  const runReschedule = async (
    campaign: Campaign,
    date: string,
  ): Promise<boolean> => {
    if (!CAMPAIGN_SCHEDULING_AVAILABLE) {
      setAnnouncement(CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON);
      return false;
    }
    if (!canMutate) {
      setAnnouncement("Viewer role can't reschedule campaigns.");
      return false;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return false;
    }
    const request = operation.run(async (): Promise<boolean> => {
      try {
        const result = await onReschedule(campaign, date);
        return result !== false;
      } catch {
        if (mountedRef.current) {
          setAnnouncement(
            `Could not reschedule ${campaignLabel(campaign)}. Review the date and try again.`,
          );
        }
        return false;
      }
    });
    return request ? await request : false;
  };

  const submitReschedule = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (!reschedulePick || !rescheduleDate) return;
    const campaign = reschedulePick;
    const date = rescheduleDate;
    setAnnouncement(`Rescheduling ${campaignLabel(campaign)} to ${date}.`);
    const succeeded = await runReschedule(campaign, date);
    if (!succeeded || !mountedRef.current) return;
    setAnnouncement(`Rescheduled ${campaignLabel(campaign)} to ${date}.`);
    discardRescheduleDraft();
  };

  return (
    <section
      className="pw-cal"
      aria-labelledby={monthHeadingId}
      aria-describedby={instructionsId}
    >
      <p id={instructionsId} className="visually-hidden">
        Open a campaign with its name button. Campaign schedule changes are
        temporarily unavailable.
      </p>
      {!CAMPAIGN_SCHEDULING_AVAILABLE ? (
        <div
          id={scheduleReasonId}
          className="notice"
          role="status"
          style={{ marginBottom: 10 }}
        >
          <strong>Schedule changes are paused.</strong>{" "}
          {CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON}
        </div>
      ) : null}
      <div
        role="navigation"
        aria-label="Campaign calendar months"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <button
          type="button"
          className="btn btn-sm"
          aria-label="Previous month"
          onClick={() =>
            setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))
          }
        >
          ‹
        </button>
        <div
          id={monthHeadingId}
          aria-live="polite"
          style={{ fontWeight: 600, minWidth: 160, textAlign: "center" }}
        >
          {monthLabel}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          aria-label="Next month"
          onClick={() =>
            setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))
          }
        >
          ›
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            const n = new Date();
            setAnchor(new Date(n.getFullYear(), n.getMonth(), 1));
          }}
        >
          Today
        </button>
      </div>

      <CampaignMonthGrid
        anchor={anchor}
        byDay={byDay}
        campaigns={campaigns}
        cells={cells}
        dragOverDay={dragOverDay}
        monthLabel={monthLabel}
        // Keep a selected form from being silently replaced by another card
        // or a drag/drop request. The operator must submit or explicitly
        // discard that draft first.
        operationActive={
          !canMutate || operation.active || reschedulePick !== null
        }
        scheduleReasonId={scheduleReasonId}
        statusTone={statusTone}
        onDragOverDay={setDragOverDay}
        onDrop={(campaign, day) => {
          setAnnouncement(`Rescheduling ${campaignLabel(campaign)} to ${day}.`);
          void runReschedule(campaign, day).then((succeeded) => {
            if (succeeded && mountedRef.current) {
              setAnnouncement(
                `Rescheduled ${campaignLabel(campaign)} to ${day}.`,
              );
            }
          });
        }}
        onOpen={onOpen}
        onStartReschedule={startReschedule}
      />

      {reschedulePick ? (
        <form
          onSubmit={(event) => void submitReschedule(event)}
          aria-label={`Reschedule ${campaignLabel(reschedulePick)}`}
          style={{
            display: "flex",
            alignItems: "end",
            gap: 8,
            flexWrap: "wrap",
            marginTop: 10,
            padding: 10,
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
            background: "var(--pw-bg-elev)",
          }}
        >
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              New date for {campaignLabel(reschedulePick)}
            </span>
            <input
              ref={dateInputRef}
              type="date"
              value={rescheduleDate}
              required
              onChange={(event) => setRescheduleDate(event.target.value)}
              disabled={!canMutate || operation.active}
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={!canMutate || operation.active}
          >
            {operation.active ? "Rescheduling…" : "Reschedule"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={requestRescheduleClose}
            disabled={operation.active}
          >
            Cancel
          </button>
        </form>
      ) : null}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard this reschedule?"
        description="The selected campaign and target date have not been submitted."
        confirmLabel="Discard reschedule"
        danger
        onConfirm={discardRescheduleDraft}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </section>
  );
}

function campaignLabel(campaign: Campaign): string {
  return campaign.name ?? campaign.subject ?? "Untitled campaign";
}
