// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_DIRECTORY_VIEW,
  watchSubscriberAdditions,
} from "@/lib/subscriber-directory-api";

import { useDirectoryIdentity, useDirectoryUrlState } from "./directory-context";

/** Desktop buffers at most this many unseen additions. */
const BUFFER_CAP = 1_000;

/**
 * "N joined since this view was opened" — driven by the realtime bus's
 * `subscriber.added` events (create, bulk paste and batch upsert all publish
 * it). Additions are buffered as a count rather than pushed into the rows the
 * operator is reading; "Show newest" flushes them by jumping to the
 * newest-first view and refetching.
 */
export function DirectoryLiveBanner() {
  const identity = useDirectoryIdentity();
  const { applyView } = useDirectoryUrlState();
  const queryClient = useQueryClient();
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const [anonymous, setAnonymous] = useState(0);

  useEffect(() => {
    if (!identity.ready) return;
    setJoined(new Set());
    setAnonymous(0);
    return watchSubscriberAdditions((id) => {
      if (id === null) {
        setAnonymous((current) => Math.min(BUFFER_CAP, current + 1));
        return;
      }
      setJoined((current) => {
        if (current.has(id) || current.size >= BUFFER_CAP) return current;
        const next = new Set(current);
        next.add(id);
        return next;
      });
    });
  }, [identity.ready, identity.tenantId, identity.userId]);

  const count = Math.min(BUFFER_CAP, joined.size + anonymous);
  if (count === 0) return null;
  const clear = () => {
    setJoined(new Set());
    setAnonymous(0);
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
    >
      <Sparkles aria-hidden className="h-4 w-4 text-primary" />
      <span>
        {count >= BUFFER_CAP ? `${BUFFER_CAP.toLocaleString()}+` : count.toLocaleString()}{" "}
        {count === 1 ? "subscriber" : "subscribers"} joined since this view was
        opened.
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="ml-auto"
        onClick={() => {
          applyView({ ...DEFAULT_DIRECTORY_VIEW, sort: "created_at", order: "desc" });
          void queryClient.invalidateQueries({ queryKey: identity.subscribersKey });
          clear();
        }}
      >
        Show newest
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label="Dismiss new-subscriber notice"
        onClick={clear}
      >
        <X aria-hidden className="h-4 w-4" />
      </Button>
    </div>
  );
}
