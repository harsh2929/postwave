// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Saved-reply picker for the SMS composer (desktop
// components/sms/QuickReplyPicker.tsx). Opens a non-modal panel over
// GET /api/v1/sms/quick-replies (most-used first), inserts one into the
// composer through `onPick`, lets the operator save a new reply
// (POST /api/v1/sms/quick-replies) or delete one behind a confirm
// (DELETE /api/v1/sms/quick-replies/{id}). Recording a USE
// (POST …/{id}/use) is the composer's job, after a persisted send — a pick
// alone proves nothing was sent.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  createSmsQuickReply,
  deleteSmsQuickReply,
  listSmsQuickReplies,
  type SmsQuickReply,
} from "@/lib/sms-api";
import { smsReplyBodyConstraint } from "@/lib/sms-reply-intent";

export interface QuickReplyPickerProps {
  /** Opaque caller-owned key for the saved-reply list. */
  queryKey: readonly unknown[];
  disabled?: boolean;
  onPick: (reply: SmsQuickReply) => void;
}

function quickReplyLabelProblem(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return "Enter a reply label.";
  if (/[\p{Cc}\p{Cf}]/u.test(trimmed)) {
    return "Reply labels cannot contain control or direction-formatting characters.";
  }
  if (Array.from(trimmed).length > 80) {
    return "Reply label exceeds the 80-character server limit.";
  }
  if (new TextEncoder().encode(trimmed).byteLength > 320) {
    return "Reply label exceeds the 320-byte UTF-8 server limit.";
  }
  return null;
}

export function QuickReplyPicker({
  queryKey,
  disabled = false,
  onPick,
}: QuickReplyPickerProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const titleId = useId();
  const labelId = useId();
  const bodyId = useId();
  const errorId = useId();

  const replies = useQuery({
    queryKey,
    enabled: open,
    queryFn: ({ signal }) => listSmsQuickReplies({ signal }),
    retry: false,
  });
  const rows = useMemo(() => {
    const loaded = Array.isArray(replies.data) ? replies.data : [];
    return [...loaded].sort(
      (a, b) => b.useCount - a.useCount || a.label.localeCompare(b.label),
    );
  }, [replies.data]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target) ||
        (target instanceof Element && target.closest('[role="dialog"]'))
      ) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const labelProblem = quickReplyLabelProblem(draftLabel);
  const bodyConstraint = smsReplyBodyConstraint(draftBody);
  const draftDirty = draftLabel.trim() !== "" || draftBody.trim() !== "";

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey, exact: true });

  const saveDraft = async () => {
    if (saving || labelProblem || bodyConstraint.error) return;
    setSaving(true);
    setSaveError(null);
    try {
      await createSmsQuickReply({
        label: draftLabel.trim(),
        body: bodyConstraint.trimmed,
      });
      setDraftLabel("");
      setDraftBody("");
      setCreating(false);
      toast.success("Quick reply saved");
      await invalidate();
    } catch (error) {
      setSaveError(apiErrorMessage(error, "The quick reply was not saved."));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (reply: SmsQuickReply) => {
    await deleteSmsQuickReply(reply.id);
    await invalidate();
  };

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant="outline"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        Quick replies
      </Button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={0}
          className="absolute bottom-full left-0 z-20 mb-2 w-[min(24rem,90vw)] max-h-80 space-y-3 overflow-y-auto rounded-md border bg-background p-3 text-sm shadow-lg"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong id={titleId}>Saved replies</strong>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  if (creating && draftDirty) {
                    setDraftLabel("");
                    setDraftBody("");
                  }
                  setCreating((value) => !value);
                  setSaveError(null);
                }}
              >
                {creating ? "Cancel new reply" : "New reply"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                Close
              </Button>
            </div>
          </div>

          {creating ? (
            <form
              className="space-y-2 rounded-md border bg-muted/20 p-2"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void saveDraft();
              }}
            >
              <div className="space-y-1">
                <Label htmlFor={labelId}>Reply label</Label>
                <Input
                  id={labelId}
                  value={draftLabel}
                  maxLength={320}
                  autoComplete="off"
                  disabled={saving}
                  aria-invalid={draftLabel.length > 0 && labelProblem !== null}
                  onChange={(event) => setDraftLabel(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={bodyId}>Reply body</Label>
                <Textarea
                  id={bodyId}
                  rows={3}
                  value={draftBody}
                  disabled={saving}
                  aria-invalid={
                    draftBody.length > 0 && bodyConstraint.error !== null
                  }
                  aria-describedby={saveError ? errorId : undefined}
                  onChange={(event) => setDraftBody(event.target.value)}
                />
              </div>
              {saveError ? (
                <p id={errorId} role="alert" className="text-xs text-destructive">
                  {saveError}
                </p>
              ) : null}
              <Button
                type="submit"
                size="sm"
                loading={saving}
                disabled={
                  saving || labelProblem !== null || bodyConstraint.error !== null
                }
              >
                {saving ? "Saving…" : "Save reply"}
              </Button>
            </form>
          ) : null}

          {replies.isPending ? (
            <p role="status" className="text-muted-foreground">
              Loading saved replies…
            </p>
          ) : replies.isError ? (
            <div role="alert" className="space-y-2">
              <p className="text-destructive">
                Saved replies could not be loaded.{" "}
                {apiErrorMessage(replies.error)}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void replies.refetch()}
              >
                Retry saved replies
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground">
              No saved replies in the loaded response. Choose New reply to
              create one.
            </p>
          ) : (
            <ul aria-label="Saved replies" className="space-y-1">
              {rows.map((reply) => (
                <li
                  key={reply.id}
                  className="flex items-start gap-1 rounded-md border p-1"
                >
                  <button
                    type="button"
                    className="min-h-11 min-w-0 flex-1 rounded-sm px-2 py-1 text-left hover:bg-muted"
                    aria-label={`Insert saved reply: ${reply.label}`}
                    disabled={saving || (creating && draftDirty)}
                    onClick={() => {
                      onPick(reply);
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                  >
                    <bdi dir="auto" className="block font-medium">
                      {reply.label}
                    </bdi>
                    <span
                      dir="auto"
                      className="block truncate text-xs text-muted-foreground"
                    >
                      {reply.body}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      Used {reply.useCount.toLocaleString()} time
                      {reply.useCount === 1 ? "" : "s"}
                    </span>
                  </button>
                  <ConfirmDialog
                    trigger={
                      <button
                        type="button"
                        className="min-h-11 min-w-11 rounded-sm text-muted-foreground hover:text-destructive"
                        aria-label={`Delete saved reply: ${reply.label}`}
                        disabled={saving || (creating && draftDirty)}
                      >
                        ×
                      </button>
                    }
                    title="Delete this quick reply?"
                    description={`“${reply.label}” is removed from the catalogue. Operators will no longer see it in the inbox composer.`}
                    confirmLabel="Delete reply"
                    onConfirm={() => remove(reply)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
