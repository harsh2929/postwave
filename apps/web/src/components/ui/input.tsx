// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        data-slot="input"
        type={type}
        className={cn(
          "flex h-11 w-full rounded-[8px_11px_8px_11px] border border-[color:rgb(32_32_30_/_0.22)] bg-card px-3 py-1 text-base shadow-[1px_2px_0_rgb(32_32_30_/_0.06)] transition-[color,border-color,box-shadow] file:border-0 file:bg-transparent file:text-base file:font-medium file:text-foreground placeholder:text-muted-foreground sm:h-9 sm:text-sm sm:file:text-sm [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base [@media(pointer:coarse)]:file:text-base",
          "hover:border-ring/40 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
