// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { X } from "lucide-react";

import type { TrackSubscriberScope } from "@/lib/track-api";

const TOKEN =
  "inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border px-3 py-1 text-xs";

/**
 * The active investigation scope as tokens (desktop Track.tsx:1380-1420).
 * Event-name and subscriber scopes are removable; the workspace and range
 * tokens are informational. A polite live region restates the whole scope
 * so a screen-reader user hears what the feed, live tail and export cover.
 */
export function TrackScopeTokens({
  rangeLabel,
  eventName,
  subscriber,
  onClearEventName,
  onClearSubscriber,
  disabled = false,
}: {
  rangeLabel: string;
  eventName: string;
  subscriber: TrackSubscriberScope | null;
  onClearEventName: () => void;
  onClearSubscriber: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div
        role="group"
        aria-label="Active product event investigation scope"
        className="flex flex-wrap items-center gap-2"
      >
        <span className="text-xs font-medium text-muted-foreground">
          Active
        </span>
        <span className={`${TOKEN} bg-muted/40`}>Workspace</span>
        <span className={TOKEN}>{rangeLabel}</span>
        {eventName ? (
          <button
            type="button"
            className={`${TOKEN} bg-accent/40 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={disabled}
            aria-label={`Remove the ${eventName} event-name scope`}
            onClick={onClearEventName}
          >
            Event: <code className="break-all">{eventName}</code>
            <X className="size-3" aria-hidden="true" />
          </button>
        ) : (
          <span className={TOKEN}>All event names</span>
        )}
        {subscriber ? (
          <button
            type="button"
            className={`${TOKEN} bg-accent/40 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={disabled}
            aria-label={`Remove the ${subscriber.label} subscriber scope`}
            onClick={onClearSubscriber}
          >
            Subscriber: <span className="break-all">{subscriber.label}</span>
            <X className="size-3" aria-hidden="true" />
          </button>
        ) : (
          <span className={TOKEN}>All subscribers</span>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        Active scope: workspace, {rangeLabel},{" "}
        {eventName ? `event ${eventName}` : "all event names"},{" "}
        {subscriber ? `subscriber ${subscriber.label}` : "all subscribers"}.
      </span>
    </div>
  );
}
