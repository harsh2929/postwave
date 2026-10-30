// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { PageHeaderSkeleton } from "@/components/dashboard/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

// The editor is the route's heavy module; loading it on demand keeps the
// route's initial JavaScript under the bundle budget. The fallback mirrors the
// editor's silhouette and is labelled so the page harness waits for it.
const SegmentEditor = dynamic(
  () =>
    import("@/components/segments/segment-editor").then(
      (module) => module.SegmentEditor,
    ),
  {
    loading: () => (
      <div
        role="status"
        aria-label="Loading segment editor"
        className="space-y-4"
      >
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
      </div>
    ),
  },
);
import { ApiError } from "@/lib/api";
import { getSegment, type Segment } from "@/lib/segments-api";

export default function EditSegmentPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [segment, setSegment] = React.useState<Segment | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setError(null);
    setSegment(null);
    getSegment(id)
      .then((s) => {
        if (!cancelled) setSegment(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  if (error) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Segment editor unavailable
        </h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive-emphasis"
        >
          {notFound
            ? "This segment no longer exists — it may have been deleted."
            : `Couldn't load this segment. ${
                error instanceof Error ? error.message : ""
              }`}
        </div>
        <div className="flex items-center gap-2">
          {!notFound ? (
            <Button onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link href="/app/subscribers/segments">Back to segments</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!segment) {
    // Shaped skeleton matching the editor (SEG-024) — no bare "Loading…" swap.
    return (
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="sr-only">Loading segment editor</h1>
        <Skeleton className="h-4 w-64" />
        <div className="flex items-start justify-between gap-4">
          <PageHeaderSkeleton />
          <Skeleton className="h-14 w-40 rounded-md" />
        </div>
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
    );
  }
  return <SegmentEditor initial={segment} />;
}
