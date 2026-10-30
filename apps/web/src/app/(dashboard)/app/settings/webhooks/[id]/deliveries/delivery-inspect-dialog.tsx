// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RelativeTime } from "@/components/relative-time";
import { payloadPreview } from "@/lib/json-preview";
import type { WebhookDeliveryDetail } from "@/lib/webhooks-api";
import type { RefObject } from "react";

function statusVariant(code: number): "default" | "destructive" {
  return code >= 200 && code < 300 ? "default" : "destructive";
}

export function DeliveryInspectDialog({
  open,
  onOpenChange,
  returnFocusRef,
  fallbackFocusRef,
  detail,
  loading,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  detail: WebhookDeliveryDetail | null;
  loading: boolean;
  error: string | null;
}) {
  const returnTarget = (): HTMLElement | null => {
    const preferred = returnFocusRef?.current;
    if (
      preferred?.isConnected &&
      !preferred.matches(":disabled, [aria-disabled='true']")
    ) {
      return preferred;
    }
    const fallback = fallbackFocusRef?.current;
    return fallback?.isConnected ? fallback : null;
  };

  const restoreReturnFocus = () => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active.isConnected &&
      !active.closest('[role="dialog"]')
    ) {
      return;
    }
    returnTarget()?.focus();
  };

  const queueReturnFocus = () => {
    setTimeout(() => {
      restoreReturnFocus();
      requestAnimationFrame(restoreReturnFocus);
    }, 0);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) queueReturnFocus();
      }}
    >
      <DialogContent
        className="max-w-2xl"
        onCloseAutoFocus={(event) => {
          const target = returnTarget();
          if (!target) return;
          event.preventDefault();
          target.focus();
          queueReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Delivery details</DialogTitle>
          <DialogDescription>
            {detail
              ? `${detail.event} · attempt #${detail.attempt}`
              : "The request payload sent to your endpoint."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading delivery…</p>
        ) : error ? (
          <p className="text-sm text-destructive" role="alert">
            Could not load delivery: {error}
          </p>
        ) : detail ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Status</dt>
                <dd className="mt-0.5">
                  <Badge variant={statusVariant(detail.statusCode)}>
                    {detail.statusCode || "ERR"}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Latency</dt>
                <dd className="mt-0.5 tabular-nums">{detail.responseMs} ms</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">At</dt>
                <dd className="mt-0.5 text-xs">
                  <RelativeTime iso={detail.at} />
                </dd>
              </div>
            </dl>

            {detail.error ? (
              <p className="break-all rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive-emphasis">
                {detail.error}
              </p>
            ) : null}

            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Request payload
              </div>
              {detail.payloadRetained ? (
                <pre
                  tabIndex={0}
                  aria-label="Retained webhook request payload"
                  className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {payloadPreview(detail.requestBody)}
                </pre>
              ) : (
                <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                  This delivery pre-dates payload retention, so the request body
                  wasn&apos;t stored.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
