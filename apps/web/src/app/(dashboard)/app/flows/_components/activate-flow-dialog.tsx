// SPDX-License-Identifier: AGPL-3.0-only
//
// Retained source boundary for older imports. The active editor does not mount
// this dialog while the flow runtime is structurally release-held. If an older
// caller renders it, it remains informational and cannot invoke a mutation.
"use client";

import type { ReactNode } from "react";

import type { CatalogItem, FlowGraph, ReEnrollment } from "@/lib/flows-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ActivateFlowDialog({
  trigger,
}: {
  trigger: ReactNode;
  graph: FlowGraph;
  triggerCatalog: CatalogItem[];
  nodeCatalog: CatalogItem[];
  reEnrollment: ReEnrollment;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flow activation is release-held</DialogTitle>
          <DialogDescription>
            This build can save and validate drafts, but it cannot start live
            enrollment, scheduling, email, or SMS delivery. No activation
            request is available from this dialog.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
