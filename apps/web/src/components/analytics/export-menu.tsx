// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Export menu for the Analytics page (desktop ExportMenu):
//   * CSV snapshot — the page's existing stats CSV (passed in, so the export
//     stays owned by lib/analytics-format's buildStatsCsv);
//   * Print / PDF  — the browser's print dialog, where "Save as PDF" lives.
//
// The dashboard shell is a fixed-height, overflow-hidden frame with its own
// scrolling <main>, so a bare window.print() would print one screenful. The
// print stylesheet below (active only while this menu is mounted, i.e. on the
// Analytics page) unclips the frame, drops the sidebar / header / controls,
// and keeps each card on one page.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FileSpreadsheet, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const ANALYTICS_PRINT_CSS = `
@media print {
  @page { margin: 12mm; }
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  [data-dashboard-hydrated], [data-dashboard-hydrated] > div, #main-content {
    height: auto !important; min-height: 0 !important; overflow: visible !important; display: block !important;
  }
  aside, header[role="banner"], [data-sonner-toaster], [data-print-hide],
  #main-content [data-slot="button"], #main-content [data-slot="select"],
  #main-content [role="tablist"], #main-content [aria-haspopup] {
    display: none !important;
  }
  [data-slot="card"], #main-content section { break-inside: avoid; page-break-inside: avoid; box-shadow: none !important; }
}
`;

/** Open the system print dialog once the menu has closed. */
export function printAnalytics(): void {
  // Deferred so the closing menu is not what gets printed.
  window.setTimeout(() => window.print(), 50);
}

interface ExportItem {
  key: string;
  label: string;
  detail: string;
  icon: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

export function AnalyticsExportMenu({
  onExportCsv,
  csvDisabled = false,
}: {
  /** Omit to offer Print / PDF only. */
  onExportCsv?: () => void;
  /** e.g. while the stats are still loading. */
  csvDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const items: ExportItem[] = [
    ...(onExportCsv
      ? [
          {
            key: "csv",
            label: "CSV snapshot",
            detail: csvDisabled
              ? "Available once the stats have loaded"
              : "Tenant-wide stats for this window",
            icon: <FileSpreadsheet className="h-4 w-4" aria-hidden />,
            disabled: csvDisabled,
            onSelect: onExportCsv,
          },
        ]
      : []),
    {
      key: "print",
      label: "Print / PDF",
      detail: "Opens the print dialog — choose Save as PDF there",
      icon: <Printer className="h-4 w-4" aria-hidden />,
      onSelect: printAnalytics,
    },
  ];

  useEffect(() => {
    if (!open) return;
    const nodes = () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not([disabled])',
        ) ?? [],
      );
    nodes()[0]?.focus();
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const list = nodes();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "ArrowDown"
          ? (index + 1) % list.length
          : (index - 1 + list.length) % list.length;
      list[next]?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block text-left">
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-8"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Export
        <ChevronDown className="h-4 w-4" aria-hidden />
      </Button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Export analytics"
          className="absolute right-0 z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-1 shadow-pw-lg"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
                item.onSelect();
              }}
              className={cn(
                "flex min-h-11 w-full items-start gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm sm:min-h-9",
                "hover:bg-accent focus:bg-accent focus-visible:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <span className="mt-0.5 text-muted-foreground">{item.icon}</span>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{item.label}</span>
                <span className="text-xs text-muted-foreground">
                  {item.detail}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <style>{ANALYTICS_PRINT_CSS}</style>
    </div>
  );
}
