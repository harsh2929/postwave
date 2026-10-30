/**
 * SubscribersStatStrip — 4 KPI cards at the top of the Subscribers
 * page. Workspace and applied-view totals come from server aggregates;
 * loaded-row status evidence is deliberately labelled as local evidence.
 *
 * "Total" reports the SERVER total when the parent passes one — the
 * loaded rows array is a server-truncated page and must not be presented as
 * the audience size. This surface never promotes a percentage calculated from
 * that page into a workspace KPI.
 *
 * There is no "bounced" subscriber status in the engine — bounce state
 * lives in Suppressions — so the strip reports an unsub/suppressed
 * rate instead of a fabricated bounce rate.
 */

import { type ReactElement, useMemo } from "react";

import type { Subscriber } from "../../lib/api-client";
import { usePendingMutations } from "../../lib/pending-mutations";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import { engineStatusToUi } from "./subscriber-status";

interface Props {
  rows: Subscriber[];
  /** Server-reported total subscriber count. When present it drives the
   * "Total" card; rows.length is only the loaded page. */
  serverTotal?: number | null;
  /** Exact server-reported count for the currently applied view. */
  matchTotal?: number | null;
  /** Net-new subscribers in the last 30d, sourced from dashboard stats. */
  added30d?: number;
  /** Unsubscribes in the last 30d, sourced from dashboard stats. */
  unsubbed30d?: number;
}

