// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import type { TagRecord } from "@/lib/audience-admin-api";
import { mergeTags, type TagUsage } from "@/lib/tags-api";
import { tagIdentityKey } from "../tag-catalogue-model";
import {
  mergePlanCopy,
  mergeResultToastCopy,
  type MergeOutcome,
} from "../merge-tags-model";

/**
 * MergeTagsDialog — pick one or more source tags and a destination, confirm,
 * fire the merges. Desktop parity audience-103
 * (apps/desktop/src/components/tags/MergeTagsDialog.tsx).
 *
 * The taxonomy merge endpoint takes one `from` per call, so N sources fan
 * out as N sequential POSTs against the same `into`. A confirm step sits
 * between "Merge" and the request(s), citing the predicted affected count
 * from the usage map (labelled as approximate). The result toast reads the
 * server's real `subscribers_updated` field and says when it was absent.
 *
 * The page only opens this dialog while `TAG_MERGE_AVAILABLE` is true; the
 * transport itself refuses to send while merge is release-held.
 */
export function MergeTagsDialog({
  open,
  tags,
  usage,
  initialFrom,
  authorize,
  onClose,
  onMerged,
}: {
  open: boolean;
  /** All registered tag rows so the pickers can show options. */
  tags: TagRecord[];
  /** Usage map (identity key → usage) when present, surfaces counts inline. */
  usage?: ReadonlyMap<string, TagUsage>;
  /** Pre-selected source tag names (from a row / the bulk bar). */
  initialFrom?: readonly string[];
  /** Fresh identity check before the first request leaves. */
  authorize: () => Promise<void>;
  onClose: () => void;
  onMerged: () => void | Promise<void>;
}) {
  const [sources, setSources] = useState<ReadonlySet<string>>(new Set());
  const [into, setInto] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const intoId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reset on open so re-opening from a different row picks up the new initial.
  useEffect(() => {
    if (!open) return;
    setSources(new Set((initialFrom ?? []).filter(Boolean)));
    setInto("");
    setConfirming(false);
    setSubmitting(false);
    inFlight.current = false;
  }, [open, initialFrom]);

  const sourceNames = useMemo(
    () => tags.filter((t) => sources.has(t.name)).map((t) => t.name),
    [tags, sources],
  );
  const valid = sourceNames.length > 0 && Boolean(into) && !sources.has(into);
  const plan = valid ? mergePlanCopy(sourceNames, into, usage) : null;

  function toggleSource(name: string) {
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    // Picking a tag as a source disqualifies it as the destination.
    if (into === name) setInto("");
  }

  async function submit() {
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    const outcomes: MergeOutcome[] = [];
    try {
      await authorize();
      for (const from of sourceNames) {
        try {
          const receipt = await mergeTags({ from, into });
          outcomes.push({
            from,
            ok: true,
            subscribersUpdated: receipt.subscribers_updated,
          });
        } catch (e) {
          outcomes.push({
            from,
            ok: false,
            error: apiErrorMessage(e, "request failed"),
          });
        }
      }
    } catch (e) {
      // The identity check failed: nothing was sent for any source.
      toast.error(apiErrorMessage(e, "Merge could not start"));
      return;
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setSubmitting(false);
        setConfirming(false);
      }
    }
    if (!mounted.current) return;
    const copy = mergeResultToastCopy(into, outcomes);
    if (copy.ok) toast.success(copy.message, { description: copy.detail });
    else toast.error(copy.message, { description: copy.detail });
    // Any success changed subscriber data — let the page refresh even if
    // some sources failed.
    if (outcomes.some((o) => o.ok)) {
      await onMerged();
      if (mounted.current) onClose();
    }
  }

  const countFor = (name: string): number | null =>
    usage?.get(tagIdentityKey(name))?.subscribers ?? null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v && !submitting && !confirming) onClose();
        }}
      >
        <DialogContent closeDisabled={submitting || confirming}>
          <DialogHeader>
            <DialogTitle>Merge tags</DialogTitle>
            <DialogDescription>
              A successful merge removes every source tag from the catalogue.
              The exact subscriber count is confirmed by the server after the
              merge.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <fieldset className="grid gap-1">
              <legend className="text-sm font-medium">From</legend>
              <div
                role="group"
                aria-label="Source tags"
                tabIndex={0}
                className="max-h-48 overflow-y-auto rounded-md border p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {tags.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No registered tags to merge.
                  </p>
                ) : (
                  tags.map((t) => {
                    const isTarget = t.name === into;
                    const count = countFor(t.name);
                    return (
                      <label
                        key={t.id}
                        className={
                          "flex items-center gap-2 px-1 py-0.5 text-sm" +
                          (isTarget ? " opacity-50" : "")
                        }
                        title={
                          isTarget
                            ? "Already picked as the destination"
                            : undefined
                        }
                      >
                        <Checkbox
                          checked={sources.has(t.name)}
                          disabled={isTarget || submitting}
                          onChange={() => toggleSource(t.name)}
                        />
                        <span className="min-w-0 truncate">{t.name}</span>
                        {count !== null ? (
                          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {count.toLocaleString()}
                          </span>
                        ) : null}
                      </label>
                    );
                  })
                )}
              </div>
            </fieldset>
            <Label htmlFor={intoId}>Into</Label>
            <Select
              id={intoId}
              value={into}
              disabled={submitting}
              onChange={(e) => setInto(e.target.value)}
            >
              <option value="">Pick a destination tag…</option>
              {tags.map((t) => {
                const count = countFor(t.name);
                return (
                  <option
                    key={t.id}
                    value={t.name}
                    disabled={sources.has(t.name)}
                  >
                    {t.name}
                    {count !== null ? ` (${count.toLocaleString()})` : ""}
                  </option>
                );
              })}
            </Select>
            {plan ? (
              <p role="status" className="text-sm text-muted-foreground">
                Will move ~<strong>{plan.predicted.toLocaleString()}</strong>{" "}
                subscriber{plan.predicted === 1 ? "" : "s"} from{" "}
                <strong>{sourceNames.join(", ")}</strong> into{" "}
                <strong>{into}</strong>. The exact count is confirmed by the
                server after the merge.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={submitting || confirming}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              disabled={submitting || !valid}
              onClick={() => setConfirming(true)}
            >
              {sourceNames.length > 1
                ? `Merge ${sourceNames.length} tags…`
                : "Merge tags…"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirming && valid}
        onOpenChange={(v) => {
          if (!v && !submitting) setConfirming(false);
        }}
        title={plan?.title ?? "Merge tags?"}
        description={plan?.description ?? ""}
        confirmLabel={submitting ? "Merging…" : "Merge"}
        onConfirm={submit}
      />
    </>
  );
}
