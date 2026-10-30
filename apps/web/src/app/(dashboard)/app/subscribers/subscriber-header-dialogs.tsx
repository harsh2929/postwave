// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BulkPasteResponse, BulkPasteRow } from "@/lib/subscribers-api";
import { describeSubscriberRowError } from "@/lib/subscriber-row-errors";

export function PasteSubscriberEmailsDialog({
  open,
  onOpenChange,
  onPaste,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves with the per-address outcome, or null when nothing was written. */
  onPaste: (emails: string, tags: string[]) => Promise<BulkPasteResponse | null>;
  onCloseAutoFocus?: () => void;
}) {
  const [emails, setEmails] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  // The addresses the last paste could not add, with their reasons. While
  // there are any the dialog stays open and holds only those addresses.
  const [failed, setFailed] = useState<BulkPasteRow[]>([]);
  const [added, setAdded] = useState(0);
  const failuresRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (failed.length > 0) failuresRef.current?.focus();
  }, [failed]);

  const clear = () => {
    setEmails("");
    setTags("");
    setFailed([]);
    setAdded(0);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!emails.trim() || busy) return;
    setBusy(true);
    try {
      const result = await onPaste(
        emails,
        tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      );
      if (!result) return;
      const rejected = result.rows.filter((row) => row.status === "error");
      if (rejected.length === 0) {
        clear();
        onOpenChange(false);
        return;
      }
      setAdded(result.created + result.updated);
      setFailed(rejected);
      setEmails(rejected.map((row) => row.email).join("\n"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing after a partial paste starts the next one fresh; closing
        // before submitting keeps the draft, as it always has.
        if (!next && failed.length > 0) clear();
        onOpenChange(next);
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (!onCloseAutoFocus) return;
          event.preventDefault();
          onCloseAutoFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Paste emails</DialogTitle>
          <DialogDescription>
            Add a bounded list of email addresses and apply the same optional
            tags to each subscriber.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4 py-2" onSubmit={submit}>
          {failed.length > 0 ? (
            <div
              ref={failuresRef}
              role="alert"
              tabIndex={-1}
              aria-labelledby="paste-failures-heading"
              className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <p id="paste-failures-heading" className="font-medium text-destructive-emphasis">
                {failed.length === 1
                  ? "1 address wasn't added"
                  : `${failed.length.toLocaleString()} addresses weren't added`}
              </p>
              <div
                role="region"
                aria-label="Addresses that weren't added"
                tabIndex={0}
                className="max-h-40 overflow-y-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ul className="grid gap-1.5">
                  {failed.map((row) => (
                    <li key={row.email} className="break-words">
                      <span className="font-medium">{row.email}</span>
                      <span className="text-muted-foreground"> — {describeSubscriberRowError(row)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-muted-foreground">
                {added > 0
                  ? `The other ${added.toLocaleString()} ${added === 1 ? "was" : "were"} added. `
                  : ""}
                Only these addresses are left below: fix or remove them, then add again.
              </p>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="paste-emails">
              Emails (one per line or comma-separated)
            </Label>
            <textarea
              id="paste-emails"
              rows={6}
              autoFocus
              value={emails}
              onChange={(event) => setEmails(event.target.value)}
              placeholder={"a@example.com\nb@example.com"}
              aria-invalid={failed.length > 0 || undefined}
              aria-describedby={failed.length > 0 ? "paste-failures-heading" : undefined}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="paste-tags">Tags (optional, comma-separated)</Label>
            <Input
              id="paste-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="newsletter, waitlist"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" type="button">
                {failed.length > 0 ? "Close" : "Cancel"}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !emails.trim()}>
              {busy ? "Adding…" : "Add emails"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
