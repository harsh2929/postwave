// SPDX-License-Identifier: AGPL-3.0-only
//
// A single flow on the index grid, enriched (FLOW-022) with a trigger summary,
// relative updated-at, and an enrollment figure, plus per-card row actions
// (FLOW-006): rename, duplicate, archive-as-delete, copy link, and a pin
// (FLOW-046). Status uses a semantic badge (FLOW-014). The card is no longer a
// single <Link> so the actions are independently focusable/clickable.
"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  Copy,
  Link2,
  Pencil,
  RotateCcw,
  Star,
  Tags,
  Trash2,
} from "lucide-react";

import type { CatalogItem, Flow } from "@/lib/flows-api";
import { flowStatusBadgeVariant, triggerSummary } from "@/lib/flow-graph";
import { readFlowMetrics, formatMetricNumber } from "@/lib/flow-analytics";
import { parseTagInput } from "@/lib/use-flow-tags";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RelativeTime } from "@/components/relative-time";
import { cn } from "@/lib/utils";

export function FlowListCard({
  flow,
  triggerCatalog,
  pinned,
  onTogglePin,
  onRename,
  onDuplicate,
  onArchive,
  onRestore,
  onCopyLink,
  tags,
  onSetTags,
  canWrite = true,
  writeDisabledReason,
}: {
  flow: Flow;
  triggerCatalog: CatalogItem[];
  pinned: boolean;
  onTogglePin: (id: string) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onDuplicate: (flow: Flow) => void;
  onArchive: (flow: Flow) => void;
  onRestore: (flow: Flow) => void;
  onCopyLink: (flow: Flow) => void;
  tags: string[];
  onSetTags: (id: string, tags: string[]) => void;
  canWrite?: boolean;
  writeDisabledReason?: string;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(flow.name);
  const [taggingOpen, setTaggingOpen] = useState(false);
  const [draftTags, setDraftTags] = useState("");
  const [renameWorking, setRenameWorking] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameGuard = useRef(false);
  const tagGuard = useRef(false);

  const steps = flow.graph.nodes?.length ?? 0;
  const metrics = readFlowMetrics(flow.analytics);
  const enrolled = metrics.active ?? metrics.entered;
  const normalizedDraftTags = parseTagInput(draftTags);
  const tagsDirty =
    normalizedDraftTags.length !== tags.length ||
    normalizedDraftTags.some((tag, index) => tag !== tags[index]);

  function submitTags() {
    if (tagGuard.current || !tagsDirty) return;
    tagGuard.current = true;
    onSetTags(flow.id, normalizedDraftTags);
    setTaggingOpen(false);
  }

  async function submitRename() {
    const trimmed = draftName.trim();
    if (
      renameGuard.current ||
      renameWorking ||
      !canWrite ||
      !trimmed ||
      trimmed === flow.name
    )
      return;
    renameGuard.current = true;
    setRenameWorking(true);
    setRenameError(null);
    try {
      await onRename(flow.id, trimmed);
      setRenaming(false);
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : "Could not rename flow.",
      );
    } finally {
      renameGuard.current = false;
      setRenameWorking(false);
    }
  }

  return (
    <div className="group relative rounded-lg border border-border bg-card p-4 transition hover:border-primary/60 hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/app/flows/${encodeURIComponent(flow.id)}`}
          className="inline-flex min-h-8 min-w-0 items-center font-medium text-foreground hover:text-primary"
        >
          <span className="line-clamp-2 break-words">
            {flow.name || "Untitled flow"}
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip
            label={pinned ? "Unpin" : "Pin to top"}
            className="[&[aria-hidden=true]]:hidden"
          >
            <IconButton
              size="sm"
              aria-label={pinned ? "Unpin flow" : "Pin flow"}
              aria-pressed={pinned}
              onClick={() => onTogglePin(flow.id)}
            >
              <Star
                className={cn(
                  "h-4 w-4",
                  pinned
                    ? "fill-warning text-warning-emphasis"
                    : "text-muted-foreground",
                )}
              />
            </IconButton>
          </Tooltip>
          <Badge variant={flowStatusBadgeVariant(flow.status)}>
            {flow.status}
          </Badge>
        </div>
      </div>

      <p className="mt-2 truncate text-xs text-muted-foreground">
        {triggerSummary(flow.graph, triggerCatalog)}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          {steps} step{steps === 1 ? "" : "s"} · v{flow.version}
        </span>
        {flow.updated_at ? (
          <>
            <span aria-hidden>·</span>
            <span>
              Updated <RelativeTime iso={flow.updated_at} />
            </span>
          </>
        ) : null}
        {enrolled !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <span>{formatMetricNumber(enrolled)} enrolled</span>
          </>
        ) : null}
      </div>

      {/* Tags (FLOW-046) — client-side labels for grouping/filtering. */}
      {tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex max-w-full break-all rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {/* Row actions — revealed on hover/focus-within so the card stays clean. */}
      <div className="mt-3 flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100">
        <Tooltip
          label={canWrite ? "Rename" : "Rename unavailable — read-only access"}
          className="[&[aria-hidden=true]]:hidden"
        >
          <IconButton
            size="sm"
            aria-label="Rename flow"
            disabled={!canWrite}
            title={!canWrite ? writeDisabledReason : undefined}
            onClick={() => {
              setDraftName(flow.name);
              setRenameError(null);
              renameGuard.current = false;
              setRenaming(true);
            }}
          >
            <Pencil className="h-4 w-4" />
          </IconButton>
        </Tooltip>
        <Tooltip label="Tags" className="[&[aria-hidden=true]]:hidden">
          <IconButton
            size="sm"
            aria-label="Edit tags"
            onClick={() => {
              setDraftTags(tags.join(", "));
              tagGuard.current = false;
              setTaggingOpen(true);
            }}
          >
            <Tags className="h-4 w-4" />
          </IconButton>
        </Tooltip>
        <Tooltip
          label={
            canWrite ? "Duplicate" : "Duplicate unavailable — read-only access"
          }
          className="[&[aria-hidden=true]]:hidden"
        >
          <IconButton
            size="sm"
            aria-label="Duplicate flow"
            disabled={!canWrite}
            title={!canWrite ? writeDisabledReason : undefined}
            onClick={() => onDuplicate(flow)}
          >
            <Copy className="h-4 w-4" />
          </IconButton>
        </Tooltip>
        <Tooltip label="Copy link" className="[&[aria-hidden=true]]:hidden">
          <IconButton
            size="sm"
            aria-label="Copy flow link"
            onClick={() => onCopyLink(flow)}
          >
            <Link2 className="h-4 w-4" />
          </IconButton>
        </Tooltip>
        {flow.status === "archived" ? (
          <Tooltip
            label="Restore to draft"
            className="[&[aria-hidden=true]]:hidden"
          >
            <IconButton
              size="sm"
              aria-label="Restore flow to draft"
              disabled={!canWrite}
              title={!canWrite ? writeDisabledReason : undefined}
              onClick={() => onRestore(flow)}
            >
              <RotateCcw className="h-4 w-4" />
            </IconButton>
          </Tooltip>
        ) : (
          <ConfirmDialog
            trigger={
              <IconButton
                size="sm"
                aria-label="Archive flow"
                disabled={!canWrite}
                title={!canWrite ? writeDisabledReason : undefined}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            }
            title={`Archive "${flow.name || "Untitled flow"}"?`}
            description="Archiving changes the stored status and hides this flow from the active list. Execution is already release-held, so this action does not prove or control subscriber processing. You can restore it to a draft afterwards. There is no hard delete — archive is how a flow is removed."
            confirmLabel="Archive flow"
            confirmVariant="destructive"
            onConfirm={() => onArchive(flow)}
          />
        )}
      </div>

      <Dialog
        open={taggingOpen}
        onOpenChange={(next) => {
          setTaggingOpen(next);
          if (!next) tagGuard.current = false;
        }}
      >
        <DialogContent className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
          <DialogHeader>
            <DialogTitle>Edit tags</DialogTitle>
            <DialogDescription>
              Add browser-private labels to organize and filter this flow.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`tags-${flow.id}`}>Tags (comma-separated)</Label>
            <Input
              id={`tags-${flow.id}`}
              value={draftTags}
              autoFocus
              maxLength={1_000}
              placeholder="welcome, promo, win-back"
              onChange={(e) => setDraftTags(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitTags();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Up to 12 labels are kept in this browser; spaces inside a label
              are preserved.
            </p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={submitTags} disabled={!tagsDirty}>
              Save tags
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renaming}
        onOpenChange={(next) => {
          if (!renameWorking) setRenaming(next);
        }}
      >
        <DialogContent
          aria-busy={renameWorking}
          className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
        >
          <DialogHeader>
            <DialogTitle>Rename flow</DialogTitle>
            <DialogDescription>
              Choose a clear name that distinguishes this journey in the flow
              list.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`rename-${flow.id}`}>Name</Label>
            <Input
              id={`rename-${flow.id}`}
              value={draftName}
              autoFocus
              maxLength={200}
              disabled={renameWorking}
              readOnly={!canWrite}
              aria-invalid={renameError ? true : undefined}
              aria-describedby={
                renameError ? `rename-${flow.id}-error` : undefined
              }
              onChange={(e) => {
                setDraftName(e.target.value);
                setRenameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitRename();
                }
              }}
            />
            {renameError ? (
              <p
                id={`rename-${flow.id}-error`}
                role="alert"
                className="text-xs text-destructive"
              >
                {renameError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={renameWorking}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => void submitRename()}
              loading={renameWorking}
              disabled={
                !canWrite ||
                renameWorking ||
                !draftName.trim() ||
                draftName.trim() === flow.name
              }
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
