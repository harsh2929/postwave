// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shared table primitives — every list surface (recent migrations, the
 * verification report, …) hand-rolled its own `<table>`/`<thead>` markup, so
 * borders, header colour, and hover drifted per surface (MIGR-034). These give
 * one consistent look while staying thin wrappers over the native elements, so
 * semantics and accessibility come from the platform. Wrap in `TableContainer`
 * for the rounded border + horizontal scroll on narrow viewports.
 */
export function TableContainer({
  className,
  children,
  tabIndex = 0,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const resolvedLabel =
    ariaLabel ?? (ariaLabelledBy ? undefined : "Scrollable data table");

  return (
    <div
      {...props}
      role="region"
      tabIndex={tabIndex}
      aria-label={resolvedLabel}
      aria-labelledby={ariaLabelledBy}
      data-slot="table-container"
      className={cn(
        "overflow-x-auto rounded-[12px_16px_12px_16px] border border-[color:rgb(32_32_30_/_0.18)] bg-card shadow-[2px_3px_0_rgb(32_32_30_/_0.07)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Table({
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table
      data-slot="table"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  );
}

export function TableHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        "border-b border-[color:rgb(32_32_30_/_0.18)] bg-[color:rgb(255_223_56_/_0.18)] text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TableBody(
  props: React.HTMLAttributes<HTMLTableSectionElement>,
) {
  return <tbody data-slot="table-body" {...props} />;
}

export function TableRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-[color:rgb(32_32_30_/_0.1)] transition-colors last:border-0",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      // Column association by default — a header cell in this primitive is
      // always a column header. Callers that need a row header pass
      // scope="row", which wins because the spread comes after.
      scope="col"
      data-slot="table-head"
      className={cn(
        "px-4 py-2.5 text-left text-[0.7rem] font-semibold uppercase tracking-[0.1em]",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-4 py-3 align-middle", className)}
      {...props}
    />
  );
}
