// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  archiveSequence,
  duplicateSequence,
  unarchiveSequence,
} from "@/lib/voice-api";
import { isEditableSequenceDraft } from "@/lib/sequence-operational-availability";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { asRoute } from "@/lib/typed-routes";
import type { SequenceStatus } from "@/lib/voice-types";
import { cn } from "@/lib/utils";

export interface RowActionsProps {
  id: string;
  status: SequenceStatus;
  /** Called after a mutation so a client list can refresh without a full nav. */
  onChanged?: () => void;
}

export function SequenceRowActionsMenu({
  id,
  status,
  onChanged,
  initialOpen = false,
}: RowActionsProps & { initialOpen?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(initialOpen);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archiveOpenRef = useRef(false);
  archiveOpenRef.current = archiveOpen;
  const [pending, setPending] = useState<
    "duplicate" | "archive" | "unarchive" | null
  >(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const canArchive = isEditableSequenceDraft(status);
  const isArchived = status === "archived";

  function refresh() {
    if (onChanged) onChanged();
    else router.refresh();
  }

  // Roving-focus + Escape + click-outside for a real menu (SEQ-010).
  useEffect(() => {
    if (!open) return;
    const items = () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
          [],
      ).filter((el) => !el.hasAttribute("disabled"));
    // Focus the first item on open.
    const first = items()[0];
    first?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      // The confirmation is portalled outside this menu. It owns its keyboard
      // events until it closes; otherwise Escape/arrows can unmount it here.
      if (archiveOpenRef.current) return;
      const list = items();
      const idx = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        list[(idx + 1) % list.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        list[(idx - 1 + list.length) % list.length]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        list[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        list[list.length - 1]?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      // A pointer inside the portalled dialog must not dismiss its parent
      // menu before the confirmation button's click handler can run.
      if (archiveOpenRef.current) return;
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  async function handleDuplicate() {
    if (pending) return;
    setPending("duplicate");
    try {
      const copy = await duplicateSequence(id);
      toast.success(`Duplicated as “${copy.name}”`, {
        action: {
          label: "Open",
          onClick: () => router.push(asRoute(`/app/sequences/${copy.id}`)),
        },
      });
      setOpen(false);
      refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn’t duplicate sequence",
      );
    } finally {
      setPending(null);
    }
  }

  async function handleArchive() {
    if (pending || !canArchive) return;
    setPending("archive");
    try {
      await archiveSequence(id);
      setOpen(false);
      toast.success("Sequence archived", {
        action: {
          label: "Undo",
          onClick: () => void handleUnarchive(),
        },
      });
      refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn’t archive sequence",
      );
    } finally {
      setPending(null);
    }
  }

  async function handleUnarchive() {
    if (pending) return;
    setPending("unarchive");
    try {
      await unarchiveSequence(id);
      setOpen(false);
      toast.success("Sequence restored to draft");
      refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn’t restore sequence",
      );
    } finally {
      setPending(null);
    }
  }

  const itemClass =
    "flex min-h-11 w-full items-center px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

  return (
    <div className="relative inline-block text-left">
      <IconButton
        ref={triggerRef}
        size="sm"
        aria-label="Open actions menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Sequence actions"
          className={cn(
            "absolute right-0 z-40 mt-1 w-48 rounded-md border bg-popover py-1 text-popover-foreground shadow-md",
          )}
        >
          <Link
            role="menuitem"
            href={`/app/sequences/${id}`}
            className={itemClass}
            onClick={() => setOpen(false)}
          >
            Open
          </Link>
          <button
            type="button"
            role="menuitem"
            disabled={pending !== null}
            className={itemClass}
            onClick={handleDuplicate}
          >
            {pending === "duplicate" ? "Duplicating…" : "Duplicate"}
          </button>
          {isArchived ? (
            <button
              type="button"
              role="menuitem"
              disabled={pending !== null}
              className={itemClass}
              onClick={handleUnarchive}
            >
              {pending === "unarchive" ? "Restoring…" : "Restore to draft"}
            </button>
          ) : (
            <ConfirmDialog
              open={archiveOpen}
              onOpenChange={setArchiveOpen}
              trigger={
                <button
                  type="button"
                  role="menuitem"
                  disabled={pending !== null || !canArchive}
                  className={cn(itemClass, "text-destructive")}
                  title={
                    canArchive
                      ? "Archive this draft"
                      : "Only confirmed drafts can be archived"
                  }
                >
                  {canArchive ? "Archive" : "Archive unavailable"}
                </button>
              }
              title="Archive this sequence?"
              description="Archiving moves this draft out of your working set and makes it read-only. You can restore it to a draft later, or use Undo right after."
              confirmLabel="Archive"
              onConfirm={handleArchive}
            />
          )}
        </div>
      )}
    </div>
  );
}
