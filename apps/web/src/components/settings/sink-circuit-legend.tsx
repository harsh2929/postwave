// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Circuit-breaker legend + synthesized history for one audit sink
// (desktop parity: components/audit/AuditSinkTables.tsx
// AuditSinkCircuitHealthLegend). The breaker vocabulary is a recurring source
// of confusion ("does open mean broken or open-for-business?"), so the
// meanings render inline beside the transitions we can reconstruct from the
// sink row itself. There is no transition-history endpoint: every entry below
// is derived from fields the server already returned, and the copy says so.

import { useId, useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type SinkCircuitState = "closed" | "open" | "half_open";

/** The subset of a sink row the legend reads (RecoverySink satisfies it). */
export interface SinkCircuitSnapshot {
  circuitState: SinkCircuitState;
  consecutiveFailures: number;
  autoDisableAfter: number;
  cooldownUntil?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
}

export interface SinkCircuitHistoryEntry {
  key: "last-failure" | "last-success" | "current" | "threshold";
  text: string;
  /** ISO instant the entry refers to, when the sink recorded one. */
  at?: string;
}

const STATE_LABEL: Record<SinkCircuitState, string> = {
  closed: "closed",
  half_open: "half-open",
  open: "open",
};

const LEGEND: ReadonlyArray<{
  state: SinkCircuitState;
  variant: "success" | "warning" | "destructive";
  meaning: string;
}> = [
  {
    state: "closed",
    variant: "success",
    meaning:
      "Healthy — events flow normally. The failure counter resets after each successful delivery.",
  },
  {
    state: "half_open",
    variant: "warning",
    meaning:
      "Probing — one tentative delivery is allowed; success closes the breaker, failure re-opens it.",
  },
  {
    state: "open",
    variant: "destructive",
    meaning:
      "Tripped — deliveries short-circuit to the dead-letter queue until the cooldown elapses, then the breaker moves to half-open.",
  },
];

function instant(value: string | null | undefined): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

/**
 * Reconstructs the recent breaker story from the sink row, newest first.
 * Pure so the synthesis itself is unit-testable.
 */
export function synthesizeCircuitHistory(
  sink: SinkCircuitSnapshot,
): SinkCircuitHistoryEntry[] {
  const entries: SinkCircuitHistoryEntry[] = [];
  const lastFailure = instant(sink.lastFailureAt);
  const lastSuccess = instant(sink.lastSuccessAt);
  const cooldown = instant(sink.cooldownUntil);
  const timed: SinkCircuitHistoryEntry[] = [];
  if (lastFailure) {
    timed.push({
      key: "last-failure",
      at: lastFailure,
      text:
        sink.consecutiveFailures > 0
          ? `Last failed delivery · ${sink.consecutiveFailures} of ${sink.autoDisableAfter} consecutive failures`
          : "Last failed delivery",
    });
  }
  if (lastSuccess) {
    timed.push({
      key: "last-success",
      at: lastSuccess,
      text: "Last successful delivery",
    });
  }
  timed.sort(
    (left, right) => Date.parse(right.at ?? "") - Date.parse(left.at ?? ""),
  );
  entries.push(...timed);
  entries.push({
    key: "current",
    text: `Current state: ${STATE_LABEL[sink.circuitState]}${
      sink.circuitState === "open"
        ? cooldown
          ? " · cooldown ends"
          : " · cooldown active"
        : sink.circuitState === "half_open"
          ? " · the next delivery tests the upstream"
          : ""
    }`,
    ...(sink.circuitState === "open" && cooldown ? { at: cooldown } : {}),
  });
  entries.push({
    key: "threshold",
    text: `Auto-disables after ${sink.autoDisableAfter} consecutive failures.`,
  });
  return entries;
}

export function SinkCircuitLegend({ sink }: { sink: SinkCircuitSnapshot }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const history = synthesizeCircuitHistory(sink);
  return (
    <div
      className="rounded-lg border bg-muted/20 p-3 text-sm"
      data-testid="sink-circuit-legend"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide" : "Show"} circuit legend &amp; history
      </Button>
      {open ? (
        <div id={contentId} className="mt-3 grid gap-4">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              Audit sink circuit-breaker states
            </caption>
            <tbody>
              {LEGEND.map((entry) => (
                <tr key={entry.state} className="border-t first:border-t-0">
                  <th scope="row" className="w-28 py-2 pr-3 align-top">
                    <Badge variant={entry.variant}>
                      {STATE_LABEL[entry.state]}
                    </Badge>
                  </th>
                  <td className="py-2 text-muted-foreground">
                    {entry.meaning}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent transitions
            </p>
            <ul
              className="list-disc space-y-1 pl-5 text-xs text-muted-foreground"
              data-testid="sink-circuit-history"
            >
              {history.map((entry) => (
                <li key={entry.key} data-entry={entry.key}>
                  {entry.text}
                  {entry.at ? (
                    <>
                      {" "}
                      <time dateTime={entry.at}>
                        <RelativeTime iso={entry.at} />
                      </time>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Reconstructed from this sink&apos;s recorded timestamps and
              counters; the server keeps no separate transition log.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
