// SPDX-License-Identifier: AGPL-3.0-only
//
// SEQ-009 — send performance for a sequence. The sequence editor previously
// showed only voice-fidelity; this adds the "did it actually perform" view:
// reached / opened / clicked per email + a sequence rollup, sourced from
// recorded funnel events. Only these three metrics are tracked per sequence
// email (bounced/delivered/unsubscribed are not recorded per-position), so the
// panel deliberately shows nothing it cannot back with data.
"use client";

import { useEffect, useState } from "react";
import { BarChart3, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getSequencePerformance } from "@/lib/voice-api";
import type { SequencePerformance } from "@/lib/voice-types";
import { cn } from "@/lib/utils";

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {sub ? (
        <div className="text-[11px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}

export function SequencePerformancePanel({
  sequenceId,
}: {
  sequenceId: string;
}) {
  const [open, setOpen] = useState(true);
  const [data, setData] = useState<SequencePerformance | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [requestNonce, setRequestNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState("loading");
    // try/catch around an await rather than a .catch() chain. Today
    // getSequencePerformance is backed by an async function, so it can only
    // reject — but a .catch() chain silently stops covering the call the moment
    // it becomes a plain Promise-returning function, because a synchronous
    // throw happens before the promise exists and would escape this effect
    // (React escalates a throw in a passive effect to the error boundary,
    // blanking the detail page instead of showing the error branch below).
    void (async () => {
      try {
        const perf = await getSequencePerformance(sequenceId);
        if (!alive) return;
        setData(perf);
        setState("ready");
      } catch {
        if (alive) setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [requestNonce, sequenceId]);

  const hasData = data != null && data.reached > 0;
  const panelId = `sequence-performance-${sequenceId}`;

  return (
    <section className="border-b bg-muted/20 px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-8 w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <BarChart3 className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Send performance</span>
        {state === "ready" && hasData ? (
          <span className="text-xs text-muted-foreground">
            {data!.reached.toLocaleString()} reached ·{" "}
            {pct(data!.opened, data!.reached)} opened
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div id={panelId} className="mt-3">
          {state === "loading" ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading performance…
            </p>
          ) : state === "error" ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs"
            >
              <p>
                Couldn’t load send performance. It requires the durable read
                model; try again shortly.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRequestNonce((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          ) : !hasData ? (
            <div className="rounded-md border border-dashed bg-card px-3 py-2.5">
              <p className="text-xs text-muted-foreground">
                No send data yet. Live sequence delivery is unavailable in this
                build. This panel can display historical funnel events when they
                exist; an empty draft has no measured send performance.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <Stat
                  label="Reached"
                  value={data!.reached.toLocaleString()}
                  sub="distinct subscribers"
                />
                <Stat
                  label="Opened"
                  value={data!.opened.toLocaleString()}
                  sub={`${pct(data!.opened, data!.reached)} open rate`}
                />
                <Stat
                  label="Clicked"
                  value={data!.clicked.toLocaleString()}
                  sub={`${pct(data!.clicked, data!.reached)} click rate`}
                />
              </div>

              {data!.positions.length > 0 ? (
                <div
                  role="region"
                  aria-label="Per-email send performance"
                  tabIndex={0}
                  className="overflow-x-auto rounded-md border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <table className="w-full text-xs">
                    <caption className="sr-only">
                      Per-email send performance
                    </caption>
                    <thead className="bg-muted/60 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th
                          scope="col"
                          className="px-3 py-1.5 text-left font-medium"
                        >
                          Email
                        </th>
                        <th
                          scope="col"
                          className="px-3 py-1.5 text-right font-medium"
                        >
                          Reached
                        </th>
                        <th
                          scope="col"
                          className="px-3 py-1.5 text-right font-medium"
                        >
                          Opened
                        </th>
                        <th
                          scope="col"
                          className="px-3 py-1.5 text-right font-medium"
                        >
                          Clicked
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data!.positions.map((p) => (
                        <tr key={p.position}>
                          <td className="px-3 py-1.5">Email {p.position}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {p.reached.toLocaleString()}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {p.opened.toLocaleString()}{" "}
                            <span className="text-muted-foreground">
                              ({pct(p.opened, p.reached)})
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {p.clicked.toLocaleString()}{" "}
                            <span className="text-muted-foreground">
                              ({pct(p.clicked, p.reached)})
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <p className="text-[11px] text-muted-foreground">
                Opens and clicks only. Bounced, delivered, and unsubscribed
                aren’t tracked per sequence email.
              </p>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
