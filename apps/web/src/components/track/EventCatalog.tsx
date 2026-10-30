// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Filter, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import type { TrackCatalogItem } from "@/lib/track-api";
import { cn } from "@/lib/utils";

/**
 * Event catalogue rows with an explicit Filter action (desktop
 * components/track/EventCatalog.tsx parity). Picking a row scopes the feed,
 * live tail and export to that event name; picking it again — or the
 * "Showing only" control — clears the scope.
 */
export function EventCatalog({
  items,
  selectedEvent,
  onPick,
  disabled = false,
}: {
  items: readonly TrackCatalogItem[];
  selectedEvent: string;
  onPick: (eventName: string) => void;
  disabled?: boolean;
}) {
  const rows = Array.isArray(items) ? items : [];
  return (
    <div className="mt-2 space-y-2">
      {selectedEvent ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-label={`Show all event names instead of only ${selectedEvent}`}
          onClick={() => onPick(selectedEvent)}
        >
          Showing only:{" "}
          <code className="break-all text-xs">{selectedEvent}</code>
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
      <ul className="divide-y rounded-xl border" aria-label="Event catalogue">
        {rows.map((item) => {
          const selected = selectedEvent === item.eventName;
          return (
            <li
              key={item.eventName}
              className={cn(
                "grid min-w-0 gap-2 p-3.5 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center sm:gap-4",
                selected && "bg-accent/40",
              )}
            >
              <div className="min-w-0">
                <code className="break-all text-xs">{item.eventName}</code>
                <p className="mt-1 text-xs text-muted-foreground">
                  First {formatWireTimestamp(item.firstSeen, "unknown")} · last{" "}
                  {formatWireTimestamp(item.lastSeen, "unknown")}
                </p>
              </div>
              <Badge className="w-fit" variant="secondary">
                {item.count.toLocaleString()} events
              </Badge>
              <Badge className="w-fit" variant="outline">
                {item.uniqueSubscribers.toLocaleString()} subscribers
              </Badge>
              <Button
                type="button"
                size="sm"
                variant={selected ? "secondary" : "ghost"}
                className="w-fit"
                disabled={disabled}
                aria-pressed={selected}
                aria-label={
                  selected
                    ? `Remove the ${item.eventName} event filter`
                    : `Filter events to ${item.eventName}`
                }
                onClick={() => onPick(item.eventName)}
              >
                <Filter className="size-3.5" aria-hidden="true" />
                {selected ? "Selected" : "Filter"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The feed's event-name cell as a scope toggle (desktop Track.tsx:1028-1032):
 * the event name itself is the button, so an operator scopes the feed from
 * the row they are reading.
 */
export function EventNameFilterButton({
  eventName,
  selectedEvent,
  onPick,
  disabled = false,
}: {
  eventName: string;
  selectedEvent: string;
  onPick: (eventName: string) => void;
  disabled?: boolean;
}) {
  const selected = selectedEvent === eventName;
  return (
    <Button
      type="button"
      size="sm"
      variant={selected ? "secondary" : "ghost"}
      className="h-auto max-w-full justify-start px-2 py-1 text-left"
      disabled={disabled}
      aria-pressed={selected}
      aria-label={
        selected
          ? `Clear the ${eventName} event filter`
          : `Filter events to ${eventName}`
      }
      onClick={() => onPick(eventName)}
    >
      <code className="break-all text-xs">{eventName}</code>
    </Button>
  );
}
