// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";

// Dashboard-scoped 404: a notFound() thrown inside an authenticated /app route
// keeps the workspace framing and points back to the dashboard. Public /
// marketing 404s are handled by the marketing-styled root and (marketing)
// boundaries instead.
export default function DashboardNotFoundPage() {
  return (
    <section
      aria-labelledby="dashboard-not-found-title"
      className="min-h-full min-w-0 bg-muted/20 px-4 py-8 text-foreground sm:px-6 sm:py-16"
    >
      <div className="mx-auto w-full min-w-0 max-w-xl rounded-2xl border bg-card p-5 shadow-sm sm:p-8">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          404
        </p>
        <h1
          id="dashboard-not-found-title"
          className="mt-2 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]"
        >
          This page is not available.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
          The link may be stale, or the resource may belong to another
          workspace.
        </p>
        <div className="mt-6">
          <Button
            asChild
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
          >
            <Link href="/app">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to dashboard
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
