// SPDX-License-Identifier: AGPL-3.0-only
//
// Live home dashboard — parity with desktop pages/dashboard/useDashboardData.ts
// (useDashboardLive) + components/dashboard/{StaleIndicator,LiveSubsChip,
// ActiveSendStrip}.tsx.
//
// TRANSPORT: GET /api/v1/dashboard/live (text/event-stream, read:reports — the
// same scope as GET /api/v1/dashboard/stats). The server emits the full rich
// 30-day DashboardStats payload as NAMED `event: stats` frames, so each frame
// can safely REPLACE the page's cached stats snapshot: the hook writes it into
// the caller's query key and every tile reading that key refreshes without a
// request. A failed server-side refresh arrives as `event: error` with a
// `{code, message}` body; that sentence is rendered, not a made-up one.
//
// TRUTHFULNESS: an open stream that has had no business events is healthy, not
// stale, so the indicator reports the connection MODE plus the time of the
// last confirmed receipt — it never labels silence as failure. While the
// stream is not open, the page's own polling is still the source of truth and
// the indicator says so.
"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Send, Users } from "lucide-react";

import type { DashboardStats } from "@/lib/analytics-api";
import {
  subscribeDashboardLive,
  type StreamStatus,
} from "@/lib/live-streams-api";
import { asRoute } from "@/lib/typed-routes";
import { useOnline } from "@/lib/use-online";
import { cn } from "@/lib/utils";

// ─── Document visibility ───────────────────────────────────────────────────

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => false,
  );
}

// ─── Snapshot validation ───────────────────────────────────────────────────

/**
 * A frame only replaces the cached snapshot when it is shaped like one. A
 * malformed or non-JSON frame costs that one frame; it never blanks the tiles.
 */
export function isDashboardStatsSnapshot(
  value: unknown,
): value is DashboardStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const total = (value as { subscribers_total?: unknown }).subscribers_total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0;
}

