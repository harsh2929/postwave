// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Presentational halves of the webhook simulator: the reconciliation notice
 * that fences an unresolved fire, and the response inspector for a resolved
 * one. Port of desktop's FireReconciliationNotice + ResponseInspector
 * (pages/webhook-simulator-surface.tsx).
 */
import { useId } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type {
  PlaygroundFireReceipt,
  PlaygroundFireRequest,
  PlaygroundFireResponse,
} from "@/lib/developer-reference-api";

export type FireReconciliationPhase =
  /** No trustworthy outcome yet: check the server receipt. */
  | "unknown"
  /** The receipt lookup 404'd: continue ONLY with this same identity. */
  | "not_registered"
  /** The server reserved the fire; no terminal outcome recorded yet. */
  | "pending"
  /** The server retained a terminal response: restore it (no receiver call). */
  | "recoverable"
  /** Transport-ambiguous: a human must check the receiver. */
  | "ambiguous"
  /** The identity is permanently consumed; only the local checkpoint remains. */
  | "receipt_expired"
  /** The outcome is known but the local checkpoint could not be removed. */
  | "checkpoint_cleanup";

export interface FireReconciliation {
  request: PlaygroundFireRequest;
  targetLabel: string;
  phase: FireReconciliationPhase;
  detail: string;
  receipt: PlaygroundFireReceipt | null;
}

export interface ShownResponse {
  data: PlaygroundFireResponse;
  request: PlaygroundFireRequest;
  targetLabel: string;
}

export function FireReconciliationNotice({
  reconciliation,
  acknowledged,
  busy,
  checking,
  onCheck,
  onRecover,
  onSettle,
  onAcknowledgedChange,
  onRelease,
}: {
  reconciliation: FireReconciliation;
  acknowledged: boolean;
  busy: boolean;
  checking: boolean;
  onCheck: () => void;
  onRecover: () => void;
  onSettle: () => void;
  onAcknowledgedChange: (checked: boolean) => void;
  onRelease: () => void;
}) {
  const ackId = useId();
  const { phase } = reconciliation;
  const danger =
    phase === "ambiguous" ||
    phase === "receipt_expired" ||
    phase === "checkpoint_cleanup";
  const title =
    phase === "checkpoint_cleanup"
      ? "The local recovery checkpoint could not be cleared."
      : phase === "receipt_expired"
        ? "Private receipt details have expired."
        : phase === "ambiguous"
          ? "Receiver outcome needs human verification."
          : "This logical fire is awaiting reconciliation.";

  const action =
    phase === "checkpoint_cleanup" || phase === "receipt_expired" ? (
      <Button type="button" size="sm" disabled={busy} onClick={onSettle}>
        {phase === "receipt_expired"
          ? "Clear local recovery checkpoint"
          : "Retry local checkpoint cleanup"}
      </Button>
    ) : phase === "ambiguous" ? (
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={busy || !acknowledged}
        onClick={onRelease}
      >
        Allow a new logical fire
      </Button>
    ) : phase === "not_registered" || phase === "recoverable" ? (
      <Button type="button" size="sm" disabled={busy} onClick={onRecover}>
        {phase === "recoverable"
          ? "Restore retained response"
          : "Continue this same fire"}
      </Button>
    ) : (
      <Button
        type="button"
        size="sm"
        disabled={busy}
        loading={checking}
        onClick={onCheck}
      >
        {checking ? "Checking receipt" : "Check server receipt"}
      </Button>
    );

  return (
    <Alert
      variant={danger ? "destructive" : "warning"}
      role="alert"
      aria-label="Fire reconciliation"
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-2 leading-5">
        <p>
          {reconciliation.detail} No automatic or new-identity retry will run.
        </p>
        <p className="break-all text-xs">
          Fire ID: <code>{reconciliation.request.fireId}</code>
          {" · "}
          {reconciliation.request.eventType} to {reconciliation.targetLabel}
        </p>
        {reconciliation.receipt ? (
          <p className="text-xs">
            Server receipt: {reconciliation.receipt.state.replaceAll("_", " ")}
            {reconciliation.receipt.outcome
              ? ` · ${reconciliation.receipt.outcome.replaceAll("_", " ")}`
              : ""}
            {reconciliation.receipt.receiver_status_code !== null
              ? ` · receiver status ${reconciliation.receipt.receiver_status_code}`
              : ""}
          </p>
        ) : null}
        {phase === "ambiguous" ? (
          <div className="flex items-start gap-2">
            <Checkbox
              id={ackId}
              checked={acknowledged}
              disabled={busy}
              onChange={(event) =>
                onAcknowledgedChange(event.currentTarget.checked)
              }
              className="mt-0.5"
            />
            <label htmlFor={ackId} className="text-sm">
              I checked the receiver and accept that its side effect may
              already have happened.
            </label>
          </div>
        ) : null}
        <div className="pt-1">{action}</div>
      </AlertDescription>
    </Alert>
  );
}

