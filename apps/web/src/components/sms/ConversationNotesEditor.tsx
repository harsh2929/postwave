// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Internal notes for one SMS conversation — the seed route
// POST /api/v1/sms/conversations/{phone}/notes (owner/admin, exact-tenant).
//
// Neither client rendered this verb before: desktop's api.setSMSConversationNotes
// has no UI caller. The server exposes notes as WRITE-ONLY — no inbox read
// returns them — so this editor cannot show what is currently saved. Saving
// therefore replaces text the operator cannot see, and goes through a confirm
// that says so. The write is compare-and-set on the loaded stateUpdatedAt and
// authority is re-read fresh on both sides of the request, matching the
// conversation-controls panel it is designed to sit in.

import { useId, useRef, useState } from "react";
import { NotebookPen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoamiFresh } from "@/lib/auth-api";
import {
  setSmsConversationNotes,
  smsConversationNotesProblem,
} from "@/lib/sms-api";
import type {
  SmsConversationStateMutationReceipt,
  SmsConversationSummary,
} from "@/lib/sms-inbox-contract";

export interface SmsNotesEditorIdentity {
  tenantId: string;
  userId: string;
  effectiveRole: "owner" | "admin";
}

async function confirmFreshInboxAdmin(
  identity: SmsNotesEditorIdentity,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const current = await whoamiFresh();
  const role = effectiveAuthRole(current);
  if (
    current.tenant_id !== identity.tenantId ||
    current.user_id !== identity.userId ||
    current.viewer_mode === true ||
    role !== identity.effectiveRole ||
    (role !== "owner" && role !== "admin")
  ) {
    throw new Error(
      "SMS inbox authorization changed. Reload before changing conversation notes.",
    );
  }
  assertCurrent();
}

export function ConversationNotesEditor({
  conversation,
  identity,
  online,
  assertCurrent,
  onStateChanged,
  onRefreshRequired,
}: {
  conversation: Pick<SmsConversationSummary, "phoneE164" | "stateUpdatedAt">;
  identity: SmsNotesEditorIdentity;
  online: string;
  assertCurrent: () => void;
  onStateChanged: (receipt: SmsConversationStateMutationReceipt) => void;
  onRefreshRequired: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inFlight = useRef(false);
  const fieldId = useId();
  const hintId = useId();
  const problem = smsConversationNotesProblem(notes);
  const disabled = online !== "online" || busy;

  const save = async (): Promise<void> => {
    if (inFlight.current || problem || online !== "online") return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await confirmFreshInboxAdmin(identity, assertCurrent);
      const receipt = await setSmsConversationNotes({
        tenantId: identity.tenantId,
        phoneE164: conversation.phoneE164,
        expectedUpdatedAt: conversation.stateUpdatedAt ?? null,
        notes,
      });
      await confirmFreshInboxAdmin(identity, assertCurrent);
      onStateChanged(receipt);
      setSuccess(
        notes
          ? "Notes saved — confirmed by the tenant-bound state receipt."
          : "Notes cleared — confirmed by the tenant-bound state receipt.",
      );
    } catch (caught) {
      setError(
        `${apiErrorMessage(caught, "The notes change was not confirmed.")} Refresh the inbox before retrying; a timed-out request may already have committed.`,
      );
      onRefreshRequired();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Internal conversation notes"
      className="space-y-2 rounded-md border p-3"
    >
      <Label htmlFor={fieldId} className="flex items-center gap-1.5">
        <NotebookPen className="h-4 w-4" aria-hidden />
        Internal notes
      </Label>
      <p id={hintId} className="text-xs text-muted-foreground">
        Operator-only and never sent to the contact. Moosewave does not read
        saved notes back to any screen yet, so saving replaces whatever notes
        this conversation already has; leave it empty to clear them.
      </p>
      <Textarea
        id={fieldId}
        rows={3}
        value={notes}
        disabled={disabled}
        aria-describedby={hintId}
        aria-invalid={problem !== null}
        onChange={(event) => {
          setNotes(event.target.value);
          setSuccess(null);
        }}
      />
      {problem ? (
        <p className="text-xs text-destructive-emphasis">{problem}</p>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || problem !== null}
        onClick={() => setConfirmOpen(true)}
      >
        {busy ? "Saving notes…" : notes ? "Save notes" : "Clear notes"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive-emphasis">
          {error}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="text-xs text-muted-foreground">
          {success}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={notes ? "Replace conversation notes?" : "Clear conversation notes?"}
        description={`This overwrites the internal notes for ${conversation.phoneE164}. Existing notes are not shown anywhere in Moosewave, so the text being replaced cannot be reviewed or recovered.`}
        confirmLabel={notes ? "Replace notes" : "Clear notes"}
        onConfirm={() => save()}
      />
    </section>
  );
}
