// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared icon-only button (FLOW-044). Wraps the shared `Button` at its `icon`
// size and REQUIRES an `aria-label`, replacing the ad-hoc "✕" text buttons
// scattered across the flow editor / version rail / config panel — which had
// no accessible name and inconsistent focus/hover/dark-mode styling. Keeping it
// on top of Button means one focus ring, one hover token, one dark-mode story.
import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface IconButtonProps extends Omit<ButtonProps, "size"> {
  /** Required: icon-only buttons have no text, so they need an accessible name. */
  "aria-label": string;
  /** Slightly smaller footprint for dense toolbars/rails. */
  size?: "sm" | "default";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant = "ghost", size = "default", ...props }, ref) => {
    return (
      <Button
        ref={ref}
        type={props.type ?? "button"}
        variant={variant}
        size="icon"
        className={cn(size === "sm" && "h-7 w-7", className)}
        {...props}
      />
    );
  },
);
IconButton.displayName = "IconButton";
