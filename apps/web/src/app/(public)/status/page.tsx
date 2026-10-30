// SPDX-License-Identifier: AGPL-3.0-only
//
// Public status page at /status (rendered under the (public) route
// group, which the marketing layout owns). Wholly anonymous: no
// cookies, no auth — fetches /api/public/status from the API gateway
// with a 30-second server cache so incident traffic does not stampede the API.
//
// Sections (top to bottom):
//   1. Big banner — "All systems operational" / "Some systems
//      experiencing issues" / "Major outage" tied to overall_status.
//   2. Active incidents (only rendered when non-empty).
//   3. Service grid — one card per service with current status, the
//      30-day uptime ratio, and the last-pinged timestamp.
//   4. 90-day history chart — one row per service, square per day,
//      colored by uptime tier.
//   5. Recent (resolved) incidents — last 30 days, scannable list.
//   6. Subscribe + runbook footer — subscription requests are intentionally
//      mailto-only until automated status notifications are wired.
//
// Server-rendered + 30s revalidate so a viral incident doesn't hammer
// the API.

import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { fetchPublicStatus, type PublicStatus } from "@/lib/public-status-api";
import { publicSiteOrigin } from "@/lib/site-url";

import { HistoryChart, statusHistoryId } from "./_history-chart";

const STATUS_URL = `${publicSiteOrigin()}/status`;

export const metadata: Metadata = {
  title: "Moosewave status",
  description:
    "Live operational status for the Moosewave platform: api, voice, deliverability, migration, and automation services.",
  alternates: { canonical: STATUS_URL },
  robots: { index: true, follow: true },
};

export const revalidate = 30;

const OVERALL_LABEL: Record<PublicStatus["overall_status"], string> = {
  ok: "All systems operational",
  degraded: "Some systems experiencing issues",
  down: "Major outage in progress",
};

type DisplayStatus = PublicStatus["overall_status"] | "unknown";

const OVERALL_BG: Record<DisplayStatus, string> = {
  ok: "bg-emerald-50 border-emerald-200 text-emerald-900",
  degraded: "bg-amber-50 border-amber-200 text-amber-900",
  down: "bg-red-50 border-red-200 text-red-900",
  unknown: "bg-slate-50 border-slate-200 text-slate-900",
};

const OVERALL_DOT: Record<DisplayStatus, string> = {
  ok: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
  unknown: "bg-slate-400",
};

const SERVICE_DOT: Record<string, string> = {
  ok: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
};

const SERVICE_LABEL: Record<string, string> = {
  ok: "Operational",
  degraded: "Degraded",
  down: "Down",
};

