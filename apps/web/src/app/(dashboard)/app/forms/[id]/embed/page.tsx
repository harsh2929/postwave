// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { EmbedFlavorPicker } from "@/components/forms/embed-flavor-picker";
import { CopyTextButton } from "@/components/copy-text-button";
import { Button } from "@/components/ui/button";
import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/dashboard/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { whoami } from "@/lib/auth-api";
import { getForm, publicFormUrl } from "@/lib/forms-api";
import { useFormsOrigin } from "@/lib/use-forms-origin";
import { base, qk, STALE } from "@/lib/query-keys";

// Below the hosted URL and the flavor picker, the snippet builder, QR card
// and live preview each carry their own helper libraries (snippet composer,
// QR encoder + download, form compiler). They are split out of the eager
// route graph (bundle budget); each fallback keeps its block's silhouette.
function DeferredEmbedBlock({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <div role="status" aria-label={`Loading ${label}`}>
      <Skeleton className={className} />
    </div>
  );
}

const EmbedSnippet = dynamic(
  () =>
    import("@/components/forms/embed-snippet").then((mod) => mod.EmbedSnippet),
  {
    loading: () => (
      <DeferredEmbedBlock
        label="embed snippet options"
        className="h-64 w-full"
      />
    ),
  },
);

const FormQrCard = dynamic(
  () => import("@/components/forms/form-qr-card").then((mod) => mod.FormQrCard),
  {
    loading: () => (
      <DeferredEmbedBlock label="QR code" className="h-48 w-full" />
    ),
  },
);

const FormPreview = dynamic(
  () =>
    import("@/components/forms/form-preview").then((mod) => mod.FormPreview),
  {
    loading: () => (
      <DeferredEmbedBlock label="form preview" className="h-[520px] w-full" />
    ),
  },
);

export default function EmbedPage() {
  const { id } = useParams<{ id: string }>();
  const host = useFormsOrigin();

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const formsBaseKey = useMemo(
    () => base("forms", tenantId, role),
    [role, tenantId],
  );
  const formDetailKey = useMemo(
    () => [...formsBaseKey, "detail", id] as const,
    [formsBaseKey, id],
  );
  const formQuery = useQuery({
    queryKey: formDetailKey,
    queryFn: () => getForm(id),
    enabled: meQuery.isFetched,
    staleTime: STALE.detail,
  });

  const form = formQuery.data ?? null;
  const loading = meQuery.isLoading || (formQuery.isPending && !formQuery.data);
  const error =
    formQuery.error instanceof Error
      ? formQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : formQuery.isError
          ? "Could not load this form — this is a failed request, not a form without an embed."
          : null;

  if (error) {
    return (
      <div className="space-y-3 p-4 sm:p-6 lg:p-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Embed unavailable
        </h1>
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void meQuery.refetch();
            void formQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (loading || !form) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
        <h1 className="sr-only">Loading embed instructions</h1>
        <PageHeaderSkeleton />
        <TableSkeleton rows={5} columns={["w-40", "w-full"]} />
      </div>
    );
  }

  const hostedUrl = publicFormUrl(form.slug, host);

  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div>
        <Link
          href={`/app/forms/${form.id}`}
          className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground"
        >
          ← {form.name}
        </Link>
        <h1 className="font-display text-2xl font-semibold tracking-tight mt-1">
          Embed
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Drop your form into any site, or share the hosted page directly.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <a
            href={hostedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 min-w-0 flex-1 items-center break-all font-mono text-xs text-foreground underline-offset-4 hover:underline sm:truncate"
          >
            {hostedUrl}
          </a>
          <CopyTextButton value={hostedUrl} label="Copy URL" />
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="min-w-0 space-y-6 lg:col-span-7">
          <EmbedFlavorPicker formId={form.id} identity={meQuery.data} />
          <div className="min-w-0 space-y-3">
            <div>
              <h2 className="text-sm font-semibold">
                Popup &amp; inline options
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Tune sizing, popup triggers, and targeting for a customized
                snippet built in your browser.
              </p>
            </div>
            <EmbedSnippet slug={form.slug} host={host} />
          </div>
          <FormQrCard url={hostedUrl} filenameBase={form.slug} />
        </div>
        <div className="min-w-0 lg:col-span-5">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
            Live preview
          </h3>
          <FormPreview form={form} height={520} />
        </div>
      </div>
    </div>
  );
}