export function SubscribersStatStrip({
  rows,
  serverTotal,
  matchTotal,
  added30d,
  unsubbed30d,
}: Props): ReactElement {
  // Pending creates remain useful status evidence, but they are never folded
  // into either server-confirmed total. That would turn an optimistic local
  // mutation into an audience-size claim before the server accepted it.
  const pendingCreates = usePendingMutations<{
    email: string;
    tags: string[];
    status?: "enabled" | "unconfirmed";
  }>("subscribers", "create");
  const counts = useMemo(() => {
    let subscribed = 0;
    let unsubscribed = 0;
    let other = 0;
    for (const r of rows) {
      const s = engineStatusToUi(r.status);
      if (s === "subscribed") subscribed++;
      else if (s === "unsubscribed") unsubscribed++;
      else other++; // disabled / unconfirmed
    }
    // Admin-created contacts default to unconfirmed/non-sendable until
    // explicit consent evidence is supplied.
    other += pendingCreates.filter(
      (pending) => pending.status !== "enabled",
    ).length;
    subscribed += pendingCreates.filter(
      (pending) => pending.status === "enabled",
    ).length;
    return { subscribed, unsubscribed, other };
  }, [rows, pendingCreates]);

  const evidenced = rows.length + pendingCreates.length;
  const sampledAgainst = matchTotal ?? serverTotal;
  const sampled = sampledAgainst != null && rows.length < sampledAgainst;
  const pendingNote =
    pendingCreates.length > 0
      ? ` · ${pendingCreates.length.toLocaleString()} local create${pendingCreates.length === 1 ? "" : "s"} syncing separately`
      : "";

  // Net new over the 30d window. Falls back to "—" when dashboard stats
  // haven't loaded yet so we don't lie with 0.
  const netNew =
    added30d != null && unsubbed30d != null ? added30d - unsubbed30d : null;

  return (
    <div className="stat-grid" style={{ marginBottom: 12 }}>
      <StatCard
        label="Workspace total"
        value={serverTotal == null ? "—" : serverTotal.toLocaleString()}
        hint={
          serverTotal == null
            ? `Awaiting a server-confirmed workspace count${pendingNote}`
            : `Server-confirmed audience size${pendingNote}`
        }
      />
      <StatCard
        label="Applied view"
        value={matchTotal == null ? "—" : matchTotal.toLocaleString()}
        hint={
          matchTotal == null
            ? "Awaiting the exact result count for the applied filters"
            : "Exact server result for the current query, filters, and archive scope"
        }
      />
      <StatCard
        label="Net new · 30d"
        value={
          netNew == null
            ? "—"
            : `${netNew >= 0 ? "+" : ""}${netNew.toLocaleString()}`
        }
        hint={
          added30d != null
            ? `+${(added30d ?? 0).toLocaleString()} added · ${(unsubbed30d ?? 0).toLocaleString()} unsub`
            : undefined
        }
        positive={netNew != null && netNew > 0}
        negative={netNew != null && netNew < 0}
      />
      <StatCard
        label="Status evidence"
        value={`${evidenced.toLocaleString()} evidenced`}
        hint={`${rows.length.toLocaleString()} server-loaded${pendingCreates.length > 0 ? ` · ${pendingCreates.length.toLocaleString()} local pending` : ""} · ${counts.subscribed.toLocaleString()} subscribed · ${counts.unsubscribed.toLocaleString()} unsubscribed · ${counts.other.toLocaleString()} inactive, unknown, or unconfirmed${sampled ? " · not a workspace-rate sample" : ""}`}
      >
        <StatusChart
          subscribed={counts.subscribed}
          unsubscribed={counts.unsubscribed}
          other={counts.other}
          sampled={sampled}
        />
      </StatCard>
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  positive?: boolean;
  negative?: boolean;
  children?: React.ReactNode;
}

function StatCard({
  label,
  value,
  hint,
  positive,
  negative,
  children,
}: StatCardProps): ReactElement {
  return (
    <div
      className="stat-card"
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      <div className="stat-label">{label}</div>
      <div
        className="stat-value tabular"
        style={{
          color: positive
            ? "var(--pw-accent)"
            : negative
              ? "var(--pw-danger)"
              : "var(--pw-fg)",
        }}
      >
        {value}
      </div>
      {hint ? <div className="stat-delta subtle">{hint}</div> : null}
      {children}
    </div>
  );
}

function StatusChart({
  subscribed,
  unsubscribed,
  other,
  sampled,
}: {
  subscribed: number;
  unsubscribed: number;
  /** Disabled, unconfirmed, unknown, and other non-subscribed rows. */
  other: number;
  sampled: boolean;
}): ReactElement {
  const total = subscribed + unsubscribed + other;
  const share = (value: number): string =>
    total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
  const summary = `Loaded subscriber status distribution. Subscribed ${subscribed.toLocaleString()}, ${share(subscribed)}; unsubscribed or suppressed ${unsubscribed.toLocaleString()}, ${share(unsubscribed)}; inactive or unconfirmed ${other.toLocaleString()}, ${share(other)}.`;
  const slice = (
    value: number,
    color: string,
    pattern: string,
  ): ReactElement | null =>
    value <= 0 || total <= 0 ? null : (
      <span
        style={{
          width: `${(value / total) * 100}%`,
          backgroundColor: color,
          backgroundImage: pattern,
        }}
      />
    );
  return (
    <div style={{ marginTop: 6 }}>
      <div
        className="pw-categorical-chart__bar"
        style={{ height: 8, background: "var(--pw-bg-elev-2)" }}
        aria-hidden="true"
      >
        {slice(subscribed, "var(--pw-accent)", "none")}
        {slice(
          unsubscribed,
          "var(--pw-warning)",
          "repeating-linear-gradient(45deg, transparent 0 3px, rgba(255,255,255,.35) 3px 4px)",
        )}
        {slice(
          other,
          "color-mix(in srgb, var(--pw-fg-muted) 50%, transparent)",
          "repeating-linear-gradient(90deg, transparent 0 4px, rgba(255,255,255,.3) 4px 5px)",
        )}
      </div>
      <AccessibleChartData
        title="Loaded subscriber status distribution"
        summary={summary}
        rowHeaderLabel="Status"
        columns={[
          { key: "value", label: "Loaded subscribers" },
          { key: "share", label: "Share" },
        ]}
        rows={[
          {
            key: "subscribed",
            label: "Subscribed",
            values: {
              value: subscribed.toLocaleString(),
              share: share(subscribed),
            },
            exportValues: { value: subscribed, share: share(subscribed) },
          },
          {
            key: "unsubscribed",
            label: "Unsubscribed or suppressed",
            values: {
              value: unsubscribed.toLocaleString(),
              share: share(unsubscribed),
            },
            exportValues: { value: unsubscribed, share: share(unsubscribed) },
          },
          {
            key: "other",
            label: "Inactive or unconfirmed",
            values: { value: other.toLocaleString(), share: share(other) },
            exportValues: { value: other, share: share(other) },
          },
        ]}
        provenance={dux025Provenance("subscriberStatusMix", {
          scope: `Current applied view · ${total.toLocaleString()} loaded or pending subscribers`,
          note: sampled
            ? "The server reports additional matching subscribers outside this loaded page; percentages do not claim complete-view or workspace-wide coverage."
            : "The current result is not known to be server-truncated.",
        })}
        exportFileName="loaded-subscriber-status-distribution.csv"
        exportPrivacy="confidential"
        disclosureLabel="View status details and export"
      />
    </div>
  );
}