function outcomeSentence(shown: ShownResponse): string {
  const { data, request, targetLabel } = shown;
  if (data.filtered) {
    return `${request.eventType} was evaluated for ${targetLabel}, but the destination filter prevented a receiver request.`;
  }
  if (data.ambiguous) {
    return `${request.eventType} crossed the outbound transport boundary for ${targetLabel}, but no receiver status was observed. That is not proof the receiver did nothing.`;
  }
  return `Response to ${request.eventType} sent to ${targetLabel}.`;
}

export function FireResponsePanel({ shown }: { shown: ShownResponse }) {
  const { data } = shown;
  const headerNames = Object.keys(data.headers).sort();
  return (
    <section
      aria-label="Fire response"
      className="space-y-3 rounded-xl border p-4"
    >
      <div>
        <h3 className="text-sm font-semibold">Response</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {outcomeSentence(shown)}
        </p>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Receiver status</dt>
          <dd className="font-mono tabular-nums">
            {data.filtered
              ? "Filtered"
              : data.ambiguous
                ? "Not observed"
                : data.status_code}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Latency</dt>
          <dd className="font-mono tabular-nums">{data.latency_ms} ms</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Outcome</dt>
          <dd>{(data.outcome || "unknown").replaceAll("_", " ")}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Delivery ID</dt>
          <dd className="break-all font-mono text-xs">
            {data.delivery_id || "—"}
          </dd>
        </div>
      </dl>
      {data.error ? (
        <p className="text-sm text-destructive-emphasis">
          Delivery error: {data.error}
        </p>
      ) : null}
      <div>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">
          {data.method} {data.url} · request headers
        </h4>
        {headerNames.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No request headers were returned.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-xs">
            {headerNames.map((name) => (
              <li
                key={name}
                className="grid gap-1 px-3 py-1.5 sm:grid-cols-[12rem_minmax(0,1fr)]"
              >
                <span className="font-mono font-medium">{name}</span>
                <span className="break-all font-mono">{data.headers[name]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">
          Signed request body
        </h4>
        <pre
          tabIndex={0}
          role="group"
          aria-label="Signed request body"
          className="max-h-72 overflow-auto rounded-lg border bg-muted/15 p-3 text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <code>{JSON.stringify(data.body, null, 2) ?? ""}</code>
        </pre>
      </div>
      <div>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">
          Receiver response body
          {data.response_body_truncated ? " (truncated by the server)" : ""}
        </h4>
        <pre
          tabIndex={0}
          role="group"
          aria-label="Receiver response body"
          className="max-h-72 overflow-auto rounded-lg border bg-muted/15 p-3 text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <code>{data.response_body || "(empty)"}</code>
        </pre>
      </div>
      <p className="text-xs text-muted-foreground">
        Credential-bearing request details and echoed secrets are redacted by
        the server before they are shown.
      </p>
    </section>
  );
}
