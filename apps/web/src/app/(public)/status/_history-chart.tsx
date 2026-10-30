// SPDX-License-Identifier: AGPL-3.0-only
//
// 90-day uptime history chart, one row per service. Each row is a strip
// of 90 colored squares representing days from oldest (left) to today
// (right). Color tier:
//
//   uptime ≥ 0.999  → emerald (full operational)
//   uptime ≥ 0.95   → amber   (degraded)
//   uptime <  0.95  → red     (significant outage)
//
// A day with at least one incident gets a thin underline regardless of
// uptime tier so you can spot operator-curated incidents that never
// rolled into the ping classification (e.g. a Stripe outage we
// announced before the aggregator caught it).
//
// This component is a server component — no interactivity, just markup
// + className tiers.

import type { PublicStatus } from "@/lib/public-status-api";

interface HistoryChartProps {
  history: PublicStatus["history_90d"];
}

function tierFill(uptime: number): string {
  if (uptime < 0.95) return "#ef4444";
  if (uptime < 0.999) return "#f59e0b";
  return "#10b981";
}

function tierLabel(uptime: number, incidents: number): string {
  const pct = `${(uptime * 100).toFixed(2)}%`;
  if (incidents > 0) return `${pct} uptime, ${incidents} incident(s)`;
  return `${pct} uptime`;
}

export function HistoryChart({ history }: HistoryChartProps): JSX.Element {
  const services = Object.keys(history).sort();
  if (services.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough history yet — back fills as pings accumulate.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div
        aria-label="History legend"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
      >
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-sm bg-emerald-500"
          />
          ≥ 99.9%
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-sm bg-amber-500"
          />
          95–99.9%
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-sm bg-red-500"
          />
          &lt; 95%
        </span>
      </div>
      {services.map((svc) => {
        const days = history[svc] ?? [];
        const anchor = statusHistoryId(svc);
        const operationalDays = days.filter(
          (day) => day.uptime >= 0.999,
        ).length;
        const degradedDays = days.filter(
          (day) => day.uptime >= 0.95 && day.uptime < 0.999,
        ).length;
        const outageDays = days.filter((day) => day.uptime < 0.95).length;
        const incidentDays = days.filter((day) => day.incidents > 0).length;
        return (
          <div
            key={svc}
            id={anchor}
            className="scroll-mt-6 rounded-xl border bg-card p-4 shadow-sm"
          >
            <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h3
                id={`${anchor}-title`}
                className="break-words text-sm font-semibold [overflow-wrap:anywhere]"
              >
                {svc}
              </h3>
              <span className="text-xs tabular-nums text-muted-foreground">
                {days.length > 0
                  ? `${days[0]?.day} → ${days[days.length - 1]?.day}`
                  : "no data"}
              </span>
            </div>
            {days.length > 0 ? (
              <div
                role="region"
                tabIndex={0}
                aria-labelledby={`${anchor}-title`}
                className="overflow-x-auto rounded-sm pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <svg
                  role="img"
                  aria-label={`${days.length}-day uptime for ${svc}: ${operationalDays} operational days, ${degradedDays} degraded days, ${outageDays} outage days, ${incidentDays} days with incidents.`}
                  viewBox={`0 0 ${days.length * 6} 24`}
                  preserveAspectRatio="none"
                  className="h-7 min-w-[33.75rem] w-full"
                >
                  {days.map((d, i) => (
                    <rect
                      key={d.day}
                      x={i * 6}
                      y={0}
                      width={5}
                      height={24}
                      rx={1}
                      fill={tierFill(d.uptime)}
                      opacity={d.incidents > 0 ? 0.85 : 1}
                      data-incidents={d.incidents}
                    >
                      <title>{`${d.day} — ${tierLabel(d.uptime, d.incidents)}`}</title>
                    </rect>
                  ))}
                </svg>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                History has not accumulated for this service yet.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Stable, fragment-safe anchor for arbitrary service labels. */
export function statusHistoryId(service: string): string {
  const readable = service
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  let hash = 2_166_136_261;
  for (const char of service) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `history-${readable || "service"}-${(hash >>> 0).toString(36)}`;
}
