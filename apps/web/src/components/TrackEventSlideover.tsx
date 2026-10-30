// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import {
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import type { TrackEvent } from "@/lib/track-api";
import {
  canAutomateTrackEvent,
  createTrackEventSequenceDraft,
  isUncertainTrackSequenceFailure,
} from "@/lib/track-sequences-api";
import { useOnline } from "@/lib/use-online";

/**
 * Product-event evidence plus the automation handoff (desktop
 * components/TrackEventSlideover.tsx parity): one raw event's details and a
 * "Create sequence draft" action that stores an INACTIVE sequence whose
 * trigger condition is this event name. Campaign-write roles only, checked
 * against a fresh identity read before the request is sent.
 */
export function TrackEventSlideover({
  event,
  identity,
  onClose,
}: {
  event: TrackEvent | null;
  identity: MeResponse;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={event !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl" closeDisabled={busy}>
        {event ? (
          <TrackEventEvidence
            key={event.id}
            event={event}
            identity={identity}
            onBusyChange={setBusy}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TrackEventEvidence({
  event,
  identity,
  onBusyChange,
  onClose,
}: {
  event: TrackEvent;
  identity: MeResponse;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const statusId = useId();
  const online = useOnline();
  const canWrite = canWriteCampaigns(identity);
  const canAutomate = canAutomateTrackEvent(event.eventName);
  // Set immediately before the create request leaves the browser, so a
  // failure in the fresh-authority read is known to have changed nothing.
  const requestSentRef = useRef(false);
  const [retryBlocked, setRetryBlocked] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      requestSentRef.current = false;
      await confirmFreshCampaignWriteAuthority(identity);
      requestSentRef.current = true;
      return createTrackEventSequenceDraft({ eventName: event.eventName });
    },
    onMutate: () => onBusyChange(true),
    onError: (error) => {
      if (requestSentRef.current && isUncertainTrackSequenceFailure(error)) {
        setRetryBlocked(true);
      }
    },
    onSettled: () => onBusyChange(false),
  });

  const unavailable =
    create.isPending ||
    create.isSuccess ||
    retryBlocked ||
    !canWrite ||
    !canAutomate ||
    online === "offline";
  const reason = create.isPending
    ? "Creating the inactive sequence draft…"
    : create.isSuccess
      ? `Sequence draft ${create.data.id} created with a ${event.eventName} product-event condition. Nothing is active or sending.`
      : retryBlocked
        ? `${apiErrorMessage(create.error, "The sequence request couldn't be confirmed.")} Retry is withheld to prevent a duplicate draft.`
        : !canWrite
          ? "Campaign-write access (owner, admin, or editor outside viewer mode) is required to create a sequence draft."
          : !canAutomate
            ? "This event has no valid event name, so an automation trigger cannot be created."
            : online === "offline"
              ? "Reconnect before creating a sequence draft; the request is never queued offline."
              : "Creates one inactive sequence draft whose trigger condition is this event name. Nothing is activated or sent.";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Product event details</DialogTitle>
        <DialogDescription>
          Subscriber-linked raw telemetry from the current workspace.
        </DialogDescription>
      </DialogHeader>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Event ID</dt>
          <dd className="mt-1 font-mono">{event.id}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Event name</dt>
          <dd className="mt-1 break-all font-mono">{event.eventName}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Subscriber ID</dt>
          <dd className="mt-1 break-all font-mono">{event.subscriberId}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Occurred</dt>
          <dd className="mt-1">
            {formatWireTimestamp(event.occurredAt, "Unknown")}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Received</dt>
          <dd className="mt-1">
            {formatWireTimestamp(event.receivedAt, "Unknown")}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Properties</dt>
          <dd>
            <p className="mt-1 text-xs text-muted-foreground">
              Raw workspace evidence may contain personal data. Share and retain
              it according to your organization&apos;s data policy.
            </p>
            <pre
              tabIndex={0}
              aria-label="Event properties"
              className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/20 p-3 text-xs"
            >
              {JSON.stringify(event.properties, null, 2)}
            </pre>
          </dd>
        </div>
      </dl>

      <section className="space-y-2 rounded-lg border p-3">
        <h3 className="text-sm font-medium">Automate this event</h3>
        <p
          id={statusId}
          role={create.isError ? "alert" : "status"}
          aria-live="polite"
          className={
            create.isError && !retryBlocked
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {create.isError && !retryBlocked
            ? apiErrorMessage(
                create.error,
                "The sequence draft couldn't be created.",
              )
            : reason}
        </p>
        {create.isSuccess ? (
          <Link
            href={`/app/sequences/${encodeURIComponent(create.data.id)}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Open sequence draft
          </Link>
        ) : retryBlocked ? (
          <Link
            href="/app/sequences"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Open Sequences to verify
          </Link>
        ) : null}
      </section>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={create.isPending}
          onClick={onClose}
        >
          Close
        </Button>
        <Button
          type="button"
          disabled={unavailable}
          loading={create.isPending}
          aria-describedby={statusId}
          onClick={() => {
            if (!unavailable) create.mutate();
          }}
        >
          <Workflow className="size-4" aria-hidden="true" />
          {create.isPending ? "Creating draft…" : "Create sequence draft"}
        </Button>
      </DialogFooter>
    </>
  );
}
