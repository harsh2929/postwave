// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";

import { Card, CardContent } from "@/components/ui/card";
import {
  suppressionStatCounts,
  type SuppressionEntry,
} from "@/lib/suppressions-admin-api";

/**
 * Four KPIs over the suppression list (desktop parity with
 * SuppressionsStatStrip): the server total for the current scope, the
 * bounce bucket (hard bounce + spam trap), complaints, and additions in the
 * trailing seven days. Everything but Total derives from the rows actually
 * loaded — the list endpoint pages at 100 — so when the server total exceeds
 * the sample the strip says so instead of presenting a partial breakdown as
 * the whole list. With a reason filter active the loaded rows are
 * reason-scoped, which would make every ratio fire because of the filter;
 * the ratio-based warnings are suppressed and Total is labelled as scoped.
 */
export function SuppressionStatStrip({
  rows,
  total,
  reasonScope,
  now,
}: {
  rows: readonly Pick<SuppressionEntry, "reason" | "created_at">[];
  /** Server-reported total for the current search scope. */
  total: number;
  /** Human label of the active reason filter, when one is applied. */
  reasonScope?: string;
  /** Injectable clock for deterministic tests. */
  now?: number;
}) {
  const counts = useMemo(
    () => suppressionStatCounts(rows, now ?? Date.now()),
    [now, rows],
  );
  const bounces = counts.hardBounce + counts.spamTrap;
  const scoped = Boolean(reasonScope && reasonScope.trim());
  const displayTotal = scoped ? counts.loaded : Math.max(total, counts.loaded);
  const partial = !scoped && total > counts.loaded;
  const totalHint = scoped
    ? `Filtered to “${reasonScope}” on this page`
    : partial
      ? `Breakdown covers the ${counts.loaded.toLocaleString()} loaded rows`
      : `${counts.manual.toLocaleString()} manual · ${counts.unsubscribe.toLocaleString()} unsubscribed · ${counts.other.toLocaleString()} other`;
  const bouncesHigh =
    !scoped && counts.loaded > 0 && bounces / counts.loaded > 0.1;

  return (
    <section
      aria-label="Suppression summary"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <StatCard
        stat="total"
        label="Total"
        value={displayTotal}
        hint={totalHint}
      />
      <StatCard
        stat="bounces"
        label="Bounces"
        value={bounces}
        hint={`${counts.hardBounce.toLocaleString()} hard · ${counts.spamTrap.toLocaleString()} spam trap · ${counts.softBounce.toLocaleString()} soft`}
        negative={bouncesHigh}
      />
      <StatCard
        stat="complaints"
        label="Complaints"
        value={counts.complaint}
        hint={
          counts.complaint > 0
            ? "Each complaint hurts sender reputation"
            : partial || scoped
              ? "No complaints in loaded rows"
              : "No complaint suppressions recorded"
        }
        negative={counts.complaint > 0}
      />
      <StatCard
        stat="added-7d"
        label="New · 7d"
        value={counts.added7d}
        hint={
          counts.added7d === 0
            ? "No additions this week"
            : "Added in the last 7 days"
        }
      />
    </section>
  );
}

function StatCard({
  stat,
  label,
  value,
  hint,
  negative,
}: {
  stat: string;
  label: string;
  value: number;
  hint: string;
  negative?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4" role="group" aria-label={label}>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div
          data-stat={stat}
          className={`mt-1 text-2xl font-semibold tabular-nums ${
            negative ? "text-destructive-emphasis" : ""
          }`}
        >
          {value.toLocaleString()}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}
