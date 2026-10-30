// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import { apiErrorMessage, isApiError } from "@/lib/api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  setSubscriberInactiveStatus,
  type Subscriber,
  type SubscriberStatus,
} from "@/lib/subscriber-directory-api";
import { suppressSubscriber } from "@/lib/subscribers-api";

import { EnableWithEvidenceDialog, canReviewEnable } from "./EnableWithEvidenceDialog";

export const STATUS_LABELS: Record<SubscriberStatus, string> = {
  enabled: "Subscribed",
  blocklisted: "Unsubscribed",
  disabled: "Disabled",
  unconfirmed: "Unconfirmed",
};

function statusVariant(status: SubscriberStatus) {
  return status === "enabled"
    ? "success"
    : status === "blocklisted"
      ? "destructive"
      : status === "unconfirmed"
        ? "secondary"
        : "outline";
}

function statusError(error: unknown): string {
  if (isApiError(error) && (error.status === 412 || error.status === 428))
    return "This subscriber changed since the list loaded. Refresh before changing its status.";
  return apiErrorMessage(error, "Could not change the status.");
}

/**
 * Change a row's status in place. Disabled / Unconfirmed are a versioned
 * PATCH; Unsubscribed goes through the canonical suppress path (confirmed,
 * because only an admin can lift a suppression); Subscribed never PATCHes
 * directly — it opens the consent-evidence review.
 */
export function InlineStatusChange({
  subscriber,
  canWrite,
  authority,
  onChanged,
}: {
  subscriber: Subscriber;
  canWrite: boolean;
  authority?: SubscriberAuthority | null;
  onChanged: (updated: Subscriber) => void;
}) {
  const [pending, setPending] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmSuppress, setConfirmSuppress] = useState(false);
  const status = subscriber.status;

  if (!canWrite || !subscriber.id) {
    return <Badge variant={statusVariant(status)}>{STATUS_LABELS[status] ?? status}</Badge>;
  }

  const setInactive = async (next: "disabled" | "unconfirmed") => {
    setPending(true);
    try {
      if (authority) await reauthorizeSubscriberMutation(authority);
      const updated = await setSubscriberInactiveStatus(subscriber, next);
      onChanged(updated);
      toast.success(`${subscriber.email} is now ${STATUS_LABELS[next].toLowerCase()}.`);
    } catch (error) {
      toast.error(statusError(error));
    } finally {
      setPending(false);
    }
  };

  const suppress = async () => {
    const id = subscriber.id;
    if (!id) return;
    try {
      if (authority) await reauthorizeSubscriberMutation(authority);
      await suppressSubscriber(id, {
        expectedVersion: subscriber.version,
        idempotencyKey: `subscriber-directory:suppress:${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
      });
      onChanged({ ...subscriber, status: "blocklisted" });
      toast.success(`${subscriber.email} is unsubscribed.`);
    } catch (error) {
      toast.error(statusError(error));
      throw error;
    }
  };

  const options: SubscriberStatus[] = ["enabled", "unconfirmed", "disabled", "blocklisted"];

  return (
    <>
      <Select
        aria-label={`Status for ${subscriber.email}`}
        value={status}
        disabled={pending}
        className="h-8 w-36 text-xs"
        onChange={(event) => {
          const next = event.target.value as SubscriberStatus;
          if (next === status) return;
          if (next === "enabled") {
            if (canReviewEnable(subscriber)) setReviewOpen(true);
            else toast.error("Archived subscribers cannot be enabled. Restore it first.");
          } else if (next === "blocklisted") {
            setConfirmSuppress(true);
          } else {
            void setInactive(next);
          }
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option === "enabled" && status !== "enabled"
              ? "Subscribed (review consent…)"
              : STATUS_LABELS[option]}
          </option>
        ))}
      </Select>
      <EnableWithEvidenceDialog
        subscriber={subscriber}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        authority={authority}
        onEnabled={onChanged}
      />
      <ConfirmDialog
        open={confirmSuppress}
        onOpenChange={setConfirmSuppress}
        title={`Unsubscribe ${subscriber.email}?`}
        description="The address is suppressed and excluded from every future send. Only a workspace admin can lift a suppression, and re-subscribing needs reviewed consent evidence."
        confirmLabel="Unsubscribe"
        confirmVariant="destructive"
        onConfirm={suppress}
      />
    </>
  );
}
