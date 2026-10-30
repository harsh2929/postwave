// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Audited SMS conversations CSV export (desktop pages/SMSInbox.tsx:876-905
// fetch + 1275-1360 modals). Three explicit steps, as on desktop:
//   1. "Export CSV" opens an audit-reason form — the reason is required and is
//      sent as X-Postwave-Audit-Reason, where the server records it with the
//      sms.inbox.export audit event.
//   2. "Review export bounds" makes ONE GET /api/v1/sms/conversations.csv and
//      holds the verified body in memory, showing the server's own row count,
//      row cap, as-of boundary and truncation verdict.
//   3. "Save private CSV" hands that exact body to the browser download; the
//      operator may instead discard it.
// The export is tenant-wide: inbox filters and search are not applied, and the
// dialog says so.

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { downloadBlobFile } from "@/lib/download";
import { pluralizeCount } from "@/lib/pluralize";
import {
  exportSmsConversationsCsv,
  type SmsConversationsExport,
} from "@/lib/sms-api";
import {
  SMS_EXPORT_REASON_MAX_CHARS,
  smsExportReasonProblem,
} from "@/lib/sms-conversation-lookup-contract";

function formatAsOf(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function smsExportBoundsSentence(
  prepared: SmsConversationsExport,
): string {
  const { truth } = prepared;
  return `Server export boundary as of ${formatAsOf(truth.asOf)}. The response cap is ${pluralizeCount(truth.limit, "row")}. ${
    truth.truncated
      ? "The server reports this export is truncated; additional conversations are omitted."
      : "The server did not report truncation."
  } Current inbox filters and search are not applied. The file contains customer phone numbers — store it privately.`;
}

export function SmsConversationsCsvExport({
  online,
}: {
  online: boolean;
}) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [prepared, setPrepared] = useState<SmsConversationsExport | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const problem = smsExportReasonProblem(reason);

  const prepare = useMutation({
    mutationFn: (auditReason: string) =>
      exportSmsConversationsCsv({ auditReason }),
    onSuccess: (result) => {
      setReasonOpen(false);
      setPrepared(result);
    },
  });

  const closeReason = () => {
    if (prepare.isPending) return;
    setReasonOpen(false);
    prepare.reset();
  };

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant="outline"
        disabled={!online}
        title={online ? undefined : "Export needs a live connection."}
        onClick={() => {
          setTouched(false);
          prepare.reset();
          setReasonOpen(true);
        }}
      >
        <Download aria-hidden /> Export CSV
      </Button>
      {!online ? (
        <span className="text-xs text-muted-foreground">
          Export needs a live connection.
        </span>
      ) : null}

      <Dialog
        open={reasonOpen}
        onOpenChange={(open) => {
          if (!open) closeReason();
        }}
      >
        <DialogContent
          closeDisabled={prepare.isPending}
          onCloseAutoFocus={(event) => {
            if (!triggerRef.current?.isConnected) return;
            event.preventDefault();
            triggerRef.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Prepare audited SMS export</DialogTitle>
            <DialogDescription>
              This downloads a tenant-wide summary of retained SMS conversation
              records (phone, last message time, message count, last inbound
              time). Current inbox filters and search are not applied.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setTouched(true);
              if (problem || !online || prepare.isPending) return;
              prepare.mutate(reason.trim());
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="sms-export-audit-reason">Audit reason</Label>
              <Textarea
                id="sms-export-audit-reason"
                rows={3}
                maxLength={SMS_EXPORT_REASON_MAX_CHARS}
                value={reason}
                disabled={prepare.isPending}
                placeholder="Example: Quarterly support-response review"
                aria-invalid={touched && problem !== null}
                aria-describedby="sms-export-audit-reason-help"
                onChange={(event) => {
                  setReason(event.target.value);
                  if (prepare.isError) prepare.reset();
                }}
              />
              <p
                id="sms-export-audit-reason-help"
                className="text-xs text-muted-foreground"
              >
                Required · {Array.from(reason.trim()).length}/
                {SMS_EXPORT_REASON_MAX_CHARS} characters. This reason is
                recorded with the export audit event.
              </p>
            </div>
            {touched && problem ? (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            ) : null}
            {prepare.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {apiErrorMessage(prepare.error, "The export could not be prepared.")}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={prepare.isPending}
                onClick={closeReason}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={prepare.isPending}
                disabled={!online || (touched && problem !== null)}
              >
                Review export bounds
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={prepared !== null}
        onOpenChange={(open) => {
          if (!open) setPrepared(null);
        }}
        returnFocusRef={triggerRef}
        title={
          prepared
            ? `Save ${prepared.truth.rowCount.toLocaleString()}-row SMS export?`
            : "Save SMS export?"
        }
        description={
          prepared
            ? smsExportBoundsSentence(prepared)
            : "Review the server-provided bounds before saving."
        }
        confirmLabel="Save private CSV"
        cancelLabel="Discard prepared export"
        confirmVariant="default"
        onConfirm={() => {
          if (!prepared) return;
          downloadBlobFile(
            prepared.filename,
            new Blob([prepared.csv], { type: "text/csv;charset=utf-8" }),
          );
          toast.success(
            `${pluralizeCount(prepared.truth.rowCount, "row")} saved with a server as-of boundary of ${formatAsOf(prepared.truth.asOf)}${
              prepared.truth.truncated
                ? `; export capped at ${pluralizeCount(prepared.truth.limit, "row")}`
                : ""
            }.`,
          );
          setPrepared(null);
          setReason("");
          setTouched(false);
        }}
      />
    </>
  );
}
