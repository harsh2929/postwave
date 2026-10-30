// SPDX-License-Identifier: AGPL-3.0-only
//
// "What happened when I clicked that?" — on one screen.
//
// One request writes audit rows across several tables (the mutation, the
// approval decision, the entitlement check, the outbox dispatch) and the feed
// shows them as unrelated lines, newest first. Reconstructing the moment meant
// eyeballing timestamps across screens and hoping no two operators acted in the
// same second. The server has answered this since audit_chain.go landed
// (GET /api/v1/audit/chain/{requestId}); nothing asked it until this dialog.
"use client";

import { Workflow } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyTextButton } from "@/components/copy-text-button";
import { RelativeTime } from "@/components/relative-time";
import {
  getAuditChain,
  redactAuditMetadata,
  type AuditChainRow,
} from "@/lib/audit-api";

/** One field that differs between the row's before/after payload. */
interface ChangedField {
  name: string;
  before?: unknown;
  after?: unknown;
}

type ChangeKind = "created" | "updated" | "removed" | "none";

interface ChangeSummary {
  kind: ChangeKind;
  fields: ChangedField[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * What this entry changed, read off the audit payload emit.go writes:
 * `before` and/or `after`, with request context under `context` (which is NOT a
 * change — it is how the row got here — so it is excluded).
 *
 * Only keys whose serialized value actually differs are reported. A row that
 * rewrote a field to the value it already held is noise in an incident, and
 * listing it would pad the narrative with non-events.
 */
export function summarizeChange(
  metadata: Record<string, unknown> | undefined,
): ChangeSummary {
  const before = metadata?.["before"];
  const after = metadata?.["after"];
  const hasBefore = before !== undefined && before !== null;
  const hasAfter = after !== undefined && after !== null;
  if (!hasBefore && !hasAfter) return { kind: "none", fields: [] };

  const beforeObj = isPlainObject(before) ? before : undefined;
  const afterObj = isPlainObject(after) ? after : undefined;
  if (!beforeObj && !afterObj) {
    // A scalar or array payload — there are no field names to diff, so present
    // it whole rather than inventing a shape it does not have.
    return {
      kind: hasBefore && hasAfter ? "updated" : hasAfter ? "created" : "removed",
      fields: [{ name: "value", before, after }],
    };
  }

  const names = Array.from(
    new Set([
      ...Object.keys(beforeObj ?? {}),
      ...Object.keys(afterObj ?? {}),
    ]),
  ).sort();
  const fields: ChangedField[] = [];
  for (const name of names) {
    const b = beforeObj?.[name];
    const a = afterObj?.[name];
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    fields.push({ name, before: b, after: a });
  }
  const kind: ChangeKind = !hasBefore
    ? "created"
    : !hasAfter
      ? "removed"
      : "updated";
  return { kind, fields };
}

const MAX_VALUE_CHARS = 120;

function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return String(value);
  return text.length > MAX_VALUE_CHARS
    ? `${text.slice(0, MAX_VALUE_CHARS)}…`
    : text;
}

/** "by whom", from the row's actor columns. */
function actorText(row: AuditChainRow): string {
  const type = row.actorType || "unknown";
  return row.actorLabel ? `${type} · ${row.actorLabel}` : type;
}

/**
 * Offset from the first entry, in the units the reader needs.
 *
 * Absolute clock times inside one request are all the same second, which is
 * exactly why joining these rows by timestamp failed. The offset is what makes
 * the ORDER legible. Timezone-independent, so it is also hydration-safe.
 */
function offsetText(iso: string, startIso: string): string {
  const at = Date.parse(iso);
  const start = Date.parse(startIso);
  if (Number.isNaN(at) || Number.isNaN(start)) return "";
  const ms = at - start;
  if (ms < 1000) return `+${ms}ms`;
  return `+${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

const CHANGE_LABEL: Record<ChangeKind, string> = {
  created: "Created",
  updated: "Changed",
  removed: "Removed",
  none: "",
};

function ChainEntry({
  row,
  step,
  startIso,
}: {
  row: AuditChainRow;
  step: number;
  startIso: string;
}) {
  const safeMetadata = redactAuditMetadata(row.metadata);
  const change = summarizeChange(safeMetadata);
  return (
    <li className="relative border-l pl-6 pb-5 last:pb-0">
      <span
        className="absolute -left-[9px] top-0.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-background text-[10px] font-semibold text-muted-foreground"
        aria-hidden
      >
        {step}
      </span>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">{row.action}</span>
        <span
          className="shrink-0 font-mono text-xs text-muted-foreground"
          title={row.at}
        >
          {offsetText(row.at, startIso)}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {actorText(row)}
        {row.resourceType ? (
          <>
            {" · "}
            {row.resourceType}
            {row.resourceId ? (
              <span className="ml-1 font-mono" title={row.resourceId}>
                {row.resourceId.slice(0, 8)}
              </span>
            ) : null}
          </>
        ) : null}
      </p>
      {change.kind === "none" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No structured change payload was recorded for this action.
        </p>
      ) : change.fields.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {CHANGE_LABEL[change.kind]} nothing — the recorded before and after
          are identical.
        </p>
      ) : (
        <dl className="mt-2 space-y-1 text-xs">
          {change.fields.map((field) => (
            <div key={field.name} className="flex flex-wrap gap-x-2">
              <dt className="font-mono text-muted-foreground">{field.name}</dt>
              <dd className="min-w-0 break-all">
                <span className="text-muted-foreground line-through">
                  {formatValue(field.before)}
                </span>
                <span className="mx-1 text-muted-foreground" aria-label="to">
                  →
                </span>
                <span className="font-medium">{formatValue(field.after)}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {row.metadata && Object.keys(row.metadata).length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Raw payload
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 text-[11px]">
            {JSON.stringify(safeMetadata, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

/**
 * The causal chain for one request id, in the order it happened.
 *
 * `requestId === null` closes the dialog; the query is gated on it so opening
 * costs one fetch and closing costs none.
 */
export function AuditChainDialog({
  requestId,
  onClose,
}: {
  requestId: string | null;
  onClose: () => void;
}) {
  const chainQuery = useQuery({
    queryKey: ["audit-chain", requestId],
    queryFn: () => getAuditChain(requestId as string),
    enabled: requestId !== null,
  });

  const chain = chainQuery.data;
  const rows = Array.isArray(chain?.rows) ? chain?.rows : [];
  const startIso = rows[0]?.at ?? "";

  return (
    <Dialog
      open={requestId !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Request chain</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs break-all">{requestId}</span>
              {requestId ? (
                <CopyTextButton
                  value={requestId}
                  label=""
                  copiedLabel=""
                  variant="ghost"
                  toastOnCopy={false}
                />
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        {chainQuery.isPending ? (
          <div className="space-y-2" data-testid="audit-chain-loading">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : chainQuery.isError ? (
          <div className="space-y-3 text-sm">
            <p className="text-destructive">
              {chainQuery.error instanceof Error
                ? chainQuery.error.message
                : "Could not load this request chain."}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void chainQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          // Not an error, and not "no results". The server answered: no audit
          // row in this workspace carries this request id. Saying "not found"
          // would imply the request never happened, which is a different claim.
          <EmptyState
            icon={Workflow}
            title="Nothing was audited under this request"
            description="The request id is valid and this workspace holds no audit entries for it — either the request changed nothing that is audited, or its entries fall outside this workspace."
          />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {rows.length} {rows.length === 1 ? "entry" : "entries"}, in the
              order they happened
              {startIso ? (
                <>
                  {", starting "}
                  <RelativeTime iso={startIso} />
                </>
              ) : null}
              .
            </p>
            {chain?.truncated ? (
              <p className="text-xs text-warning-emphasis">
                This chain hit the server&apos;s 500-entry cap, so it is not the
                whole request. Export the audit log to read the rest.
              </p>
            ) : null}
            <ol className="ml-2">
              {rows.map((row, index) => (
                <ChainEntry
                  key={row.id}
                  row={row}
                  step={index + 1}
                  startIso={startIso}
                />
              ))}
            </ol>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
