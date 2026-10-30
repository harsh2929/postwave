// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { ReactNode, RefObject } from "react";

import { CopyTextButton } from "@/components/copy-text-button";
import { summarizeChange } from "@/components/settings/audit-chain-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  correlationIdOf,
  redactAuditMetadata,
  type AuditRow,
} from "@/lib/audit-api";

export function AuditDetailDialog({
  row,
  returnFocus,
  onClose,
  onOpenChain,
  onFilterResource,
}: {
  row: AuditRow;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpenChain: (requestId: string) => void;
  /**
   * governance-16: scope the feed to the record this entry touched. Optional
   * because the dialog is also opened from places that own no filter state.
   */
  onFilterResource?: (row: AuditRow) => void;
}) {
  const safeMetadata = redactAuditMetadata(row.metadata);
  const metadataText = JSON.stringify(safeMetadata, null, 2);
  const hasMetadata = Boolean(
    row.metadata && Object.keys(row.metadata).length > 0,
  );
  const correlationId = correlationIdOf(row);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-lg [&_button]:min-h-11 sm:[&_button]:min-h-0"
        onCloseAutoFocus={(event) => {
          if (!returnFocus.current) return;
          event.preventDefault();
          returnFocus.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-words">{row.action}</DialogTitle>
          <DialogDescription>
            {new Date(row.at).toLocaleString()}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <DetailRow label="Actor">
            {row.actorType}
            {row.actorLabel ? ` · ${row.actorLabel}` : ""}
          </DetailRow>
          {row.userId ? (
            <DetailRow label="User ID">
              <span className="font-mono text-xs">{row.userId}</span>
            </DetailRow>
          ) : null}
          {correlationId ? (
            <DetailRow label="Request">
              <span className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-xs">
                  {correlationId}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenChain(correlationId)}
                >
                  View request chain
                </Button>
              </span>
            </DetailRow>
          ) : null}
          {row.resourceType ? (
            <DetailRow label="Resource">
              <span className="flex items-center gap-2">
                <span>{row.resourceType}</span>
                {row.resourceId ? (
                  <>
                    <span className="break-all font-mono text-xs">
                      {row.resourceId}
                    </span>
                    <CopyTextButton
                      value={row.resourceId}
                      label=""
                      copiedLabel=""
                      variant="ghost"
                      toastOnCopy={false}
                    />
                    {onFilterResource ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onFilterResource(row)}
                      >
                        Filter to this resource
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </span>
            </DetailRow>
          ) : null}
          {row.ip ? (
            <DetailRow label="IP">
              <span className="font-mono text-xs">{row.ip}</span>
            </DetailRow>
          ) : null}
          {row.userAgent ? (
            <DetailRow label="User agent">
              <span className="break-all text-xs text-muted-foreground">
                {row.userAgent}
              </span>
            </DetailRow>
          ) : null}
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              What changed
            </div>
            {hasMetadata ? (
              // governance-19. Parsed reads the payload the way the chain
              // dialog does — the fields that moved, old → new — and JSON is
              // the same redacted object verbatim, with a copy of exactly that
              // text. Both views and the clipboard see the REDACTED payload:
              // nothing leaves this dialog that the dialog would not show.
              <Tabs defaultValue="parsed">
                <TabsList aria-label="Metadata view">
                  <TabsTrigger value="parsed">Parsed</TabsTrigger>
                  <TabsTrigger value="json">JSON</TabsTrigger>
                </TabsList>
                <TabsContent value="parsed">
                  <ParsedMetadata metadata={safeMetadata} />
                </TabsContent>
                <TabsContent value="json" className="space-y-2">
                  <div className="flex justify-end">
                    <CopyTextButton
                      value={metadataText}
                      label="Copy JSON"
                      copiedLabel="Copied"
                      toastOnCopy={false}
                    />
                  </div>
                  <pre className="max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                    {metadataText}
                  </pre>
                </TabsContent>
              </Tabs>
            ) : (
              <p className="text-xs text-muted-foreground">
                No structured change payload was recorded for this action.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

const MAX_VALUE_CHARS = 160;

function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return String(value);
  return text.length > MAX_VALUE_CHARS
    ? `${text.slice(0, MAX_VALUE_CHARS)}…`
    : text;
}

/**
 * The payload read as a change rather than as text.
 *
 * With a before/after pair, only the fields whose value moved are listed
 * (identical fields are noise in an investigation). Without one — a payload
 * that is context, a receipt, or a bare record — the top-level keys are laid
 * out as a key/value list, which is still one parse pass fewer than raw JSON.
 */
function ParsedMetadata({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  const change = summarizeChange(metadata);
  if (change.kind === "none") {
    return (
      <dl className="space-y-1 text-xs" aria-label="Payload fields">
        {Object.entries(metadata).map(([name, value]) => (
          <div key={name} className="flex flex-wrap gap-x-2">
            <dt className="font-mono text-muted-foreground">{name}</dt>
            <dd className="min-w-0 break-all">{formatValue(value)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (change.fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Before and after payloads are identical.
      </p>
    );
  }
  return (
    <dl className="space-y-1 text-xs" aria-label="Before/after diff">
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
  );
}
