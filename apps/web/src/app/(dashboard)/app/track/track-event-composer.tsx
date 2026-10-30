// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import {
  parseTrackPropertiesJson,
  sendSyntheticTrackEvent,
  validateSyntheticTrackEvent,
  type SyntheticTrackEventReceipt,
} from "@/lib/track-api";
import { roleCanWrite } from "@/lib/use-admin-gate";

const LIVE_CONFIRMATION = "SEND LIVE EVENT";

interface Attempt {
  fingerprint: string;
  eventId: string;
}

export function TrackEventComposer({
  identity,
  initialEventName,
  onSent,
}: {
  identity: MeResponse;
  initialEventName?: string;
  onSent: () => void;
}) {
  const canSend =
    !identity.viewer_mode && roleCanWrite(effectiveAuthRole(identity));
  const [open, setOpen] = useState(false);
  const [subscriberId, setSubscriberId] = useState("");
  const [eventName, setEventName] = useState(initialEventName ?? "");
  const [propertiesRaw, setPropertiesRaw] = useState(
    '{\n  "source": "postwave_console"\n}',
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [receipt, setReceipt] = useState<SyntheticTrackEventReceipt | null>(
    null,
  );
  const attemptRef = useRef<Attempt | null>(null);

  const draftError = useMemo(() => {
    try {
      const properties = parseTrackPropertiesJson(propertiesRaw);
      validateSyntheticTrackEvent({
        subscriberId,
        eventName,
        properties,
        eventId: attemptRef.current?.eventId ?? "pending-id",
      });
      return null;
    } catch (error) {
      return apiErrorMessage(error, "The event draft is invalid.");
    }
  }, [eventName, propertiesRaw, subscriberId]);

  const send = useMutation({
    mutationKey: ["track", identity.tenant_id, "synthetic-event"],
    mutationFn: async () => {
      const properties = parseTrackPropertiesJson(propertiesRaw);
      const fingerprint = JSON.stringify([
        subscriberId.trim(),
        eventName.trim(),
        properties,
      ]);
      if (attemptRef.current?.fingerprint !== fingerprint) {
        attemptRef.current = { fingerprint, eventId: newUUIDv7() };
      }
      const attempt = attemptRef.current;
      if (!attempt) throw new Error("Could not establish a stable event ID.");
      const fresh = await whoamiFresh();
      if (
        fresh.tenant_id !== identity.tenant_id ||
        fresh.user_id !== identity.user_id
      ) {
        throw new Error(
          "Workspace identity changed. Reload before sending a live event.",
        );
      }
      if (fresh.viewer_mode || !roleCanWrite(effectiveAuthRole(fresh))) {
        throw new Error("An owner or admin role is required.");
      }
      return sendSyntheticTrackEvent({
        subscriberId,
        eventName,
        properties,
        eventId: attempt.eventId,
      });
    },
    onSuccess: (next) => {
      // A definitive receipt closes this semantic attempt. Uncertain failures
      // retain the ID above for safe retry; a later, explicitly reconfirmed
      // submission of the same draft must mint a new ID so it is a deliberate
      // second event rather than an idempotent replay of the first one.
      attemptRef.current = null;
      setReceipt(next);
      setAcknowledged(false);
      setConfirmation("");
      onSent();
    },
  });

  const dirty =
    subscriberId.trim().length > 0 ||
    eventName.trim().length > 0 ||
    propertiesRaw !== '{\n  "source": "postwave_console"\n}';
  const ready =
    canSend &&
    !draftError &&
    acknowledged &&
    confirmation === LIVE_CONFIRMATION &&
    !send.isPending;

  function updateDraft(setter: () => void): void {
    setter();
    setReceipt(null);
    send.reset();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="secondary" disabled={!canSend}>
          <Send className="size-4" aria-hidden="true" />
          Send live event
        </Button>
      </DialogTrigger>
      <DialogContent closeDisabled={send.isPending} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send a live product event</DialogTitle>
          <DialogDescription>
            This writes to the current workspace. It is not a sandbox or a
            delivery-only test.
          </DialogDescription>
        </DialogHeader>

        <div
          role="note"
          className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm leading-6"
        >
          <strong>This is a live workspace write.</strong> A matching event can
          start automations and flows, and order-shaped properties can affect
          revenue attribution. Use a synthetic subscriber in a disposable
          workspace when testing.
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="track-composer-subscriber">Subscriber ID</Label>
            <Input
              id="track-composer-subscriber"
              value={subscriberId}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              disabled={send.isPending}
              placeholder="Stable subscriber UUID"
              onChange={(event) =>
                updateDraft(() => setSubscriberId(event.target.value))
              }
            />
            <p className="text-xs text-muted-foreground">
              The console deliberately accepts an ID, not an email address, to
              keep extra PII out of browser draft state.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="track-composer-name">Event name</Label>
            <Input
              id="track-composer-name"
              value={eventName}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              disabled={send.isPending}
              placeholder="checkout_started"
              onChange={(event) =>
                updateDraft(() => setEventName(event.target.value))
              }
            />
            <p className="text-xs text-muted-foreground">
              Lowercase snake_case segments; dots may separate namespaces.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="track-composer-properties">Properties JSON</Label>
          <Textarea
            id="track-composer-properties"
            className="min-h-44 font-mono text-xs"
            value={propertiesRaw}
            maxLength={65_536}
            spellCheck={false}
            disabled={send.isPending}
            aria-invalid={draftError ? true : undefined}
            onChange={(event) =>
              updateDraft(() => setPropertiesRaw(event.target.value))
            }
          />
          <p className="text-xs text-muted-foreground">
            Object only, 64 KiB maximum, with bounded depth and no prototype
            mutation keys.
          </p>
        </div>

        {draftError && dirty ? (
          <p role="alert" className="text-sm text-destructive">
            {draftError}
          </p>
        ) : null}

        <label className="flex items-start gap-3 rounded-lg border p-3 text-sm leading-6">
          <Checkbox
            checked={acknowledged}
            disabled={send.isPending}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            I understand this event is persisted and may trigger live downstream
            behavior.
          </span>
        </label>

        <div className="space-y-2">
          <Label htmlFor="track-composer-confirm">
            Type {LIVE_CONFIRMATION} to confirm
          </Label>
          <Input
            id="track-composer-confirm"
            value={confirmation}
            autoComplete="off"
            spellCheck={false}
            disabled={send.isPending}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>

        {send.isError ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm leading-6 text-destructive-emphasis"
          >
            {apiErrorMessage(send.error, "The live event could not be sent.")}{" "}
            The draft and stable event ID were retained; retrying this unchanged
            draft reuses that ID to prevent a duplicate.
          </div>
        ) : null}

        {receipt ? (
          <div role="status" className="rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">Accepted</Badge>
              <span>
                Event {receipt.id.toLocaleString()} was accepted for subscriber{" "}
                <code className="break-all">{receipt.subscriberId}</code>.
              </span>
            </div>
            <p className="mt-2 break-all text-xs text-muted-foreground">
              Stable event ID: {receipt.eventId}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              This attempt is closed. Re-acknowledging and confirming the
              unchanged draft sends another event with a new stable event ID.
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={send.isPending}
            onClick={() => setOpen(false)}
          >
            {dirty && !receipt ? "Close and retain draft" : "Close"}
          </Button>
          <Button
            type="button"
            disabled={!ready}
            loading={send.isPending}
            onClick={() => send.mutate()}
          >
            {receipt ? "Send another identical event" : "Send live event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
