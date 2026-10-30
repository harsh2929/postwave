// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * The "draft designer only" banner under the sequence detail header. Shared
 * by the page's main view and its no-email view.
 */

import { ShieldAlert } from "lucide-react";

import { SEQUENCE_RUNTIME_UNAVAILABLE_REASON } from "@/lib/sequence-operational-availability";

export function SequenceAvailabilityNotice({
  statusDetail,
  editUnavailableReason,
}: {
  statusDetail: string;
  editUnavailableReason: string;
}) {
  return (
    <section
      aria-label="Sequence runtime and editing availability"
      className="flex items-start gap-3 border-b border-warning-subtle bg-warning-subtle/40 px-4 py-3 sm:px-6"
    >
      <ShieldAlert
        className="mt-0.5 h-5 w-5 shrink-0 text-warning-emphasis"
        aria-hidden
      />
      <div className="space-y-1 text-sm">
        <p className="font-medium">Draft designer only — runtime unavailable</p>
        <p className="text-muted-foreground">
          {SEQUENCE_RUNTIME_UNAVAILABLE_REASON}
        </p>
        <p className="text-muted-foreground">Stored status: {statusDetail}</p>
        {editUnavailableReason ? (
          <p className="font-medium text-warning-emphasis">
            Editing locked: {editUnavailableReason}
          </p>
        ) : null}
      </div>
    </section>
  );
}
