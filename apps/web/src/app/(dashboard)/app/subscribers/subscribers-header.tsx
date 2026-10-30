// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, Download, Plus, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { SubscriberAuthority } from "@/lib/subscriber-authority";
import type { BulkPasteResponse, Subscriber } from "@/lib/subscribers-api";
import { pluralizeCount } from "@/lib/pluralize";

// Add one subscriber: typo suggestion, deliverability check, and initial
// eligibility that defaults to Unconfirmed — Subscribed needs the reviewed
// opt-in evidence envelope. Loaded only once its trigger is pressed.
const LazyAddSubscriberDialog = dynamic(
  () =>
    import("@/components/subscribers/AddSubscriberDialog").then(
      (module) => module.AddSubscriberDialog,
    ),
  {
    ssr: false,
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading subscriber form…
      </span>
    ),
  },
);

const LazyPasteSubscriberEmailsDialog = dynamic(
  () =>
    import("./subscriber-header-dialogs").then(
      (module) => module.PasteSubscriberEmailsDialog,
    ),
  {
    ssr: false,
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading paste form…
      </span>
    ),
  },
);

export function SubscribersHeader({
  total,
  open,
  onOpenChange,
  onCreated,
  onExport,
  exporting,
  onPaste,
  canWrite = true,
  authority = null,
}: {
  total: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (subscriber: Subscriber) => void;
  onExport: () => void;
  exporting: boolean;
  onPaste: (emails: string, tags: string[]) => Promise<BulkPasteResponse | null>;
  canWrite?: boolean;
  authority?: SubscriberAuthority | null;
}) {
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const pasteTriggerRef = useRef<HTMLButtonElement>(null);
  const [createActivated, setCreateActivated] = useState(open);
  const [pasteActivated, setPasteActivated] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const createWasOpenRef = useRef(open);

  // Preserve the controlled contract for callers that open the form without
  // clicking this header's trigger (for example a command action or the `n`
  // shortcut).
  useEffect(() => {
    if (open) setCreateActivated(true);
  }, [open]);

  // The add dialog is controlled and has no Radix trigger, so Radix has
  // nowhere to return focus when it closes; hand it back to "New subscriber"
  // rather than dropping it on <body>.
  useEffect(() => {
    if (createWasOpenRef.current && !open) createTriggerRef.current?.focus();
    createWasOpenRef.current = open;
  }, [open]);

  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Subscribers
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {pluralizeCount(total, "contact")} in this view.
        </p>
        {/* Sub-nav so Import and Paid members are always reachable (SUB-016). */}
        <nav
          aria-label="Subscriber views"
          className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm"
        >
          <Link
            href="/app/subscribers/segments"
            className="inline-flex min-h-8 items-center text-muted-foreground hover:text-foreground"
            data-tour="dashboard-segments"
          >
            Segments
          </Link>
          <Link
            href="/app/subscribers/import"
            className="inline-flex min-h-8 items-center text-muted-foreground hover:text-foreground"
          >
            Import
          </Link>
          <Link
            href="/app/subscribers/paid-members"
            className="inline-flex min-h-8 items-center text-muted-foreground hover:text-foreground"
          >
            Paid members
          </Link>
          <Link
            href="/app/subscribers/duplicates"
            className="inline-flex min-h-8 items-center text-muted-foreground hover:text-foreground"
          >
            Duplicates
          </Link>
        </nav>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onExport} disabled={exporting}>
          <Download className="h-4 w-4" />
          {exporting ? "Exporting…" : "Export"}
        </Button>
        <Button variant="outline" asChild>
          <Link href="/app/subscribers/import">
            <Upload className="h-4 w-4" />
            Import
          </Link>
        </Button>
        {canWrite ? (
          <Button
            ref={pasteTriggerRef}
            type="button"
            variant="outline"
            aria-haspopup="dialog"
            aria-expanded={pasteOpen}
            onClick={() => {
              setPasteActivated(true);
              setPasteOpen(true);
            }}
          >
            <ClipboardPaste className="h-4 w-4" />
            Paste emails
          </Button>
        ) : null}
        {canWrite ? (
          <Button
            ref={createTriggerRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => {
              setCreateActivated(true);
              onOpenChange(true);
            }}
          >
            <Plus className="h-4 w-4" />
            New subscriber
          </Button>
        ) : null}
      </div>
      {canWrite && pasteActivated ? (
        <LazyPasteSubscriberEmailsDialog
          open={pasteOpen}
          onOpenChange={setPasteOpen}
          onPaste={onPaste}
          onCloseAutoFocus={() => pasteTriggerRef.current?.focus()}
        />
      ) : null}
      {canWrite && createActivated ? (
        <LazyAddSubscriberDialog
          open={open}
          onOpenChange={onOpenChange}
          canWrite={canWrite}
          authority={authority}
          onCreated={onCreated}
        />
      ) : null}
    </header>
  );
}
