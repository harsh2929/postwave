// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { RefObject } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type SmsQuickReplyEditor = {
  id?: string;
  label: string;
  body: string;
};

export function SmsQuickReplyDialog({
  busy,
  editor,
  error,
  bodyRef,
  labelRef,
  returnFocus,
  onChange,
  onClearError,
  onClose,
  onSave,
}: {
  busy: boolean;
  editor: SmsQuickReplyEditor;
  error: string;
  bodyRef: RefObject<HTMLTextAreaElement | null>;
  labelRef: RefObject<HTMLInputElement | null>;
  returnFocus: RefObject<HTMLElement | null>;
  onChange: (editor: SmsQuickReplyEditor) => void;
  onClearError: () => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          const returnTarget = returnFocus.current;
          returnFocus.current = null;
          if (!returnTarget?.isConnected) return;
          event.preventDefault();
          returnTarget.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {editor.id ? "Edit custom template" : "Save custom template"}
          </DialogTitle>
          <DialogDescription>
            Custom templates are available to this workspace in the campaign
            composer. Saving does not send a message.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="sms-template-label">Template name</Label>
            <Input
              ref={labelRef}
              id="sms-template-label"
              value={editor.label}
              maxLength={120}
              required
              aria-invalid={Boolean(error) && !editor.label.trim()}
              aria-describedby={error ? "sms-template-error" : undefined}
              onChange={(event) => {
                onChange({ ...editor, label: event.target.value });
                if (error) onClearError();
              }}
              placeholder="Welcome offer"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sms-template-body">Message</Label>
            <Textarea
              ref={bodyRef}
              id="sms-template-body"
              value={editor.body}
              maxLength={1600}
              required
              aria-invalid={Boolean(error) && !editor.body.trim()}
              aria-describedby="sms-template-body-count sms-template-error"
              onChange={(event) => {
                onChange({ ...editor, body: event.target.value });
                if (error) onClearError();
              }}
            />
            <p
              id="sms-template-body-count"
              className="text-right text-xs tabular-nums text-muted-foreground"
            >
              {editor.body.length.toLocaleString()} / 1,600
            </p>
          </div>
          <p
            id="sms-template-error"
            role={error ? "alert" : undefined}
            className={error ? "text-sm text-destructive" : "sr-only"}
          >
            {error || "Both fields are required."}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="min-h-10"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" className="min-h-10" loading={busy}>
              {editor.id ? "Save changes" : "Save template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
