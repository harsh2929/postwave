// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CalendarRange } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SuppressionDateRange {
  /** Inclusive local calendar day, YYYY-MM-DD, or "" for no lower bound. */
  from: string;
  /** Inclusive local calendar day, YYYY-MM-DD, or "" for no upper bound. */
  to: string;
}

export const EMPTY_SUPPRESSION_DATE_RANGE: SuppressionDateRange = {
  from: "",
  to: "",
};

function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Trigger label: "Any time", "From …", "Until …", or "… – …". */
export function suppressionDateRangeLabel(range: SuppressionDateRange): string {
  if (!range.from && !range.to) return "Any time";
  if (range.from && range.to) return `${range.from} – ${range.to}`;
  return range.from ? `From ${range.from}` : `Until ${range.to}`;
}

/** The end date may not precede the start date. */
export function suppressionDateRangeError(
  from: string,
  to: string,
): string | null {
  return from && to && from > to
    ? "The end date must be on or after the start date."
    : null;
}

/**
 * Client-side "date added" filter over the loaded page, comparing the row's
 * local calendar day with the inclusive bounds. A row whose timestamp cannot
 * be parsed only survives when no bound is set — an unparseable date must not
 * pass a filter it cannot be checked against.
 */
export function suppressionWithinDateRange(
  createdAt: string,
  range: SuppressionDateRange,
): boolean {
  if (!range.from && !range.to) return true;
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return false;
  const day = localDay(parsed);
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}

/**
 * Compact date-added filter (desktop parity with DateRangePopover). The panel
 * holds a draft so Cancel/Escape discard edits; Apply commits both bounds at
 * once; Clear removes the filter. Stays local view state — the server list
 * has no date parameter, so this never touches the URL or the query key.
 */
export function SuppressionDateRangeFilter({
  value,
  onChange,
}: {
  value: SuppressionDateRange;
  onChange: (next: SuppressionDateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(value.from);
  const [draftTo, setDraftTo] = useState(value.to);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const panelId = useId();
  const fromId = useId();
  const toId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) return;
    setDraftFrom(value.from);
    setDraftTo(value.to);
    const frame = window.requestAnimationFrame(() =>
      firstFieldRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open, value.from, value.to]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const active = Boolean(value.from || value.to);
  const label = suppressionDateRangeLabel(value);
  const draftError = suppressionDateRangeError(draftFrom, draftTo);

  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const apply = (): void => {
    if (draftError) return;
    onChange({ from: draftFrom, to: draftTo });
    close(true);
  };
  const clear = (): void => {
    setDraftFrom("");
    setDraftTo("");
    onChange(EMPTY_SUPPRESSION_DATE_RANGE);
    close(true);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <Button
        ref={triggerRef}
        type="button"
        variant={active ? "secondary" : "outline"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Filter by date added: ${label}`}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <CalendarRange className="h-4 w-4" />
        Added: {label}
      </Button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-label="Filter by date added"
          className="absolute left-0 top-full z-20 mt-1 w-72 space-y-3 rounded-md border bg-background p-3 shadow-md"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }}
        >
          <p className="text-sm font-medium">Filter by date added</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={fromId}>From</Label>
              <Input
                ref={firstFieldRef}
                id={fromId}
                type="date"
                value={draftFrom}
                max={draftTo || undefined}
                aria-invalid={draftError ? true : undefined}
                aria-describedby={draftError ? errorId : undefined}
                onChange={(event) => setDraftFrom(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={toId}>To</Label>
              <Input
                id={toId}
                type="date"
                value={draftTo}
                min={draftFrom || undefined}
                aria-invalid={draftError ? true : undefined}
                aria-describedby={draftError ? errorId : undefined}
                onChange={(event) => setDraftTo(event.target.value)}
              />
            </div>
          </div>
          {draftError ? (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {draftError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={clear}
              disabled={!active && !draftFrom && !draftTo}
            >
              Clear
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => close(true)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={apply}
              disabled={Boolean(draftError)}
            >
              Apply
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
