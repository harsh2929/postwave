// SPDX-License-Identifier: AGPL-3.0-only
//
// Keep the navigation boundary honest: this route prepares a static
// availability notice, not affiliate records or financial summaries.
import { PageShell } from "@/components/dashboard/page-shell";

export default function AffiliatesLoading() {
  return (
    <PageShell>
      <h1 className="sr-only">Affiliate operations</h1>
      <div
        aria-busy="true"
        aria-label="Preparing affiliate program status"
        className="space-y-4"
      >
        <div className="h-5 w-24 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
        <div className="h-8 w-80 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <div className="h-5 w-full max-w-2xl animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <div className="h-52 animate-pulse rounded-lg border bg-muted/40 motion-reduce:animate-none" />
      </div>
    </PageShell>
  );
}
