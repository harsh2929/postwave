// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { Loader2, RotateCcw, Users } from "lucide-react";

import {
  previewSegment,
  type PreviewResponse,
  type SegmentNode,
} from "@/lib/segments-api";
import { cn } from "@/lib/utils";

export interface LiveCountProps {
  ast: SegmentNode;
  className?: string;
  /** Debounce window in ms. Default 500. */
  debounceMs?: number;
  /** Expand the count + denominator to archived subscribers (SEG-034). */
  includeArchived?: boolean;
}

interface State {
  status: "idle" | "loading" | "ok" | "error";
  data?: PreviewResponse;
  error?: string;
}

function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return "";
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

export function LiveCount({
  ast,
  className,
  debounceMs = 500,
  includeArchived = false,
}: LiveCountProps) {
  const [state, setState] = React.useState<State>({ status: "idle" });
  const [reloadKey, setReloadKey] = React.useState(0);
  const astKey = JSON.stringify(ast);
  const astRef = React.useRef(ast);

  React.useEffect(() => {
    astRef.current = ast;
  }, [ast]);

  React.useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const handle = setTimeout(() => {
      controller = new AbortController();
      setState((s) => ({ ...s, status: "loading" }));
      previewSegment(astRef.current, {
        signal: controller.signal,
        includeArchived,
      })
        .then((res) => {
          if (cancelled) return;
          setState({ status: "ok", data: res });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (isAbortError(err)) return;
          setState({
            status: "error",
            error: err instanceof Error ? err.message : "preview failed",
          });
        });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      controller?.abort();
    };
  }, [astKey, debounceMs, includeArchived, reloadKey]);

  const data = state.data;
  const percent = data ? formatPercent(data.workspace_percentage) : "";

  return (
    <div
      className={cn("min-w-[10rem] rounded-md border bg-card px-3 py-2", className)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-sm">
        {state.status === "loading" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : (
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        {state.status === "error" ? (
          <span className="flex items-center gap-2">
            <span className="text-destructive">Preview failed</span>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="inline-flex items-center gap-1 rounded-sm text-xs text-primary underline underline-offset-2 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </button>
          </span>
        ) : state.status === "ok" && data ? (
          <span>
            <span className="font-medium tabular-nums">
              {data.count.toLocaleString()}
            </span>{" "}
            subscriber{data.count === 1 ? "" : "s"}
            {percent ? (
              <span className="text-muted-foreground"> · {percent} of workspace</span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">Calculating…</span>
        )}
      </div>
      {state.status === "ok" && data ? (
        <div className="mt-1 text-[11px] leading-tight text-muted-foreground">
          {data.archive_scope === "including_archived"
            ? "Including archived"
            : "Active subscribers only"}
          {data.applied_exclusions?.length
            ? ` · excludes ${data.applied_exclusions.join(", ")}`
            : null}
        </div>
      ) : null}
    </div>
  );
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  );
}
