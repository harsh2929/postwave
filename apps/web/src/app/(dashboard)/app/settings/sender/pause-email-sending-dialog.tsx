// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { RefObject } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// The pause dialog only opens from the sending-safety card's kill switch, so
// the sender settings page loads this module on demand (bundle budget).
export function PauseEmailSendingDialog({
  canWrite,
  onConfirm,
  onOpenChange,
  onReasonChange,
  open,
  reason,
  returnFocusRef,
  savingControl,
}: {
  canWrite: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onReasonChange: (reason: string) => void;
  open: boolean;
  reason: string;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  savingControl: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-busy={savingControl || undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const restore = () => {
            const target = returnFocusRef?.current;
            if (!target?.isConnected || target.disabled) return;
            const active = document.activeElement;
            const activeElsewhere =
              active instanceof HTMLElement &&
              active !== document.body &&
              active !== target &&
              active.isConnected &&
              !active.closest('[role="dialog"]');
            if (!activeElsewhere) target.focus();
          };
          restore();
          setTimeout(() => {
            let framesRemaining = 2;
            const restoreThroughExit = () => {
              restore();
              if (framesRemaining > 0) {
                framesRemaining -= 1;
                requestAnimationFrame(restoreThroughExit);
              }
            };
            restoreThroughExit();
          }, 0);
        }}
      >
        <DialogHeader>
          <DialogTitle>Pause email sending</DialogTitle>
          <DialogDescription>
            This flips the global kill switch: test sends, immediate sends,
            scheduled dispatch, queue sends, and queued-recipient drain will all
            be blocked until you resume.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="pause-reason">Reason for pausing</Label>
          <Textarea
            id="pause-reason"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Pilot safety pause"
            disabled={savingControl || !canWrite}
          />
          {!canWrite ? (
            <p className="text-xs text-muted-foreground">
              Email safety controls are read-only for your role.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={savingControl}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            loading={savingControl}
            disabled={savingControl || !canWrite}
          >
            {savingControl ? "Pausing..." : "Pause sends"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
