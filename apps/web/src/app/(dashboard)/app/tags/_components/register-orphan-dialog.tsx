// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { apiErrorMessage } from "@/lib/api";
import {
  createTag,
  newWriteKey,
  type TagRecord,
} from "@/lib/audience-admin-api";
import type { TagUsage } from "@/lib/tags-api";
import {
  DEFAULT_TAG_COLOR,
  runeLength,
  tagIdentityKey,
} from "../tag-catalogue-model";
import { TagColorPalette } from "./tag-color-palette";

/**
 * Promotes an orphan — a label applied to subscribers that the registry does
 * not list — into a first-class tag. The NAME is read-only: it is already on
 * subscribers and this only backfills the registry row, so subscriber
 * assignments are never touched. The server conflict-checks by name, so a
 * second attempt after a partial failure is harmless.
 */
export function RegisterOrphanDialog({
  usage,
  authorize,
  onClose,
  onRegistered,
}: {
  /** The orphan to register; null closes the dialog. */
  usage: TagUsage | null;
  /** Re-asserts workspace identity immediately before the write. */
  authorize: () => Promise<void>;
  onClose: () => void;
  onRegistered: (tag: TagRecord) => Promise<void> | void;
}) {
  const [color, setColor] = useState(DEFAULT_TAG_COLOR);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const name = usage?.tag ?? "";
  useEffect(() => {
    setColor(DEFAULT_TAG_COLOR);
    setDescription("");
    setError(null);
  }, [name]);
  const trimmed = name.trim();
  const nameValid = trimmed.length > 0 && runeLength(trimmed) <= 64;

  async function submit() {
    if (!usage || busy || !nameValid) return;
    setBusy(true);
    setError(null);
    try {
      await authorize();
      if (runeLength(description) > 1024)
        throw new Error("Description must be at most 1,024 characters.");
      const tag = await createTag(
        {
          name: trimmed,
          color,
          description,
          group_id: "",
          pii: false,
        },
        newWriteKey("tag-register"),
      );
      if (tagIdentityKey(tag.name) !== tagIdentityKey(trimmed))
        throw new Error(
          "The server registered a different name. Refresh the catalogue before retrying.",
        );
      toast.success(`Registered "${tag.name}"`);
      await onRegistered(tag);
    } catch (e) {
      const message = apiErrorMessage(e, "Registration failed");
      if (mounted.current) setError(message);
      toast.error(message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Dialog
      open={usage !== null}
      onOpenChange={(v) => !v && !busy && onClose()}
    >
      <DialogContent closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>Register tag</DialogTitle>
          <DialogDescription>
            This tag is already applied to subscribers but has no catalogue
            entry yet. Give it a colour and a short description so the rest of
            the team knows what it means. Subscriber assignments do not change.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="orphan-tag-name">Tag</Label>
          <Input id="orphan-tag-name" value={name} readOnly aria-readonly />
          <p className="text-xs text-muted-foreground">
            Currently applied to{" "}
            <strong className="tabular-nums">
              {(usage?.subscribers ?? 0).toLocaleString()}
            </strong>{" "}
            subscriber{usage?.subscribers === 1 ? "" : "s"}.
          </p>
          <Label htmlFor="orphan-tag-color">Colour</Label>
          <TagColorPalette
            id="orphan-tag-color"
            value={color}
            onChange={setColor}
            disabled={busy}
          />
          <Label htmlFor="orphan-tag-description">Description</Label>
          <Textarea
            id="orphan-tag-description"
            rows={3}
            maxLength={1024}
            value={description}
            disabled={busy}
            placeholder="What does this tag mean? Who should get it?"
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {runeLength(description).toLocaleString()} / 1,024 characters.
          </p>
          {usage && !nameValid ? (
            <p role="alert" className="text-sm text-destructive">
              This legacy tag name cannot be registered: it must be non-blank
              and at most 64 characters.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !nameValid} onClick={submit}>
            {busy ? "Registering…" : "Register tag"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
