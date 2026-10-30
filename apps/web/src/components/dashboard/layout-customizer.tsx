// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface LayoutCustomizerItem {
  key: string;
  label: string;
}

interface LayoutCustomizerProps {
  items: readonly LayoutCustomizerItem[];
  visibleKeys: readonly string[];
  description: string;
  panelLabel: string;
  leading?: ReactNode;
  loadError?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  compact?: boolean;
  className?: string;
  triggerClassName?: string;
  onReload?: () => Promise<unknown> | unknown;
  onSave: (order: string[]) => Promise<unknown>;
}

interface DraftItem extends LayoutCustomizerItem {
  visible: boolean;
}

function buildDraft(
  items: readonly LayoutCustomizerItem[],
  visibleKeys: readonly string[],
): DraftItem[] {
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const visible = visibleKeys
    .map((key) => itemByKey.get(key))
    .filter((item): item is LayoutCustomizerItem => Boolean(item));
  const visibleSet = new Set(visible.map((item) => item.key));
  return [
    ...visible.map((item) => ({ ...item, visible: true })),
    ...items
      .filter((item) => !visibleSet.has(item.key))
      .map((item) => ({ ...item, visible: false })),
  ];
}

export function LayoutCustomizer({
  items,
  visibleKeys,
  description,
  panelLabel,
  leading,
  loadError = false,
  disabled = false,
  disabledReason,
  compact = false,
  className,
  triggerClassName,
  onReload,
  onSave,
}: LayoutCustomizerProps) {
  const panelId = useId();
  const disabledReasonId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const saveLockRef = useRef(false);
  const reloadLockRef = useRef(false);
  const previousLoadErrorRef = useRef(loadError);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [pending, setPending] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (open && previousLoadErrorRef.current && !loadError) {
      setDraft(buildDraft(items, visibleKeys));
      setAnnouncement("Saved layout loaded. You can now customize it.");
    }
    previousLoadErrorRef.current = loadError;
  }, [items, loadError, open, visibleKeys]);

  useEffect(() => {
    if (saveError) errorRef.current?.focus();
  }, [saveError]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setDraft([]);
    setSaveError(null);
    setAnnouncement("");
  }, [disabled]);

  function restoreTriggerFocus() {
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function closePanel() {
    if (pending || reloading) return;
    setOpen(false);
    setSaveError(null);
    setAnnouncement("");
    restoreTriggerFocus();
  }

  function togglePanel() {
    if (disabled) return;
    if (open) {
      closePanel();
      return;
    }
    setDraft(buildDraft(items, visibleKeys));
    setSaveError(null);
    setAnnouncement("");
    setOpen(true);
  }

  function toggleItem(key: string) {
    setDraft((current) =>
      current.map((item) =>
        item.key === key ? { ...item, visible: !item.visible } : item,
      ),
    );
  }

  function moveItem(index: number, direction: -1 | 1) {
    setDraft((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const moved = next[index];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      if (moved) {
        setAnnouncement(
          `${moved.label} moved to position ${nextIndex + 1} of ${next.length}.`,
        );
      }
      return next;
    });
  }

  function restoreDefaults() {
    setDraft(items.map((item) => ({ ...item, visible: true })));
    setSaveError(null);
    setAnnouncement(
      "Default order restored in this draft. Save the layout to apply it.",
    );
  }

  async function reloadLayout() {
    if (disabled || !onReload || reloadLockRef.current) return;
    reloadLockRef.current = true;
    setReloading(true);
    setSaveError(null);
    try {
      await onReload();
    } finally {
      reloadLockRef.current = false;
      setReloading(false);
    }
  }

  async function saveLayout() {
    const order = draft.filter((item) => item.visible).map((item) => item.key);
    if (disabled || order.length === 0 || loadError || saveLockRef.current)
      return;
    saveLockRef.current = true;
    setPending(true);
    setSaveError(null);
    try {
      await onSave(order);
      setOpen(false);
      setAnnouncement("");
      restoreTriggerFocus();
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "The layout could not be saved. Try again.",
      );
    } finally {
      saveLockRef.current = false;
      setPending(false);
    }
  }

  return (
    <div
      className={cn(
        "relative min-w-0",
        compact ? "shrink-0" : "w-full",
        className,
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        {leading}
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "ml-auto min-h-11 shrink-0 sm:min-h-8",
            triggerClassName,
          )}
          onClick={togglePanel}
          disabled={disabled}
          aria-expanded={open}
          aria-controls={panelId}
          aria-describedby={
            disabled && disabledReason ? disabledReasonId : undefined
          }
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          Customize
        </Button>
      </div>

      {disabled && disabledReason ? (
        <p
          id={disabledReasonId}
          className={cn(
            "mt-1 text-xs text-muted-foreground",
            compact && "sr-only",
          )}
        >
          {disabledReason}
        </p>
      ) : null}

      {open ? (
        <div
          id={panelId}
          role="region"
          aria-label={panelLabel}
          aria-busy={pending || reloading || undefined}
          className={cn(
            "mt-3 min-w-0 rounded-[14px_18px_14px_18px] border border-mw-ink/25 bg-card p-3 text-card-foreground shadow-[4px_5px_0_rgb(32_32_30_/_0.18)]",
            compact &&
              "absolute right-0 top-full z-40 w-[min(32rem,calc(100vw-2rem))]",
          )}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            closePanel();
          }}
        >
          <p className="mb-2 text-xs text-muted-foreground">{description}</p>

          {loadError ? (
            <div
              role="alert"
              className="mb-3 flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis sm:flex-row sm:items-center sm:justify-between"
            >
              <span>
                Your saved layout could not be loaded. Reload it before making
                changes so an unknown layout is never overwritten.
              </span>
              {onReload ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 shrink-0 sm:min-h-9"
                  loading={reloading}
                  onClick={() => void reloadLayout()}
                >
                  {reloading ? "Reloading…" : "Reload layout"}
                </Button>
              ) : null}
            </div>
          ) : null}

          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>

          <ul className="space-y-1">
            {draft.map((item, index) => (
              <li
                key={item.key}
                className="flex min-w-0 items-center gap-1 rounded px-1 py-1 text-sm sm:gap-2"
              >
                <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                  <Checkbox
                    checked={item.visible}
                    disabled={disabled || pending || reloading || loadError}
                    onChange={() => toggleItem(item.key)}
                    aria-label={`Show ${item.label}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 sm:h-8 sm:w-8"
                  onClick={() => moveItem(index, -1)}
                  disabled={
                    disabled || pending || reloading || loadError || index === 0
                  }
                  aria-label={`Move ${item.label} up`}
                >
                  <ChevronUp className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 sm:h-8 sm:w-8"
                  onClick={() => moveItem(index, 1)}
                  disabled={
                    pending ||
                    reloading ||
                    disabled ||
                    loadError ||
                    index === draft.length - 1
                  }
                  aria-label={`Move ${item.label} down`}
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>

          {saveError ? (
            <div
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Couldn&apos;t save your layout. {saveError}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={restoreDefaults}
              disabled={disabled || pending || reloading || loadError}
            >
              Restore defaults
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={closePanel}
              disabled={disabled || pending || reloading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-8"
              loading={pending}
              onClick={() => void saveLayout()}
              disabled={
                disabled ||
                loadError ||
                draft.every((item) => !item.visible) ||
                pending
              }
            >
              {pending ? "Saving layout…" : "Save layout"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
