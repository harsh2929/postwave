// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { createPayout } from "@/lib/affiliates-api";
import type { AffiliatePayout } from "@/lib/affiliates-types";
import { formatCents } from "@/lib/affiliates-types";

export interface PayoutDialogProps {
  affiliateId: string;
  pendingCents: number;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onCreated: (p: AffiliatePayout) => void;
}

/** Retained source prototype only. Active affiliate routes do not mount it,
 * and createPayout fails before transport while settlement is release-held. */
export function PayoutDialog({
  affiliateId,
  pendingCents,
  open,
  onOpenChange,
  onCreated,
}: PayoutDialogProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const belowThreshold = pendingCents < 10_000;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const p = await createPayout(affiliateId);
      onCreated(p);
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "payout failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Initiate payout</DialogTitle>
          <DialogDescription>
            This bundles every approved + pending conversion into a single
            payout, marks them as paid, and creates a payout record. Where the
            affiliate is on Stripe Connect, the transfer fires automatically;
            otherwise the payout is recorded as pending for manual settlement.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-semibold tabular-nums">
              {formatCents(pendingCents)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Per Affiliate ToS §4: minimum payout threshold is $100. Below this
            amount the balance carries over to next month.
          </p>
          {belowThreshold ? (
            <p className="text-xs text-warning-emphasis">
              {formatCents(Math.max(0, 10_000 - pendingCents))} below the $100
              minimum — nothing to pay out yet.
            </p>
          ) : null}
          {err ? (
            <p className="text-xs text-destructive" role="alert">
              {err}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || belowThreshold}>
            {busy ? "Creating…" : "Create payout"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
