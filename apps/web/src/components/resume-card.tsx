// SPDX-License-Identifier: AGPL-3.0-only
//
// Dashboard "Continue where you left off" card (Phase 1 — Continuity). Reads
// the cross-device resume cursor and, when one exists and still resolves to a
// known route, offers a one-tap link back to it. Renders nothing while
// loading, when signed out, or when there is no cursor — so the dashboard is
// unchanged for a fresh session.
//
// SHELL-030: the server cursor endpoint is best-effort. When it errors (or is
// simply empty), the card falls back to the client's local recent-destinations
// recency so the resume affordance doesn't silently vanish on a backend hiccup
// — it just becomes a same-device rather than cross-device resume.
"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, History } from "lucide-react";

import {
  fetchLastViewed,
  resumeHref,
  resumeTypeLabel,
} from "@/lib/activity-cursor";
import { whoami } from "@/lib/auth-api";
import { readRecentDestinations } from "@/lib/recent-destinations";
import { STALE } from "@/lib/query-keys";
import { timeAgo } from "@/lib/relative-time";

export function ResumeCard() {
  const query = useQuery({
    queryKey: ["activity", "last-viewed"],
    queryFn: () => fetchLastViewed(),
    staleTime: 60_000,
    // Settle fast so the local fallback can render promptly when the
    // endpoint is unavailable, rather than after the default retry storm.
    retry: false,
  });
  const meQuery = useQuery({
    queryKey: ["auth-me"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });

  const cursor = query.data;
  const serverHref = cursor ? resumeHref(cursor) : null;

  // Local fallback only once the server query has SETTLED without a usable
  // cursor — otherwise we'd flash the local card then swap to the server one.
  // Safe to read localStorage synchronously: the parent only mounts this card
  // client-side (`mounted ? <ResumeCard/> : null`), so there's no SSR mismatch.
  const pathname = usePathname();
  const tenantId = meQuery.data?.tenant_id ?? "";
  const local =
    !serverHref && !query.isLoading && tenantId
      ? // Most recent destination that isn't the page we're already on, so the
        // fallback never links back to itself.
        (readRecentDestinations(tenantId).find((d) => d.href !== pathname) ??
        null)
      : null;

  const target =
    serverHref && cursor
      ? {
          href: serverHref,
          label: resumeTypeLabel(cursor),
          sub: timeAgo(cursor.viewed_at)
            ? `viewed ${timeAgo(cursor.viewed_at)}`
            : "",
        }
      : local
        ? { href: local.href, label: local.label, sub: "recently visited" }
        : null;

  if (!target) return null;

  return (
    <Link
      href={target.href as Route}
      data-testid="resume-card"
      className="group flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"
        >
          <History className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium">Continue where you left off</div>
          <div className="truncate text-xs text-muted-foreground">
            {target.label}
            {target.sub ? ` · ${target.sub}` : ""}
          </div>
        </div>
      </div>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
