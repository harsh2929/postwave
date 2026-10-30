// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState, type RefObject } from "react";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import type {
  PushSuppressionRegistryLockedReason,
  PushSuppressionRegistryRow,
} from "@/lib/consent-evidence-api";

export function pushPlatformLabel(
  platform: PushSuppressionRegistryRow["platform"],
): string {
  if (platform === "apns") return "APNs";
  if (platform === "fcm") return "FCM";
  return "Web push";
}

export function pushSourceLabel(
  source: PushSuppressionRegistryRow["source"],
): string {
  switch (source) {
    case "dashboard":
      return "Dashboard";
    case "provider":
      return "Provider feedback";
    case "user":
      return "User opt-out";
    case "complaint":
      return "Complaint";
    default:
      return "Legacy import";
  }
}

export function pushLockedReasonLabel(
  reason: PushSuppressionRegistryLockedReason,
): string {
  switch (reason) {
    case "provider_authority":
      return "Locked by provider authority";
    case "user_opt_out_authority":
      return "Locked by user opt-out authority";
    case "complaint_authority":
      return "Locked by complaint authority";
    default:
      return "Legacy authority requires review";
  }
}

export function pushAuthorityLabel(row: PushSuppressionRegistryRow): string {
  return row.reversible
    ? "Manual dashboard authority"
    : (row.lockedReason ?? "locked authority").replaceAll("_", " ");
}

/**
 * Per-row detail for a customer push suppression (desktop parity with
 * PushSuppressionDetail). Only the privacy-safe fingerprint exists on the
 * client, so copying it is the one clipboard verb offered; the outcome is
 * announced in a live region rather than assumed.
 */
export function PushSuppressionDetailDialog({
  row,
  returnFocusRef,
  onClose,
}: {
  row: PushSuppressionRegistryRow;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => setCopyStatus(""), [row.id]);

  const copyFingerprint = async (): Promise<void> => {
    const clipboard =
      typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setCopyStatus("Clipboard is unavailable in this browser.");
      return;
    }
    try {
      await clipboard.writeText(row.fingerprint);
      setCopyStatus("Fingerprint copied.");
    } catch {
      setCopyStatus("Could not copy the fingerprint.");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="sm:max-w-lg [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-base">
            <bdi dir="ltr">{row.fingerprint}</bdi>
          </DialogTitle>
          <DialogDescription>
            Privacy-safe fingerprint; the raw device token is not available.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyFingerprint()}
          >
            <Copy className="h-4 w-4" />
            Copy fingerprint
          </Button>
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {copyStatus}
          </p>
        </div>

        <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
          <Fact label="Platform">{pushPlatformLabel(row.platform)}</Fact>
          <Fact label="Reason">{row.reason.replaceAll("_", " ")}</Fact>
          <Fact label="Source">{pushSourceLabel(row.source)}</Fact>
          <Fact label="Authority">
            <span className="capitalize">{pushAuthorityLabel(row)}</span>
          </Fact>
          <Fact label="Created">
            <time dateTime={row.createdAt}>
              {formatWireTimestamp(row.createdAt, "Unknown")}
            </time>
          </Fact>
          <Fact label="Updated">
            <time dateTime={row.updatedAt}>
              {formatWireTimestamp(row.updatedAt, "Unknown")}
            </time>
          </Fact>
          <Fact label="CAS version">
            <span className="tabular-nums">{row.version}</span>
          </Fact>
          <Fact label="Removal">
            {row.reversible
              ? "Reversible"
              : row.lockedReason
                ? pushLockedReasonLabel(row.lockedReason)
                : "Locked"}
          </Fact>
        </dl>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}
