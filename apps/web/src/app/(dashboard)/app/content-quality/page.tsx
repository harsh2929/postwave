// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Content quality — subject-line patterns, template ranking, AI regression.
 *
 * Three paths desktop reached and web did not.
 *
 * All three are empty in this workspace, for three different reasons, and
 * the page keeps them distinct:
 *
 *   - No subject-line patterns because there were no campaigns in the window
 *     — not because the copy showed no pattern.
 *   - No ranked templates, with nothing said about why.
 *   - No AI regression run has EVER completed, which is not the same as a run
 *     that completed clean. "Never checked" must not render as "checked and
 *     fine".
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  getLatestRegressionRun,
  getSubjectBuckets,
  getTemplateLeaderboard,
  subjectEmptiness,
} from "@/lib/content-quality-api";
import { base, qk, STALE } from "@/lib/query-keys";

function formatRate(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return `${percent.toFixed(1)}%`;
}

export default function ContentQualityPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = Boolean(
    meQuery.isSuccess && meQuery.data?.tenant_id && meQuery.data?.user_id,
  );
  const keyBase = useMemo(
    () =>
      base(
        "content-quality",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const subjects = useQuery({
    queryKey: [...keyBase, "subject-buckets"],
    queryFn: getSubjectBuckets,
    enabled: canLoad,
    staleTime: STALE.list,
  });
  const templates = useQuery({
    queryKey: [...keyBase, "template-leaderboard"],
    queryFn: getTemplateLeaderboard,
    enabled: canLoad,
    staleTime: STALE.list,
  });
  const regression = useQuery({
    queryKey: [...keyBase, "ai-regression"],
    queryFn: getLatestRegressionRun,
    enabled: canLoad,
    staleTime: STALE.list,
  });

  const s = subjects.data;
  const emptiness = s ? subjectEmptiness(s) : null;
  const templateRows = Array.isArray(templates.data) ? templates.data : [];
  const hasRun = regression.data != null;

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Content quality
        </h1>
        {meQuery.isPending ? (
          <p role="status">Loading workspace identity…</p>
        ) : (
          <ContentQueryError
            message="Workspace identity could not be loaded. No private data was requested."
            onRetry={() => meQuery.refetch()}
            retrying={meQuery.isFetching}
          />
        )}
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-4xl">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Content quality
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What your subject lines and templates are doing, and whether the AI
          features still behave.
        </p>
      </header>

      <section
        aria-labelledby="cq-subjects"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="cq-subjects" className="text-base font-medium">
          Subject-line patterns
        </h2>
        {subjects.isLoading ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : subjects.isError || !s ? (
          <ContentQueryError
            message="Could not load subject-line patterns."
            onRetry={() => subjects.refetch()}
            retrying={subjects.isFetching}
          />
        ) : emptiness === "no-campaigns" ? (
          // Absence of campaigns, NOT a verdict on the copy.
          <p className="mt-2 text-sm text-muted-foreground">
            No campaigns were sent in the last {s.window_days} days, so there is
            nothing to analyse. This is not a finding about your subject lines.
          </p>
        ) : emptiness === "no-patterns" ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {s.campaigns_total.toLocaleString()} campaigns over the last{" "}
            {s.window_days} days produced no distinguishable subject-line
            pattern.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {s.buckets.length} pattern{s.buckets.length === 1 ? "" : "s"} across{" "}
            {s.campaigns_total.toLocaleString()} campaigns in the last{" "}
            {s.window_days} days.
          </p>
        )}
        {!subjects.isLoading &&
        !subjects.isError &&
        s &&
        emptiness === "has-buckets" ? (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {s.buckets.map((bucket, index) => (
              <li
                key={`${bucket.attribute}:${bucket.bucket}:${index}`}
                className="min-w-0 rounded-lg border bg-card p-3 text-sm"
              >
                <p className="break-words font-medium capitalize">
                  {(bucket.attribute || "Pattern").replaceAll("_", " ")}:{" "}
                  {bucket.bucket || "Unlabelled"}
                </p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Campaigns</dt>
                    <dd className="tabular-nums">
                      {bucket.campaigns?.toLocaleString() ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Open rate</dt>
                    <dd className="tabular-nums">
                      {formatRate(bucket.open_rate)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Click rate</dt>
                    <dd className="tabular-nums">
                      {formatRate(bucket.click_rate)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section
        aria-labelledby="cq-templates"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="cq-templates" className="text-base font-medium">
          Template leaderboard
        </h2>
        {templates.isLoading ? (
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : templates.isError ? (
          <ContentQueryError
            message="Could not load the template leaderboard."
            onRetry={() => templates.refetch()}
            retrying={templates.isFetching}
          />
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {templateRows.length === 0
              ? "No templates have enough sends to be ranked."
              : `${templateRows.length} template(s) ranked.`}
          </p>
        )}
        {!templates.isLoading &&
        !templates.isError &&
        templateRows.length > 0 ? (
          <ol className="mt-3 divide-y rounded-lg border bg-card">
            {templateRows.map((template, index) => (
              <li
                key={template.template_id ?? `template:${index}`}
                className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium">
                    <span className="mr-2 text-muted-foreground">
                      {index + 1}.
                    </span>
                    {template.template_name || `Untitled template ${index + 1}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {template.campaigns_used?.toLocaleString() ?? "—"} campaign
                    {template.campaigns_used === 1 ? "" : "s"} ·{" "}
                    {template.sent?.toLocaleString() ?? "—"} sent
                  </p>
                </div>
                <dl className="flex shrink-0 gap-4 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Open</dt>
                    <dd className="tabular-nums">
                      {formatRate(template.open_rate)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Click</dt>
                    <dd className="tabular-nums">
                      {formatRate(template.click_rate)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section
        aria-labelledby="cq-regression"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="cq-regression" className="text-base font-medium">
          AI regression
        </h2>
        {regression.isLoading ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : regression.isError ? (
          <ContentQueryError
            message="Could not load the latest regression run."
            onRetry={() => regression.refetch()}
            retrying={regression.isFetching}
          />
        ) : !hasRun ? (
          // "Never run" must not read as "run, and clean".
          <p className="mt-2 text-sm text-muted-foreground">
            No AI regression run has ever completed. Nothing here has been
            checked — which is not the same as having been checked and found
            correct.
          </p>
        ) : regression.data ? (
          <div className="mt-3 rounded-lg border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium capitalize">
                {regression.data.status || "Completed run"}
              </p>
              <span className="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground">
                {regression.data.gate_result || "No gate result"}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Mean score</dt>
                <dd className="tabular-nums">
                  {typeof regression.data.fidelity_score_mean === "number"
                    ? `${Math.round(regression.data.fidelity_score_mean)} / 100`
                    : "Not scored"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Scored</dt>
                <dd className="tabular-nums">
                  {regression.data.scored_examples?.toLocaleString() ?? "—"}
                  {typeof regression.data.total_examples === "number"
                    ? ` / ${regression.data.total_examples.toLocaleString()}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Errors</dt>
                <dd className="tabular-nums">
                  {regression.data.error_examples?.toLocaleString() ?? "—"}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              {formatWireTimestamp(
                regression.data.completed_at ?? regression.data.created_at,
                "Completion time unavailable",
              )}
            </p>
          </div>
        ) : null}
      </section>
    </PageShell>
  );
}
