// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Client island for the /offline page (AUTH-016). The page itself is a static
 * server component; this listens to the browser online/offline events, surfaces
 * a "back online" state, and offers a reload that only makes sense once
 * connectivity returns. It also tells the user, honestly, that the page's
 * primary navigation buttons will only work once they reconnect — rather than
 * letting those links fail silently while still offline.
 *
 * Hydration-safe: renders nothing until mounted, so the server (which cannot
 * know navigator.onLine) and the first client render agree.
 */
export function OfflineStatus() {
  const [mounted, setMounted] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setMounted(true);
    const sync = () =>
      setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const recheck = useCallback(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
  }, []);

  const reload = useCallback(() => {
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  if (!mounted) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "mt-6 rounded-xl border p-4",
        online
          ? "border-success/40 bg-success-subtle"
          : "border-warning-emphasis/40 bg-warning-subtle",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "inline-block size-2.5 shrink-0 rounded-full",
            online ? "bg-success" : "bg-warning-emphasis",
          )}
        />
        <p
          className={cn(
            "text-sm font-medium",
            online ? "text-success" : "text-warning-emphasis",
          )}
        >
          {online ? "You're back online." : "You're still offline."}
        </p>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {online
          ? "Connection restored — reload to pick up where you left off."
          : "Cached pages may still open. Reconnect before making changes that need the server."}
      </p>
      <div className="mt-3">
        {online ? (
          <Button type="button" size="sm" onClick={reload} className="min-h-11">
            Reload the page
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={recheck}
            className="min-h-11"
          >
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
