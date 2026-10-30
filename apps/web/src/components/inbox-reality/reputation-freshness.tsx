// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Freshness line + Re-check control for the (server-rendered) reputation card.
 * "Re-check" calls router.refresh(), which re-runs the server component's
 * getReputation() fetch — a real re-measurement without a full page reload
 * (INBOX-010).
 */
export function ReputationFreshness({ checkedAt }: { checkedAt: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
      <span aria-live="polite">
        {checkedAt ? (
          <>
            Measured <RelativeTime iso={checkedAt} />
          </>
        ) : (
          "Freshness unknown"
        )}
      </span>
      <Button
        type="button"
        size="sm"
        className="min-h-11 sm:min-h-8"
        variant="outline"
        disabled={pending}
        aria-busy={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        <RotateCw
          className={cn(
            "h-3.5 w-3.5 motion-reduce:animate-none",
            pending && "animate-spin",
          )}
        />
        {pending ? "Re-checking…" : "Re-check"}
      </Button>
    </div>
  );
}
