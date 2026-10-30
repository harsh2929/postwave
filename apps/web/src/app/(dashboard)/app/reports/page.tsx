// SPDX-License-Identifier: AGPL-3.0-only
//
// Reports on web — the surface ECO-13 asked for.
//
// The server has been reachable throughout and web referenced `v1/reporting`
// nowhere, so a report saved anywhere was invisible here. The provenance half
// (metric_version, computed_as_of) was already built; what was missing was
// anywhere to read it.

import type { Metadata } from "next";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { RecentRuns } from "./_components/recent-runs";
import { ReportBuilder } from "./_components/report-builder";
import { SavedReports } from "./_components/saved-reports";

export const metadata: Metadata = {
  title: "Reports",
};

export default function ReportsPage() {
  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Reports
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Saved report definitions, with the metric version and filters each one
          was defined against — the same values any other surface shows for the
          same report.
        </p>
      </header>

      <section aria-labelledby="reports-builder">
        <Card>
          <CardHeader>
            <CardTitle as="h2" id="reports-builder">
              Build a report
            </CardTitle>
            <CardDescription>
              Choose metrics, inspect the result, then save the definition for
              your workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReportBuilder />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="reports-saved">
        <Card>
          <CardHeader>
            <CardTitle as="h2" id="reports-saved">
              Saved reports
            </CardTitle>
            <CardDescription>
              Definitions shared by every Moosewave surface, including their
              metric and filter provenance.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SavedReports />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="reports-runs">
        <Card>
          <CardHeader>
            <CardTitle as="h2" id="reports-runs">
              Recent runs
            </CardTitle>
            <CardDescription>
              What each run measured, and how current its source data was.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RecentRuns />
          </CardContent>
        </Card>
      </section>
    </PageShell>
  );
}
