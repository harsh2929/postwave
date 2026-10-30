// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  newWriteKey,
  updateTag,
  type TagRecord,
} from "@/lib/audience-admin-api";
import { isTagVersionConflict } from "@/lib/tags-api";
import { DEFAULT_TAG_COLOR, runeLength } from "../tag-catalogue-model";
import { TagColorPalette } from "./tag-color-palette";

export type BulkEditMode = "color" | "description";

export interface BulkEditOutcome {
  ok: number;
  failedIds: string[];
  /** At least one tag was refused with 412: its ETag moved under us. */
  conflict: boolean;
}

/**
 * Applies a colour and/or description to every selected tag. Each tag gets
 * its own `PATCH /api/v1/tags/{id}` carrying that tag's exact ETag, so a tag
 * edited elsewhere is refused (412) instead of silently overwritten. Writes
 * run in sequence: the catalogue is small and per-tag failure reporting is
 * the point. Failed tags stay selected so the operator can retry only those.
 */
export function BulkEditDialog({
  open,
  mode,
  tags,
  authorize,
  onClose,
  onSettled,
}: {
  open: boolean;
  mode: BulkEditMode;
  /** The currently selected registry rows, ETags included. */
  tags: TagRecord[];
  authorize: () => Promise<void>;
  onClose: () => void;
  onSettled: (outcome: BulkEditOutcome) => Promise<void> | void;
}) {
  const [applyColor, setApplyColor] = useState(mode === "color");
  const [applyDescription, setApplyDescription] = useState(
    mode === "description",
  );
  const [color, setColor] = useState(DEFAULT_TAG_COLOR);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, failed: 0 });
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    setApplyColor(mode === "color");
    setApplyDescription(mode === "description");
    setColor(DEFAULT_TAG_COLOR);
    setDescription("");
    setProgress({ done: 0, failed: 0 });
    setFailedIds([]);
    setLastError(null);
  }, [open, mode]);

  const targets = useMemo(
    () =>
      failedIds.length > 0
        ? tags.filter((x) => failedIds.includes(x.id))
        : tags,
    [failedIds, tags],
  );
  const canApply =
    (applyColor || applyDescription) && targets.length > 0 && !busy;

  async function submit() {
    if (!canApply) return;
    setBusy(true);
    setProgress({ done: 0, failed: 0 });
    setLastError(null);
    try {
      await authorize();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Bulk edit refused"));
      if (mounted.current) setBusy(false);
      return;
    }
    if (applyDescription && runeLength(description) > 1024) {
      toast.error("Description must be at most 1,024 characters.");
      if (mounted.current) setBusy(false);
      return;
    }
    const patch: Partial<Pick<TagRecord, "color" | "description">> = {};
    if (applyColor) patch.color = color;
    if (applyDescription) patch.description = description;
    let ok = 0;
    let conflict = false;
    let firstError: string | null = null;
    const nextFailed: string[] = [];
    for (const tag of targets) {
      try {
        await updateTag(tag, patch, newWriteKey("tag-bulk-edit"));
        ok += 1;
      } catch (e) {
        nextFailed.push(tag.id);
        if (isTagVersionConflict(e)) conflict = true;
        firstError ??= apiErrorMessage(e, "The update was refused");
      }
      if (mounted.current)
        setProgress({
          done: ok + nextFailed.length,
          failed: nextFailed.length,
        });
    }
    await onSettled({ ok, failedIds: nextFailed, conflict });
    if (!mounted.current) return;
    setBusy(false);
    if (nextFailed.length > 0) {
      setFailedIds(nextFailed);
      setLastError(firstError);
      toast.error(
        `Updated ${ok}; ${nextFailed.length} failed. Only failed tags remain selected for retry.${
          conflict
            ? " Some tags changed on the server; the catalogue was reloaded."
            : ""
        }`,
      );
      return;
    }
    setFailedIds([]);
    toast.success(`Updated ${ok} tag${ok === 1 ? "" : "s"}`);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>
            Edit {tags.length} tag{tags.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Tick a field to include it in the patch. Untouched fields stay as
            they are on each tag; every tag is updated against its own exact
            version.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <label className="flex items-center gap-2 font-medium">
              <Checkbox
                checked={applyColor}
                disabled={busy}
                onChange={(e) => setApplyColor(e.target.checked)}
              />
              Set colour
            </label>
            <TagColorPalette
              id="bulk-tag-color"
              value={color}
              onChange={setColor}
              disabled={!applyColor || busy}
            />
          </div>
          <div className="grid gap-2">
            <label className="flex items-center gap-2 font-medium">
              <Checkbox
                checked={applyDescription}
                disabled={busy}
                onChange={(e) => setApplyDescription(e.target.checked)}
              />
              Set description
            </label>
            <Label htmlFor="bulk-tag-description" className="sr-only">
              Description
            </Label>
            <Textarea
              id="bulk-tag-description"
              rows={3}
              maxLength={1024}
              value={description}
              disabled={!applyDescription || busy}
              placeholder="What does this tag mean? Who should get it?"
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {runeLength(description).toLocaleString()} / 1,024. An empty
              description clears it on every selected tag.
            </p>
          </div>
          {busy ? (
            <p role="status" className="text-sm">
              Updating… {progress.done} of {targets.length} ({progress.failed}{" "}
              failed)
            </p>
          ) : null}
          {!busy && failedIds.length > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {failedIds.length} tag{failedIds.length === 1 ? "" : "s"} failed
              {lastError ? `: ${lastError}` : "."} Retry only those tags.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canApply} onClick={submit}>
            {busy
              ? "Applying…"
              : failedIds.length > 0
                ? `Retry ${targets.length} failed tag${targets.length === 1 ? "" : "s"}`
                : `Apply to ${targets.length} tag${targets.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
