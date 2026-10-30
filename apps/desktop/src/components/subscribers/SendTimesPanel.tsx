/**
 * SendTimesPanel — SUB-066 per-channel optimal send windows for one
 * subscriber, shown in the subscriber slideover Profile tab next to the
 * unified channel-consent panel.
 *
 * The backend computes a modal hour-of-week (0-167, UTC-bucketed) per
 * channel and stores it on subscriber_channel_consents, alongside the
 * legacy channel-agnostic aggregate on the subscriber row. This panel
 * renders all five reachability channels (email / sms / push / whatsapp
 * / rcs) as a table — best send time (day-of-week + hour-of-day),
 * computed-at, and a 7-cell day-of-week strip that highlights the modal
 * day for a quick scan. A channel with no computed per-channel value
 * falls back to the aggregate window, flagged honestly as "aggregate".
 *
 * Backed by:
 *   GET /api/v1/subscribers/{id}/send-times
 * (apps/api/internal/subscribers/send_times.go).
 *
 * Graceful degradation: a 404 (route not deployed) is swallowed by the
 * client into an empty envelope; we render the cold-start note rather
 * than an error so the section degrades quietly on older deployments.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type ChannelSendTime,
  type PerChannelSendTimes,
  getSubscriberSendTimes,
} from "../../lib/api-client";
import { fmtDateTime } from "../../lib/format-date";
import { InlineHelp } from "../InlineHelp";

interface Props {
  /** Subscriber UUID (the send-times endpoint keys rows by it). */
  subscriberId: string;
}

/** All five reachability channels in a stable display order — matches
 *  ChannelConsentsPanel so the two per-channel tables read as siblings. */
const CHANNELS = ["email", "sms", "push", "whatsapp", "rcs"] as const;

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  push: "Push",
  whatsapp: "WhatsApp",
  rcs: "RCS",
};

const DOW_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Derive (day_of_week 0=Sun, hour_of_day) from a 0-167 hour-of-week.
 *  Mirrors the backend split so an aggregate fallback (which only carries
 *  the raw hour) renders the same way as a per-channel row. */
function splitHourOfWeek(h: number): { dow: number; hod: number } {
  const v = Math.min(167, Math.max(0, h));
  return { dow: Math.floor(v / 24), hod: v % 24 };
}

/** "Tuesday 09:00" style label from a day-of-week + hour-of-day. */
function windowLabel(dow: number, hod: number): string {
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const day = days[dow] ?? "—";
  const hh = String(hod).padStart(2, "0");
  return `${day} ${hh}:00`;
}

/** A compact 7-cell day-of-week strip highlighting the modal day. Acts
 *  as the "sparkline" affordance — a single computed hour-of-week has no
 *  distribution to plot, so we mark the resolved day instead of faking a
 *  histogram. */
function DayStrip({ dow }: { dow: number | null }): ReactElement {
  return (
    <span
      style={{ display: "inline-flex", gap: 2 }}
      aria-hidden="true"
      title={dow == null ? undefined : `Best day: ${DOW_SHORT[dow]}`}
    >
      {DOW_SHORT.map((label, i) => (
        <span
          key={label}
          style={{
            width: 12,
            height: 12,
            borderRadius: 2,
            fontSize: 8,
            lineHeight: "12px",
            textAlign: "center",
            color: i === dow ? "var(--pw-bg)" : "var(--pw-fg-subtle)",
            background:
              i === dow ? "var(--pw-accent)" : "var(--pw-bg-elev-2)",
          }}
        >
          {label[0]}
        </span>
      ))}
    </span>
  );
}

