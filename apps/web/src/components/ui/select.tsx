// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Shared Select primitive — a styled native `<select>`. Chosen over a
 * from-scratch listbox so keyboard navigation, type-ahead, focus, and mobile
 * pickers come from the platform for free (and stay accessible), while every
 * screen gets ONE consistent look/height/focus-ring matching `Input`. Replaces
 * the ad-hoc `<select className="h-10 rounded-md border …">` copies scattered
 * across the subscriber dialog and paid-members filter.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select">
>(({ className, children, ...props }, ref) => {
  return (
    <div className="relative">
      <select
        ref={ref}
        data-slot="select"
        className={cn(
          "flex h-11 w-full appearance-none rounded-[8px_11px_8px_11px] border border-[color:rgb(32_32_30_/_0.22)] bg-card px-3 py-1 pr-8 text-base shadow-[1px_2px_0_rgb(32_32_30_/_0.06)] transition-[color,border-color,box-shadow] sm:h-9 sm:text-sm [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base",
          "hover:border-ring/40 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronsUpDown
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  );
});
Select.displayName = "Select";

export { Select };
