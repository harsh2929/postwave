// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { ShieldCheck, UsersRound } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
} from "@/components/integrations/data-surface";
import { Button } from "@/components/ui/button";
import { whoami } from "@/lib/auth-api";
import { STALE } from "@/lib/query-keys";
const AudienceSyncsManager = dynamic(
  () =>
    import("./audience-syncs-manager").then(
      (module) => module.AudienceSyncsManager,
    ),
  {
    ssr: false,
    loading: () => (
      <section
        role="status"
        aria-busy="true"
        className="min-h-40 rounded-xl border border-dashed p-5 text-sm text-muted-foreground"
      >
        Loading protected audience sync operations…
      </section>
    ),
  },
);

export default function AudienceSyncsPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });

  if (meQuery.isLoading || meQuery.isError || !meQuery.data) {
    return (
      <DataSurfaceShell className="max-w-5xl">
        <DataSurfaceHeader
          icon={UsersRound}
          eyebrow="Audience activation"
          title="Audience syncs"
          description="Manage signed audience delivery and preserve the compliance record of who was deliberately withheld from every run."
        />
        {meQuery.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : (
          <QueryError
            title="Workspace identity could not be loaded"
            description="Sync, run-history, preview, and receipt requests were not started without a verified workspace context."
            onRetry={() => void meQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-5xl">
      <DataSurfaceHeader
        icon={UsersRound}
        eyebrow="Audience activation"
        title="Audience syncs"
        description="Create and operate signed webhook syncs, inspect consent exclusions before delivery, and download signed per-run evidence on demand."
        actions={
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/app/audience-destinations">View destinations</Link>
          </Button>
        }
      />

      <AudienceSyncsManager me={meQuery.data} />

      <aside className="flex gap-3 rounded-xl border bg-muted/20 p-4">
        <ShieldCheck
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-primary"
        />
        <div>
          <h2 className="text-sm font-semibold">
            Delivery and evidence boundaries
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Webhook delivery is implemented in-repo with HMAC-signed batches.
            Ad-platform delivery additionally depends on configured credential
            resolution, provider drivers, account approval, and app review. A
            stored row or readiness result does not certify those external
            holds. Receipt downloads contain subscriber emails, require admin
            scope, and are never placed in the query or offline cache.
          </p>
        </div>
      </aside>
    </DataSurfaceShell>
  );
}
