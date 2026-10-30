// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";

import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        "flex min-h-[96px] w-full rounded-[10px_14px_10px_14px] border border-[color:rgb(32_32_30_/_0.22)] bg-card px-3 py-2 text-base shadow-[1px_2px_0_rgb(32_32_30_/_0.06)] transition-[color,border-color,box-shadow] placeholder:text-muted-foreground sm:min-h-[80px] sm:text-sm [@media(pointer:coarse)]:min-h-[96px] [@media(pointer:coarse)]:text-base",
        "hover:border-ring/40 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
