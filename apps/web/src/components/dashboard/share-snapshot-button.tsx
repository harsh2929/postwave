// SPDX-License-Identifier: AGPL-3.0-only
//
// ShareSnapshotButton — copy a plain-text summary of the loaded dashboard to
// the clipboard (parity with desktop DashboardToolbar ShareButton +
// pages/Dashboard.tsx onShareSnapshot).
//
// Client-side only: the text is built from the /api/v1/dashboard/stats payload
// the page already holds. The control is withheld with its reason until that
// payload carries the full distinct-recipient contract, and a rejected or
// unavailable clipboard write is SHOWN (inline + toast) — never swallowed, so
// nobody walks away believing they hold a snapshot they do not.
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Share2 } from "lucide-react";
import { toast } from "sonner";

import type { DashboardStats } from "@/lib/analytics-api";
import { copyToClipboard } from "@/lib/clipboard";
import {
  buildDashboardSnapshot,
  canBuildDashboardSnapshot,
} from "@/lib/dashboard-snapshot";
import { Button } from "@/components/ui/button";

const FAILURE_COPY = {
  unavailable:
    "Clipboard access is not available in this browser context, so the snapshot was not copied.",
  error:
    "The browser refused the clipboard write, so the snapshot was not copied. Try again.",
} as const;

export function ShareSnapshotButton({
  stats,
  rangeLabel = "Last 30 days",
  className,
}: {
  stats: DashboardStats | null | undefined;
  rangeLabel?: string;
  className?: string;
}) {
  const reasonId = useId();
  const [state, setState] = useState<
    "idle" | "busy" | "copied" | "unavailable" | "error"
  >("idle");
  const busyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const available = canBuildDashboardSnapshot(stats);

  async function share(): Promise<void> {
    if (!canBuildDashboardSnapshot(stats) || busyRef.current) return;
    busyRef.current = true;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState("busy");
    const result = await copyToClipboard(
      buildDashboardSnapshot(stats, { rangeLabel }),
    );
    busyRef.current = false;
    if (!activeRef.current) return;
    if (result === "copied") {
      setState("copied");
      toast.success("Snapshot copied — paste it into Slack, Notion, or email.");
      timerRef.current = window.setTimeout(() => {
        if (activeRef.current) setState("idle");
        timerRef.current = null;
      }, 1500);
      return;
    }
    setState(result);
    toast.error(FAILURE_COPY[result]);
  }

  const failure =
    state === "unavailable" || state === "error" ? FAILURE_COPY[state] : null;

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        className={className ?? "h-11 sm:h-9"}
        onClick={() => void share()}
        disabled={!available || state === "busy"}
        aria-describedby={!available ? reasonId : undefined}
        aria-busy={state === "busy" || undefined}
      >
        {state === "copied" ? (
          <Check className="h-4 w-4" aria-hidden />
        ) : (
          <Share2 className="h-4 w-4" aria-hidden />
        )}
        {state === "copied"
          ? "Copied"
          : state === "busy"
            ? "Copying…"
            : "Share snapshot"}
      </Button>
      {!available ? (
        <span id={reasonId} className="sr-only">
          Available once the complete performance metrics have loaded.
        </span>
      ) : null}
      {failure ? (
        <span role="alert" className="max-w-xs text-right text-xs text-destructive">
          {failure}
        </span>
      ) : null}
    </span>
  );
}
