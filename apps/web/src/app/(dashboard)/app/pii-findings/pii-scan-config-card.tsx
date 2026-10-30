// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Radar, RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { setPiiScanEnabled, type PiiScanConfig } from "@/lib/pii-findings-api";
import type { MeResponse } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";

import {
  coverageLimitationLabel,
  describePiiError,
  scanStatusLabel,
} from "./pii-findings-ui";

interface Props {
  identity: MeResponse | null;
  config?: PiiScanConfig;
  error?: unknown;
  loading: boolean;
  refreshing: boolean;
  onRetry: () => void;
  onUpdated: (config: PiiScanConfig) => Promise<void> | void;
}

export function PiiScanConfigCard({
  identity,
  config,
  error,
  loading,
  refreshing,
  onRetry,
  onUpdated,
}: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const lockRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!identity || lockRef.current)
        throw new Error(
          "Owner or admin access is required or another scanner action is running.",
        );
      lockRef.current = true;
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        await verifyFreshAdminAuthority(identity, controller.signal);
        return await setPiiScanEnabled(enabled, {
          signal: controller.signal,
          requireOnline: true,
          maxAttempts: 1,
        });
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        lockRef.current = false;
      }
    },
    onSuccess: async (next) => {
      await onUpdated(next);
      setConfirmOpen(false);
      setAnnouncement(
        next.scan_enabled
          ? "Shadow-PII scanning enabled. Reconciliation status is shown below."
          : "Shadow-PII scanning disabled. Existing findings and coverage evidence were preserved.",
      );
    },
  });
  useEffect(() => () => controllerRef.current?.abort(), []);

  const desired = !(config?.scan_enabled ?? false);
  const mutationFailure = mutation.error
    ? describePiiError(mutation.error)
    : null;

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle as="h2" className="flex items-center gap-2">
            <Radar className="size-5" aria-hidden /> Scanner configuration
          </CardTitle>
          <CardDescription>
            Continuous, database-enforced current-profile scanning. Scheduled
            scans are not offered.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          loading={refreshing}
          aria-label="Refresh scanner configuration"
        >
          <RefreshCw aria-hidden /> Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        {loading ? (
          <div aria-label="Loading scanner configuration" className="space-y-3">
            <Skeleton className="h-8 w-44" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : error ? (
          <ConfigError error={error} onRetry={onRetry} />
        ) : config ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      config.status === "enabled_caught_up"
                        ? "success"
                        : config.status === "enabled_degraded"
                          ? "warning"
                          : "outline"
                    }
                  >
                    {scanStatusLabel(config.status)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    At-least-once processing with a dead-letter queue
                  </span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Turning scanning off stops new work. It does not erase
                  findings, receipts, or known-gap evidence.
                </p>
              </div>
              <Button
                type="button"
                variant={config.scan_enabled ? "outline" : "default"}
                disabled={!config.available || mutation.isPending}
                onClick={() => {
                  mutation.reset();
                  setConfirmOpen(true);
                }}
              >
                {config.scan_enabled ? "Disable scanning" : "Enable scanning"}
              </Button>
            </div>

            <CoverageEvidence config={config} />

            <Alert variant="warning">
              <AlertTriangle aria-hidden />
              <AlertTitle>Coverage boundary</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  {config.coverage_limitations.map((limitation) => (
                    <li key={limitation}>
                      {coverageLimitationLabel(limitation)}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          </>
        ) : null}
      </CardContent>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!mutation.isPending) setConfirmOpen(open);
        }}
      >
        <DialogContent closeDisabled={mutation.isPending}>
          <DialogHeader>
            <DialogTitle>
              {desired
                ? "Enable Shadow-PII scanning?"
                : "Disable Shadow-PII scanning?"}
            </DialogTitle>
            <DialogDescription>
              {desired
                ? "This opts the workspace into continuous current-profile scanning and starts a bounded reconciliation generation. It does not scan retained history, notes, attachments, or event/content payloads."
                : "New scan work will stop. Existing findings, immutable review receipts, and coverage-gap evidence remain available."}
            </DialogDescription>
          </DialogHeader>
          {mutationFailure ? (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden />
              <AlertTitle>{mutationFailure.title}</AlertTitle>
              <AlertDescription>{mutationFailure.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={desired ? "default" : "destructive"}
              loading={mutation.isPending}
              onClick={() => mutation.mutate(desired)}
            >
              {desired ? "Enable scanning" : "Disable scanning"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ConfigError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const failure = describePiiError(error);
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden />
      <AlertTitle>{failure.title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{failure.message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry configuration
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function CoverageEvidence({ config }: { config: PiiScanConfig }) {
  const evidence = config.coverage_evidence;
  const gaps =
    evidence.pending_subscribers +
    evidence.retrying_subscribers +
    evidence.dead_letter_subscribers +
    evidence.truncated_subscribers +
    evidence.missing_state_subscribers;
  return (
    <div
      className="space-y-3 rounded-lg border p-4"
      aria-label="Coverage evidence"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Current-profile coverage</h3>
          <p className="text-xs text-muted-foreground">
            Generation {evidence.generation.toLocaleString()} ·{" "}
            {evidence.status.replaceAll("_", " ")}
          </p>
        </div>
        <Badge
          variant={
            evidence.snapshot_exact && gaps === 0 ? "success" : "warning"
          }
        >
          {evidence.snapshot_exact && gaps === 0 ? (
            <>
              <CheckCircle2 aria-hidden /> Exact snapshot
            </>
          ) : (
            "Progress telemetry only"
          )}
        </Badge>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric label="Covered" value={evidence.covered_subscribers} />
        <Metric label="Total" value={evidence.total_subscribers} />
        <Metric
          label="Pending / retrying"
          value={evidence.pending_subscribers + evidence.retrying_subscribers}
        />
        <Metric
          label="Known gaps"
          value={
            evidence.dead_letter_subscribers +
            evidence.truncated_subscribers +
            evidence.missing_state_subscribers
          }
        />
      </dl>
      <p className="text-xs leading-5 text-muted-foreground">
        “Exact” covers the current subscribers-row projection only. It is not a
        certification of retained history or other payload stores.
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value.toLocaleString()}</dd>
    </div>
  );
}