function serverFailureSentence(data: unknown): string | null {
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return typeof data === "string" && data.trim() ? data.trim() : null;
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export interface DashboardLiveState {
  status: StreamStatus;
  /** Epoch-ms of the last applied `stats` frame; 0 before the first one. */
  lastEventAt: number;
  /** The server's own failure sentence from an `event: error` frame. */
  failure: string | null;
}

export function useDashboardLive({
  enabled,
  statsKey,
}: {
  /** Identity verified, online, and allowed to read reports. */
  enabled: boolean;
  /** The page's dashboard/stats query key; frames are written here. */
  statsKey: QueryKey;
}): DashboardLiveState {
  const queryClient = useQueryClient();
  const visible = useDocumentVisible();
  const [status, setStatus] = useState<StreamStatus>("closed");
  const [lastEventAt, setLastEventAt] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const keyRef = useRef(statsKey);
  keyRef.current = statsKey;
  // Identity is part of the key, so a workspace or principal change tears the
  // subscription down and re-opens it under the new key.
  const keySignature = JSON.stringify(statsKey);
  const active = enabled && visible;

  useEffect(() => {
    if (!active) {
      setStatus("closed");
      return undefined;
    }
    const key = keyRef.current;
    let current = true;
    setFailure(null);
    setLastEventAt(0);
    const unsubscribe = subscribeDashboardLive({
      onStatus: (next) => {
        if (current) setStatus(next);
      },
      onEvent: (data) => {
        if (!current || !isDashboardStatsSnapshot(data)) return;
        queryClient.setQueryData(key, data);
        setLastEventAt(Date.now());
        setFailure(null);
      },
      onServerError: (data) => {
        if (!current) return;
        setFailure(
          serverFailureSentence(data) ??
            "The live dashboard stream reported an error without a message.",
        );
      },
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [active, keySignature, queryClient]);

  return { status: active ? status : "closed", lastEventAt, failure };
}

// ─── Relative clock ────────────────────────────────────────────────────────

function useNow(enabled: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

export function relativeAge(ageMs: number): string {
  const seconds = Math.floor(Math.max(0, ageMs) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

// ─── StaleIndicator ────────────────────────────────────────────────────────

function Dot({ tone }: { tone: "live" | "wait" | "idle" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        tone === "live" && "bg-success",
        tone === "wait" && "bg-warning",
        tone === "idle" && "bg-muted-foreground/50",
      )}
    />
  );
}

export function StaleIndicator({
  status,
  lastSuccessAt,
  offline = false,
  failure = null,
  fallbackPollSeconds = 60,
  showReceipt = true,
  tone = "default",
}: {
  status: StreamStatus;
  /** Epoch-ms of the last confirmed stats receipt (HTTP or live); 0 = none. */
  lastSuccessAt: number;
  offline?: boolean;
  failure?: string | null;
  /** The page's polling cadence while the stream is not open. */
  fallbackPollSeconds?: number;
  /** Hide the receipt when a parent rail presents one named freshness value. */
  showReceipt?: boolean;
  tone?: "default" | "ink";
}) {
  const hasReceipt = lastSuccessAt > 0;
  const now = useNow(hasReceipt);
  const receipt = hasReceipt ? relativeAge(now - lastSuccessAt) : null;
  const pollLabel = `Polling every ${fallbackPollSeconds}s`;

  let statusTone: "live" | "wait" | "idle";
  let mode: string;
  if (offline) {
    statusTone = "idle";
    mode = receipt
      ? "Offline · last confirmed data"
      : "Offline · no confirmed data";
  } else if (status === "open") {
    statusTone = "live";
    mode = "Live updates on";
  } else if (status === "connecting") {
    statusTone = "wait";
    mode = `Connecting live updates · ${pollLabel}`;
  } else {
    statusTone = "idle";
    mode = pollLabel;
  }

  return (
    <span
      data-testid="dashboard-live-indicator"
      data-live-status={offline ? "offline" : status}
      className={cn(
        "inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs",
        tone === "ink" ? "text-white/75" : "text-muted-foreground",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <Dot tone={statusTone} />
        <span role="status">{mode}</span>
      </span>
      {receipt && showReceipt ? (
        <span className="tabular-nums">Updated {receipt}</span>
      ) : null}
      {failure ? (
        <span
          role="alert"
          className={tone === "ink" ? "text-red-300" : "text-destructive"}
        >
          {failure}
        </span>
      ) : null}
    </span>
  );
}

// ─── LiveSubsChip ──────────────────────────────────────────────────────────

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function LiveSubsChip({
  stats,
  tone = "default",
}: {
  stats: DashboardStats | null | undefined;
  tone?: "default" | "ink";
}) {
  const total = safeCount(stats?.subscribers_total);
  // Nothing until a real total arrives — a "0 subscribers" flash before the
  // first receipt would be a fabricated number.
  if (total === null) return null;
  const added = safeCount(stats?.subscribers_added_30d);
  const totalLabel = total.toLocaleString();
  const deltaLabel = added && added > 0 ? `+${added.toLocaleString()}` : null;
  return (
    <Link
      href={asRoute("/app/subscribers")}
      data-testid="live-subs-chip"
      aria-label={`${totalLabel} subscribers${deltaLabel ? `, ${deltaLabel} in the last 30 days` : ""}. Open subscribers.`}
      className={cn(
        "inline-flex items-center gap-1.5 border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "ink"
          ? "min-h-7 rounded-md border-white/20 bg-white/10 text-white hover:border-mw-yellow hover:bg-white/15"
          : "min-h-8 rounded-full bg-card hover:border-primary/40 hover:bg-accent/40",
      )}
    >
      <Users
        className={cn(
          "h-3.5 w-3.5",
          tone === "ink" ? "text-white/70" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <span className="font-medium tabular-nums">{totalLabel}</span>
      {deltaLabel ? (
        <span
          className={cn(
            "tabular-nums",
            tone === "ink" ? "text-emerald-300" : "text-success",
          )}
        >
          {deltaLabel}
        </span>
      ) : null}
    </Link>
  );
}

// ─── ActiveSendStrip ───────────────────────────────────────────────────────

export interface ActiveSendCampaign {
  id: string;
  name?: string | null;
  status?: string | null;
  open_rate?: number | null;
  click_rate?: number | null;
}

function formatRate(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  // Campaign rates arrive as 0..1 fractions on this API.
  if (value > 1) return null;
  return `${(value * 100).toFixed(1)}%`;
}

export function ActiveSendStrip({
  campaigns,
  tone = "default",
}: {
  /** The verified campaigns list; null while unknown or failed. */
  campaigns: readonly ActiveSendCampaign[] | null | undefined;
  tone?: "default" | "ink";
}) {
  const rows = Array.isArray(campaigns) ? campaigns : [];
  const sending = rows.find(
    (campaign) =>
      typeof campaign?.id === "string" &&
      campaign.id.length > 0 &&
      String(campaign.status ?? "").toLowerCase() === "sending",
  );
  if (!sending) return null;
  const name = sending.name?.trim() || "Untitled campaign";
  const openRate = formatRate(sending.open_rate);
  const clickRate = formatRate(sending.click_rate);
  const rates: ReactNode[] = [];
  if (openRate) rates.push(<span key="open">{openRate} open</span>);
  if (clickRate) rates.push(<span key="click">{clickRate} click</span>);
  return (
    <Link
      href={asRoute(`/app/campaigns/${encodeURIComponent(sending.id)}`)}
      data-testid="active-send-strip"
      aria-label={`${name} is currently sending. Open the campaign.`}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-2 border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "ink"
          ? "min-h-7 rounded-md border-white/20 bg-white/10 text-white hover:border-mw-yellow hover:bg-white/15"
          : "min-h-8 rounded-full border-primary/30 bg-accent/40 hover:border-primary/60",
      )}
    >
      <Send
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          tone === "ink" ? "text-white/70" : "text-primary",
        )}
        aria-hidden
      />
      <span className="shrink-0 font-medium">Sending</span>
      <strong className="min-w-0 truncate" title={name}>
        {name}
      </strong>
      {rates.length > 0 ? (
        <span
          className={cn(
            "inline-flex shrink-0 gap-2 tabular-nums",
            tone === "ink" ? "text-white/70" : "text-muted-foreground",
          )}
        >
          {rates}
        </span>
      ) : null}
    </Link>
  );
}

// ─── Composite ─────────────────────────────────────────────────────────────

/**
 * One mount point for the home header: opens the live stream (writing frames
 * into `statsKey`), then renders the freshness indicator, the live subscriber
 * chip, and the active-send strip.
 */
export function DashboardLiveBar({
  enabled,
  statsKey,
  stats,
  statsUpdatedAt,
  campaigns,
  fallbackPollSeconds = 60,
  tone = "default",
  showReceipt = true,
}: {
  enabled: boolean;
  statsKey: QueryKey;
  stats: DashboardStats | null | undefined;
  /** statsQuery.dataUpdatedAt — live frames advance it via setQueryData. */
  statsUpdatedAt: number;
  campaigns: readonly ActiveSendCampaign[] | null | undefined;
  fallbackPollSeconds?: number;
  tone?: "default" | "ink";
  showReceipt?: boolean;
}) {
  const online = useOnline();
  const live = useDashboardLive({
    enabled: enabled && online === "online",
    statsKey,
  });
  return (
    <div
      data-testid="dashboard-live-bar"
      data-tone={tone}
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      <StaleIndicator
        status={live.status}
        lastSuccessAt={statsUpdatedAt}
        offline={online === "offline"}
        failure={live.failure}
        fallbackPollSeconds={fallbackPollSeconds}
        showReceipt={showReceipt}
        tone={tone}
      />
      <LiveSubsChip stats={stats} tone={tone} />
      <ActiveSendStrip campaigns={campaigns} tone={tone} />
    </div>
  );
}
