// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Sequence detail when the stored record has canvas steps but no email step
 * to review. Loaded on demand by page.tsx; the branch is rare and carries
 * its own copy.
 */

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { Sequence } from "@/lib/voice-types";

import { SequenceAvailabilityNotice } from "./sequence-availability-notice";

export function SequenceNoEmailView({
  seq,
  canEdit,
  statusDetail,
  editUnavailableReason,
  recoveryBanner,
  stepCanvas,
  graphConfirmDialog,
}: {
  seq: Sequence;
  canEdit: boolean;
  statusDetail: string;
  editUnavailableReason: string;
  recoveryBanner: ReactNode;
  stepCanvas: ReactNode;
  graphConfirmDialog: ReactNode;
}) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
      <div className="flex items-start gap-3">
        <Button
          asChild
          variant="ghost"
          size="sm"
          aria-label="Back to sequences"
          title="Back to sequences"
        >
          <Link href="/app/sequences">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="break-words font-display text-2xl font-semibold tracking-tight">
            {seq.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This sequence has {seq.steps?.length ?? 0} canvas steps and no email
            steps to review here.
          </p>
        </div>
      </div>
      <SequenceAvailabilityNotice
        statusDetail={statusDetail}
        editUnavailableReason={editUnavailableReason}
      />
      {recoveryBanner}
      <div className="rounded-md border bg-card">{stepCanvas}</div>
      <div className="rounded-md border bg-card p-6">
        <h2 className="font-medium">No email content to review</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {canEdit
            ? "Add an Email step from the palette to write its copy here. Delay, condition, tag, and exit steps are edited from the canvas above. Nothing is enrolling or sending."
            : "Delay, condition, tag, and exit-only records are valid and listed above; this draft has no top-level email copy to review. Nothing is enrolling or sending."}
        </p>
        <Button asChild className="mt-4">
          <Link href="/app/sequences">Back to sequences</Link>
        </Button>
      </div>
      {graphConfirmDialog}
    </div>
  );
}
