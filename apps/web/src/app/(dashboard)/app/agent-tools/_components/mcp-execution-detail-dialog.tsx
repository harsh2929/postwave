// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * One recorded execution, opened from a history row.
 *
 * THE ONLY CLIPBOARD ACTION HERE COPIES CONSTANT SHAPE METADATA. Desktop's
 * McpExecutionDetail makes the same choice and it is the load-bearing one:
 * the request body was already reduced to `{_summary, type, key_count,
 * _truncated}` at the response boundary, so "Copy metadata" cannot leak a
 * caller-supplied key name or value even if someone pastes it into a ticket.
 * There is deliberately no replay/curl action — a recorded `dry-run` header is
 * a caller ASSERTION, not proof the endpoint prevented side effects.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Copy } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyToClipboard } from "@/lib/clipboard";
import {
  formatMcpLatency,
  formatMcpMicrosUsd,
  formatMcpTimestamp,
  mcpRequestMetadata,
  mcpStatusTone,
  safeMcpUserAgent,
  type McpExecution,
} from "@/lib/mcp-api";

function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          mono
            ? "mt-0.5 min-w-0 break-all font-mono text-xs leading-5"
            : "mt-0.5 min-w-0 break-words text-sm leading-5"
        }
      >
        {children}
      </dd>
    </div>
  );
}

export function McpExecutionDetailDialog({
  execution,
  onClose,
}: {
  execution: McpExecution | null;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "unavailable" | "error"
  >("idle");

  // A receipt for the previous row must never be read as one for this row.
  useEffect(() => setCopyState("idle"), [execution?.id]);

  if (!execution) return null;

  const metadata = mcpRequestMetadata(execution);

  const copyMetadata = async () => {
    setCopyState("copying");
    const result = await copyToClipboard(metadata.bodyJson);
    setCopyState(
      result === "copied"
        ? "copied"
        : result === "unavailable"
          ? "unavailable"
          : "error",
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Execution {execution.id}</DialogTitle>
          <DialogDescription>
            Recorded telemetry for one API-key call. Raw request values and the
            remote IP were removed before this row entered the page.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="Called at">
            {formatMcpTimestamp(execution.calledAt)}
          </Field>
          <Field label="Status">
            <Badge variant={mcpStatusTone(execution.statusCode)}>
              {execution.statusCode || "Not recorded"}
            </Badge>
          </Field>
          <Field label="Tool identifier" mono>
            {execution.toolName ?? "Not recorded"}
          </Field>
          <Field label="Latency">{formatMcpLatency(execution.latencyMs)}</Field>
          <Field label="Method" mono>
            {execution.method}
          </Field>
          <Field label="Path" mono>
            {execution.path}
          </Field>
          <Field label="Query metadata" mono>
            {metadata.query || "None recorded"}
          </Field>
          <Field label="API key ID" mono>
            {execution.apiKeyId ?? "Not retained"}
          </Field>
          <Field label="API key prefix" mono>
            {execution.apiKeyPrefix ?? "Not retained"}
          </Field>
          <Field label="User agent" mono>
            {execution.userAgent
              ? safeMcpUserAgent(execution.userAgent)
              : "Not recorded"}
          </Field>
          <Field label="Remote IP">Removed before this page retained it</Field>
          <Field label="Recorded cost estimate">
            {formatMcpMicrosUsd(execution.costMicros)}
          </Field>
          {execution.errorCode ? (
            <Field label="Error code" mono>
              {execution.errorCode}
            </Field>
          ) : null}
        </dl>

        {metadata.bodyJson ? (
          <section className="min-w-0 rounded-xl border bg-muted/20 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Request body metadata</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Copy minimized request body metadata"
                loading={copyState === "copying"}
                onClick={() => void copyMetadata()}
              >
                {copyState !== "copying" ? <Copy aria-hidden="true" /> : null}
                {copyState === "copied" ? "Copied" : "Copy metadata"}
              </Button>
            </div>
            <pre
              aria-label="Minimized request body metadata"
              tabIndex={0}
              className="mt-2 min-w-0 overflow-x-auto rounded-lg bg-background p-3 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <code>{metadata.bodyJson}</code>
            </pre>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Only the constant type, key-count and truncation fields remain. At
              least {metadata.redactionCount.toLocaleString()} request metadata
              item{metadata.redactionCount === 1 ? " was" : "s were"} omitted;
              caller-supplied key names and values are not shown.
            </p>
            <p
              role="status"
              className="mt-1 text-xs leading-5 text-muted-foreground"
            >
              {copyState === "copied"
                ? "The minimized metadata was copied."
                : copyState === "unavailable"
                  ? "This browser did not expose a clipboard, so nothing was copied. Select the block above instead."
                  : copyState === "error"
                    ? "The clipboard rejected the write, so nothing was copied. Focus this tab and retry."
                    : "The only clipboard action here copies constant metadata — no captured key names or values."}
            </p>
          </section>
        ) : null}

        <Alert variant="warning">
          <AlertTitle>Replay is not offered</AlertTitle>
          <AlertDescription>
            No command or replay action is mounted. A recorded dry-run header is
            only a caller assertion and does not prove the target endpoint
            prevented mutations or sends.
            {execution.dryRunAsserted
              ? " This call asserted a dry run; treat that as unverified."
              : ""}
          </AlertDescription>
        </Alert>
      </DialogContent>
    </Dialog>
  );
}
