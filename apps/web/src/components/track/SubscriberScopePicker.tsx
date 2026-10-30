// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useRef, useState } from "react";
import { useMutation, useQuery, type QueryKey } from "@tanstack/react-query";
import { UserSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import { STALE } from "@/lib/query-keys";
import {
  listRecentTrackSubscribers,
  resolveTrackSubscriberScope,
  type TrackSubscriberScope,
} from "@/lib/track-api";

/**
 * Subscriber scope for the product-event investigation (desktop
 * Track.tsx:293/612/1448-1580 parity): resolve an email or subscriber ID,
 * or pick one of the most recently updated subscribers, then hand the
 * resolved `subscriber_id` to the feed, live tail and export.
 *
 * Deliberately NOT a <form>: the picker is mounted inside the feed's filter
 * form, and a nested form (or an Enter that bubbled to the outer submit)
 * would apply the half-typed event-name draft as a side effect.
 */
export function SubscriberScopePicker({
  queryKeyBase,
  value,
  onChange,
  disabled = false,
}: {
  queryKeyBase: QueryKey;
  value: TrackSubscriberScope | null;
  onChange: (scope: TrackSubscriberScope | null) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const [input, setInput] = useState(value?.label ?? "");
  const [syncedId, setSyncedId] = useState<string | null>(value?.id ?? null);
  // Any change of intent (typing, picking, clearing) supersedes a pending
  // resolution so a slow lookup cannot re-scope the feed after the fact. The
  // ref is read by the mutation callback; the state drives rendering.
  const generationRef = useRef(0);
  const [generation, setGeneration] = useState(0);

  // The scope can be cleared from outside (a scope token); mirror it here.
  const valueId = value?.id ?? null;
  if (valueId !== syncedId) {
    setSyncedId(valueId);
    setInput(value?.label ?? "");
  }

  const recent = useQuery({
    queryKey: [...queryKeyBase, "scope-subscribers", "recent"],
    queryFn: ({ signal }) => listRecentTrackSubscribers(signal),
    staleTime: STALE.list,
  });
  const recentRows = Array.isArray(recent.data) ? recent.data : [];

  const resolve = useMutation({
    mutationFn: ({ text }: { text: string; generation: number }) =>
      resolveTrackSubscriberScope(text),
    onSuccess: (scope, { generation }) => {
      if (generation !== generationRef.current) return;
      onChange(scope);
    },
  });
  const staleError =
    resolve.isError && resolve.variables?.generation !== generation;
  const resolveError =
    resolve.isError && !staleError
      ? apiErrorMessage(
          resolve.error,
          "Moosewave couldn't resolve that subscriber. Check the connection and retry.",
        )
      : null;
  const resolving =
    resolve.isPending && resolve.variables?.generation === generation;

  function supersede(): number {
    const next = generationRef.current + 1;
    generationRef.current = next;
    setGeneration(next);
    return next;
  }

  function submit(): void {
    const text = input.trim();
    if (!text || resolving || disabled) return;
    resolve.mutate({ text, generation: supersede() });
  }

  function changeInput(next: string): void {
    supersede();
    resolve.reset();
    setInput(next);
  }

  function pickRecent(scope: TrackSubscriberScope): void {
    supersede();
    resolve.reset();
    setInput(scope.label);
    onChange(scope);
  }

  function clear(): void {
    supersede();
    resolve.reset();
    setInput("");
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>Subscriber ID or email</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={inputId}
          value={input}
          maxLength={512}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder="subscriber@example.com or subscriber ID"
          aria-invalid={resolveError ? true : undefined}
          aria-describedby={resolveError ? `${helpId} ${errorId}` : helpId}
          onChange={(event) => changeInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || !input.trim()}
          loading={resolving}
          aria-describedby={helpId}
          onClick={submit}
        >
          <UserSearch className="size-4" aria-hidden="true" />
          {resolving ? "Resolving…" : "Load events"}
        </Button>
        {value ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={`Remove the ${value.label} subscriber scope`}
            onClick={clear}
          >
            Clear subscriber
          </Button>
        ) : null}
      </div>
      {resolveError ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {resolveError}
        </p>
      ) : null}
      <p id={helpId} className="text-xs text-muted-foreground">
        {resolving
          ? "Resolving this subscriber."
          : value
            ? `Feed, live tail, and export are scoped to ${value.label}.`
            : "Optional. An email must match a subscriber exactly; anything else is used as the subscriber ID."}
      </p>

      <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer">
          Recent subscribers
          {recentRows.length > 0
            ? ` · ${recentRows.length.toLocaleString()}`
            : ""}
        </summary>
        {recent.isPending ? (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            Loading recent subscribers…
          </p>
        ) : recent.isError ? (
          <div role="alert" className="mt-2 text-xs">
            <p>
              {apiErrorMessage(
                recent.error,
                "Recent subscribers couldn't be loaded.",
              )}{" "}
              You can still enter an ID or email.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void recent.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : recentRows.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No subscribers were returned.
          </p>
        ) : (
          <ul
            className="mt-2 flex flex-wrap gap-2"
            aria-label="Recent subscribers"
          >
            {recentRows.map((subscriber) => (
              <li key={subscriber.id}>
                <Button
                  type="button"
                  size="sm"
                  variant={
                    value?.id === subscriber.id ? "secondary" : "outline"
                  }
                  disabled={disabled}
                  aria-pressed={value?.id === subscriber.id}
                  onClick={() =>
                    pickRecent({ id: subscriber.id, label: subscriber.email })
                  }
                >
                  {subscriber.email}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
