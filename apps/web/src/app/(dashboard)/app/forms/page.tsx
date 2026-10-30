// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";

import { EmptyState as SharedEmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { listForms } from "@/lib/forms-api";
import type { FormListItem } from "@/lib/forms-types";
import { FormsHostedOrigin, FormsPageActions } from "./forms-page-actions";
import { FormsListLazy } from "./forms-list-lazy";

// The multi-channel ops panel sits inside a collapsed <details> below the
// forms table, so it is split out of the eager route graph (bundle budget).
// The fallback keeps the card's silhouette until the chunk lands.
const MultiChannelOpsPanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/multi-channel-ops-panel").then(
      (module) => module.MultiChannelOpsPanel,
    ),
  {
    loading: () => (
      <div
        className="space-y-3 rounded-lg border bg-card p-6"
        role="status"
        aria-label="Loading multi-channel setup"
      >
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    ),
  },
);

export default async function FormsPage() {
  let forms: FormListItem[] = [];
  let loadError: string | null = null;
  try {
    forms = await listForms();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login?next=%2Fapp%2Fforms");
    }
    loadError =
      error instanceof Error ? error.message : "Forms could not be loaded.";
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 overflow-x-clip px-4 py-5 sm:space-y-8 sm:px-6 sm:py-6 lg:p-8">
      <header className="flex min-w-0 flex-col items-start gap-4 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Forms
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Embeddable signup forms with single or double opt-in. Host on{" "}
            <FormsHostedOrigin /> or drop into your site as an iframe, popup, or
            inline embed.
          </p>
        </div>
        <FormsPageActions />
      </header>

      {loadError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-8 text-center text-sm text-destructive-emphasis">
          <p>Forms could not be loaded: {loadError}</p>
          <Link
            href="/app/forms"
            className="mt-3 inline-block underline underline-offset-4"
          >
            Try again
          </Link>
        </div>
      ) : forms.length === 0 ? (
        <EmptyState />
      ) : (
        // Forms table above the fold (FORM-012); the multi-channel ops panel is
        // demoted to a collapsible section below.
        <FormsListLazy initialForms={forms} />
      )}

      <details className="group rounded-md border bg-card/50">
        <summary className="cursor-pointer select-none list-none px-4 py-3 text-sm font-medium marker:hidden">
          <span className="inline-flex items-center gap-2">
            <span className="text-muted-foreground transition-transform group-open:rotate-90">
              ▸
            </span>
            Multi-channel &amp; provider setup
          </span>
        </summary>
        <div className="border-t p-4">
          <MultiChannelOpsPanel />
        </div>
      </details>
    </div>
  );
}

function EmptyState() {
  return (
    <SharedEmptyState
      icon={ClipboardList}
      title="No forms yet"
      description="Build a signup form, choose single or double opt-in, and embed it anywhere. Forms wire straight into your subscriber list."
    />
  );
}
