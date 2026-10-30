// SPDX-License-Identifier: AGPL-3.0-only
//
// A saved or stale record URL must fail closed too. In particular, do not use
// the dynamic id to query the unmounted affiliate administration API.
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";

import { AffiliateProgramUnavailable } from "../_components/affiliate-program-unavailable";

export default function AffiliateDetailPage() {
  return (
    <PageShell>
      <Link
        href="/app/affiliates"
        className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-9"
      >
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        Affiliate status
      </Link>
      <AffiliateProgramUnavailable
        embedded
        title="Affiliate record access is unavailable"
        description="This saved record link cannot load partner data while affiliate administration is closed. No record lookup was attempted."
      />
    </PageShell>
  );
}