const SEVERITY_BADGE: Record<string, string> = {
  minor: "bg-amber-100 text-amber-900 border-amber-200",
  major: "bg-orange-100 text-orange-900 border-orange-200",
  critical: "bg-red-100 text-red-900 border-red-200",
};

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function fmtRelative(iso: string): string {
  if (!iso) return "no data";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "no data";
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function fmtIncidentDate(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export default async function StatusPage(): Promise<JSX.Element> {
  // Status is runtime state, not release input. Waiting for a real request
  // keeps image builds independent of API/network availability; the fetch
  // below still uses the shared 30-second data cache.
  await connection();
  const snapshot = await fetchPublicStatus();
  const overall = snapshot.overall_status;
  const services = snapshot.services ?? [];
  const active = snapshot.active_incidents ?? [];
  const recent = snapshot.recent_incidents ?? [];
  const history = snapshot.history_90d ?? {};
  const hasGeneratedAt = Boolean(
    snapshot.generated_at && !Number.isNaN(Date.parse(snapshot.generated_at)),
  );
  const hasServiceData = services.length > 0;
  const hasVerifiedSnapshot = hasServiceData && hasGeneratedAt;
  const displayStatus: DisplayStatus = hasVerifiedSnapshot
    ? overall
    : "unknown";
  const overallLabel = hasVerifiedSnapshot
    ? OVERALL_LABEL[overall]
    : hasGeneratedAt
      ? "Service monitoring is initializing"
      : "Status data temporarily unavailable";

  return (
    <>
      <a
        href="#status-main"
        className="sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-foreground focus:px-3 focus:text-sm focus:font-medium focus:text-background focus:not-sr-only"
      >
        Skip to content
      </a>
      <main
        id="status-main"
        tabIndex={-1}
        className="mx-auto max-w-5xl space-y-10 px-4 py-8 outline-none sm:px-6 sm:py-12"
      >
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-2">
            <h1 className="break-words text-3xl font-semibold tracking-tight">
              Moosewave status
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {hasGeneratedAt ? (
                <>
                  Last updated{" "}
                  <time dateTime={snapshot.generated_at}>
                    {fmtRelative(snapshot.generated_at)}
                  </time>
                  .{" "}
                </>
              ) : (
                <>A current monitoring timestamp is not available. </>
              )}
              History reflects up to the last 90 days.
            </p>
          </div>
          <Link
            href="/status"
            prefetch={false}
            className="inline-flex min-h-11 shrink-0 items-center justify-center self-start rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:self-auto"
          >
            Refresh status
          </Link>
        </header>

        <section
          role="status"
          aria-label="Overall status"
          className={`flex items-start gap-3 rounded-2xl border p-5 shadow-sm ${OVERALL_BG[displayStatus]}`}
          aria-live="polite"
        >
          <span
            className={`mt-1 inline-block size-3 shrink-0 rounded-full ${OVERALL_DOT[displayStatus]}`}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block break-words text-base font-semibold">
              {overallLabel}
            </span>
            {!hasVerifiedSnapshot ? (
              <span className="mt-1 block text-sm leading-6 opacity-80">
                We cannot verify individual service health from this snapshot.
                Refresh in a moment for the latest details.
              </span>
            ) : null}
          </span>
        </section>

        {active.length > 0 && (
          <section
            className="space-y-4"
            aria-labelledby="active-incidents-heading"
          >
            <h2
              id="active-incidents-heading"
              className="text-xl font-semibold tracking-tight"
            >
              Active incidents
            </h2>
            <ul className="space-y-3">
              {active.map((inc) => (
                <li
                  key={inc.id}
                  className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/50 p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span
                      className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-medium capitalize ${SEVERITY_BADGE[inc.severity] ?? "bg-muted"}`}
                    >
                      {inc.severity}
                    </span>
                    <span className="text-xs capitalize text-muted-foreground">
                      {inc.status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      started {fmtIncidentDate(inc.started_at)}
                    </span>
                  </div>
                  <h3 className="break-words font-semibold [overflow-wrap:anywhere]">
                    {inc.title}
                  </h3>
                  {inc.description && (
                    <p className="break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                      {inc.description}
                    </p>
                  )}
                  {inc.affected_services?.length > 0 && (
                    <p className="break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                      Affected: {inc.affected_services.join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-4" aria-labelledby="services-heading">
          <h2
            id="services-heading"
            className="text-xl font-semibold tracking-tight"
          >
            Services
          </h2>
          <div
            data-testid="status-service-grid"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {services.map((svc) => (
              <article
                key={svc.service}
                data-testid="status-service"
                className="space-y-3 rounded-xl border bg-card p-4 shadow-sm"
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <h3 className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">
                    {svc.service}
                  </h3>
                  <span
                    data-testid="status-indicator"
                    className="inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium"
                  >
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${SERVICE_DOT[svc.status] ?? "bg-muted"}`}
                      aria-hidden
                    />
                    {SERVICE_LABEL[svc.status] ?? svc.status}
                  </span>
                </div>
                <dl className="space-y-2 text-xs text-muted-foreground">
                  <div className="flex justify-between gap-4">
                    <dt>30-day uptime</dt>
                    <dd className="tabular-nums">{fmtPct(svc.uptime_30d)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>Last ping</dt>
                    <dd>{fmtRelative(svc.last_pinged_at)}</dd>
                  </div>
                </dl>
                <a
                  href={`#${statusHistoryId(svc.service)}`}
                  className="inline-flex min-h-11 items-center rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  View 90-day history →
                </a>
              </article>
            ))}
            {services.length === 0 && (
              <p className="col-span-full rounded-xl border border-dashed bg-muted/20 p-5 text-sm leading-6 text-muted-foreground">
                Individual service details are not available in this snapshot.
              </p>
            )}
          </div>
        </section>

        <section data-testid="status-history-chart" className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">
            90-day history
          </h2>
          <HistoryChart history={history} />
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">
            Recent incidents
          </h2>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No incidents in the last 30 days.
            </p>
          ) : (
            <ul className="space-y-2">
              {recent.map((inc) => (
                <li
                  key={inc.id}
                  className="flex flex-col items-start gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row"
                >
                  <span
                    className={`inline-flex min-h-7 shrink-0 items-center rounded-full border px-2.5 text-xs font-medium capitalize ${SEVERITY_BADGE[inc.severity] ?? "bg-muted"}`}
                  >
                    {inc.severity}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="break-words text-sm font-semibold [overflow-wrap:anywhere]">
                      {inc.title}
                    </p>
                    <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                      {fmtIncidentDate(inc.started_at)}
                      {inc.resolved_at
                        ? ` · resolved ${fmtIncidentDate(inc.resolved_at)}`
                        : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="flex flex-col gap-3 border-t pt-5 text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
            <Link
              href="/login"
              prefetch={false}
              className="inline-flex min-h-11 items-center rounded-sm px-1 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Sign in
            </Link>
            <a
              href="mailto:status-subscribe@moosewave.com?subject=Subscribe%20to%20status%20updates"
              className="inline-flex min-h-11 items-center rounded-sm px-1 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Subscribe to updates
            </a>
          </div>
		  <Link
			href="/docs"
			className="inline-flex min-h-11 items-center rounded-sm px-1 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
		  >
			Incident response runbook
		  </Link>
        </footer>
      </main>
    </>
  );
}
