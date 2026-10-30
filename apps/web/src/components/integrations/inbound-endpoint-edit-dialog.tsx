// SPDX-License-Identifier: AGPL-3.0-only
//
// Edit an inbound endpoint after creation (INTG-005): rename, enable/disable
// (pause without deleting — deletion breaks the ingest URL), and edit the jq
// transform (with the live tester). PATCH sends the complete intended state for
// every edited field; transform_jq is sent as-is (empty string clears it).
"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import {
  updateInboundWebhook,
  type InboundWebhook,
} from "@/lib/inbound-webhooks-api";
import {
  canAdminInboundWebhooks,
  INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE,
  verifyFreshInboundWebhookAdmin,
} from "@/lib/inbound-webhook-authority";
import { TransformTester } from "./transform-tester";

export function InboundEndpointEditDialog({
  endpoint,
  identity,
  open,
  onOpenChange,
  onSaved,
  returnFocusRef,
}: {
  endpoint: InboundWebhook;
  identity: MeResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: InboundWebhook) => void;
  /**
   * Controlled dialogs do not have a Radix trigger to restore automatically.
   * Keep the opener explicit so successful saves and every close path return
   * keyboard users to the row action that launched the editor.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const nameId = useId();
  const transformId = useId();
  const nameErrorId = useId();
  const [name, setName] = useState(endpoint.name);
  const [enabled, setEnabled] = useState(endpoint.enabled);
  const [transformJQ, setTransformJQ] = useState(endpoint.transform_jq ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const savingGuard = useRef(false);
  const canAdmin = canAdminInboundWebhooks(identity);

  // A direct consumer can keep this component mounted while switching rows or
  // closing/reopening it. Never leak the previous endpoint's draft or error
  // into the next editing session.
  useEffect(() => {
    if (!open) return;
    setName(endpoint.name);
    setEnabled(endpoint.enabled);
    setTransformJQ(endpoint.transform_jq ?? "");
    setError(null);
    setNameTouched(false);
    savingGuard.current = false;
  }, [
    endpoint.enabled,
    endpoint.id,
    endpoint.name,
    endpoint.transform_jq,
    open,
  ]);

  const trimmedName = name.trim();
  const nameError = trimmedName ? null : "Name is required.";
  const dirty =
    trimmedName !== endpoint.name ||
    enabled !== endpoint.enabled ||
    transformJQ !== (endpoint.transform_jq ?? "");

  async function onSave() {
    if (savingGuard.current) return;
    if (!canAdmin) {
      setError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return;
    }
    if (nameError) {
      setNameTouched(true);
      return;
    }
    if (!dirty) return;
    savingGuard.current = true;
    setSaving(true);
    setError(null);
    try {
      await verifyFreshInboundWebhookAdmin(identity);
      // Send the complete intended state for each field the operator can edit.
      const updated = await updateInboundWebhook(endpoint.id, {
        name: trimmedName,
        enabled,
        transform_jq: transformJQ,
      });
      toast.success("Endpoint updated");
      // The network mutation is complete, so this close is no longer a
      // pending-dismissal attempt and may pass through the guarded close path.
      savingGuard.current = false;
      onSaved(updated);
      handleOpenChange(false);
    } catch (e) {
      setError(apiErrorMessage(e, "Update failed"));
    } finally {
      savingGuard.current = false;
      setSaving(false);
    }
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next && savingGuard.current) return;
    onOpenChange(next);
    if (!next && returnFocusRef) {
      // The parent conditionally unmounts this controlled dialog. Restore on
      // the next frame so React has committed that close and FocusScope cannot
      // subsequently move focus back to <body>.
      window.requestAnimationFrame(() => {
        const trigger = returnFocusRef.current;
        if (trigger?.isConnected) trigger.focus();
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-busy={saving}
        onCloseAutoFocus={(event) => {
          const trigger = returnFocusRef?.current;
          if (!trigger?.isConnected) return;
          event.preventDefault();
          trigger.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (savingGuard.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (savingGuard.current) event.preventDefault();
        }}
        className="max-w-lg [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
      >
        <DialogHeader>
          <DialogTitle>Edit endpoint</DialogTitle>
          <DialogDescription>
            Rename, pause, or change the jq transform. Pausing stops processing
            without breaking the ingest URL.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={name}
              disabled={saving || !canAdmin}
              aria-invalid={nameTouched && nameError ? true : undefined}
              aria-describedby={
                nameTouched && nameError ? nameErrorId : undefined
              }
              onBlur={() => setNameTouched(true)}
              onInvalid={() => setNameTouched(true)}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              required
            />
            {nameTouched && nameError ? (
              <p
                id={nameErrorId}
                role="alert"
                className="text-xs text-destructive"
              >
                {nameError}
              </p>
            ) : null}
          </div>

          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
            <Checkbox
              checked={enabled}
              disabled={saving || !canAdmin}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setError(null);
              }}
            />
            Enabled — receive and process incoming events
          </label>

          <div className="space-y-1.5">
            <Label htmlFor={transformId}>Transform (jq, optional)</Label>
            <Textarea
              id={transformId}
              value={transformJQ}
              disabled={saving || !canAdmin}
              onChange={(e) => {
                setTransformJQ(e.target.value);
                setError(null);
              }}
              rows={3}
              className="font-mono text-xs"
              spellCheck={false}
              placeholder=". + { email: .form_response.answers[0].email }"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to pass payloads through unchanged.
            </p>
            <TransformTester transformJQ={transformJQ} identity={identity} />
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={saving}
              disabled={saving || !dirty || !canAdmin}
              title={!canAdmin ? INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE : undefined}
            >
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