export function SendTimesPanel({ subscriberId }: Props): ReactElement | null {
  const [data, setData] = useState<PerChannelSendTimes | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    setData(null);
    void (async () => {
      const res = await getSubscriberSendTimes(subscriberId);
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        setErrMsg(res.error.message);
        return;
      }
      setData(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [subscriberId]);

  if (loading) {
    return (
      <section style={{ marginTop: 12 }}>
        <div className="label">Optimal send times</div>
        <div className="skel" style={{ height: 64 }} />
      </section>
    );
  }

  // Index per-channel rows by channel so all five channels render even
  // when the server returns a sparse set.
  const byChannel: Record<string, ChannelSendTime> = {};
  for (const c of data?.channels ?? []) byChannel[c.channel] = c;

  const aggregate = data?.aggregate_best_send_hour ?? null;
  const aggSplit = aggregate != null ? splitHourOfWeek(aggregate) : null;

  return (
    <section style={{ marginTop: 12 }}>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 4 }}
      >
        Optimal send times
        <InlineHelp text="The hour-of-week each channel reaches this person best, learned from their engagement history. Channels with no per-channel signal fall back to the aggregate best hour across all channels. Cold profiles use the tenant default at send time." />
      </div>

      {errMsg ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Couldn&apos;t load send times: {errMsg}
        </div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto auto",
              gap: "6px 10px",
              alignItems: "center",
              fontSize: 12,
            }}
          >
            {/* Header row */}
            <span className="muted" style={{ fontSize: 11 }}>
              Channel
            </span>
            <span className="muted" style={{ fontSize: 11 }}>
              Best send time
            </span>
            <span className="muted" style={{ fontSize: 11 }}>
              Day
            </span>
            <span className="muted" style={{ fontSize: 11, textAlign: "right" }}>
              Computed
            </span>

            {CHANNELS.map((channel) => {
              const row = byChannel[channel];
              const perChannelHour = row?.best_send_hour ?? null;
              // Per-channel value wins; otherwise fall back to the
              // aggregate and flag the row as a fallback.
              const usingAggregate = perChannelHour == null;
              const dow =
                row?.day_of_week ??
                (perChannelHour != null
                  ? splitHourOfWeek(perChannelHour).dow
                  : aggSplit?.dow ?? null);
              const hod =
                row?.hour_of_day ??
                (perChannelHour != null
                  ? splitHourOfWeek(perChannelHour).hod
                  : aggSplit?.hod ?? null);
              const computedAt = usingAggregate
                ? data?.aggregate_best_send_hour_at
                : row?.best_send_hour_at;
              const hasWindow = dow != null && hod != null;
              return (
                <Row
                  key={channel}
                  label={CHANNEL_LABEL[channel] ?? channel}
                  windowText={
                    hasWindow ? windowLabel(dow!, hod!) : "Not learned yet"
                  }
                  usingAggregate={hasWindow && usingAggregate}
                  dow={hasWindow ? dow! : null}
                  computedAt={computedAt ?? null}
                />
              );
            })}
          </div>

          <div
            className="muted"
            style={{ marginTop: 8, fontSize: 11, lineHeight: 1.45 }}
          >
            {aggregate != null && aggSplit ? (
              <>
                Aggregate best hour:{" "}
                <strong>{windowLabel(aggSplit.dow, aggSplit.hod)}</strong> (all
                channels, UTC). Channels marked &ldquo;aggregate&rdquo; have no
                per-channel signal yet.
              </>
            ) : (
              "No optimal hour learned yet — sends to this profile use the tenant default until enough engagement accrues."
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** One channel row in the send-times grid. */
function Row({
  label,
  windowText,
  usingAggregate,
  dow,
  computedAt,
}: {
  label: string;
  windowText: string;
  usingAggregate: boolean;
  dow: number | null;
  computedAt: string | null;
}): ReactElement {
  return (
    <>
      <span>{label}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span className="tabular">{windowText}</span>
        {usingAggregate ? (
          <span
            className="badge"
            style={{ fontSize: 9 }}
            title="No per-channel signal yet — falling back to the aggregate best hour across all channels."
          >
            aggregate
          </span>
        ) : null}
      </span>
      <DayStrip dow={dow} />
      <span
        className="tabular muted"
        style={{ fontSize: 10, textAlign: "right" }}
      >
        {computedAt ? fmtDateTime(computedAt) : "—"}
      </span>
    </>
  );
}
