/**
 * ListsStatStrip — 4 KPIs that summarise the audience-list inventory.
 *
 *   • Total lists           — how many containers exist
 *   • Total subscribers     — sum of all denormalised subscriber_count
 *   • Public lists          — count where type === public (these have
 *                             hosted preference URLs)
 *   • Double opt-in lists   — count where optin === double (the
 *                             deliverability-safer choice)
 *
 * Everything is derived from the rows already loaded; no extra fetch.
 */

import { type ReactElement, useMemo } from "react";

import type { List } from "../../lib/api-client";

interface Props {
  rows: List[];
}

function counts(rows: List[]): {
  total: number;
  subscribers: number;
  publicLists: number;
  doubleOptin: number;
} {
  let subscribers = 0;
  let publicLists = 0;
  let doubleOptin = 0;
  for (const r of rows) {
    subscribers += r.subscriber_count ?? 0;
    if ((r.type ?? "private").toLowerCase() === "public") publicLists++;
    if ((r.optin ?? "single").toLowerCase() === "double") doubleOptin++;
  }
  return {
    total: rows.length,
    subscribers,
    publicLists,
    doubleOptin,
  };
}

export function ListsStatStrip({ rows }: Props): ReactElement {
  const c = useMemo(() => counts(rows), [rows]);
  const doubleOptinRate =
    c.total > 0 ? (c.doubleOptin / c.total) * 100 : 0;
  const publicRate = c.total > 0 ? (c.publicLists / c.total) * 100 : 0;

  return (
    <div className="stat-grid" style={{ marginBottom: 12 }}>
      <StatCard label="Lists" value={c.total.toLocaleString()} hint="audience containers" />
      <StatCard
        label="Subscribers"
        value={c.subscribers.toLocaleString()}
        hint={`across ${c.total} list${c.total === 1 ? "" : "s"}`}
      />
      <StatCard
        label="Public"
        value={c.publicLists.toLocaleString()}
        hint={`${publicRate.toFixed(0)}% of lists · hosted signup URL`}
      />
      <StatCard
        label="Double opt-in"
        value={c.doubleOptin.toLocaleString()}
        hint={`${doubleOptinRate.toFixed(0)}% of lists`}
        positive={doubleOptinRate >= 50}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  positive,
}: {
  label: string;
  value: string;
  hint: string;
  positive?: boolean;
}): ReactElement {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div
        className="stat-value tabular"
        style={{ color: positive ? "var(--pw-accent)" : "var(--pw-fg)" }}
      >
        {value}
      </div>
      <div className="stat-delta subtle">{hint}</div>
    </div>
  );
}
