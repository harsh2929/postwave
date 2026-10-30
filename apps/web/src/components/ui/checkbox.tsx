// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shared Checkbox primitive — a styled native `<input type="checkbox">` so
 * keyboard, focus, and mobile behaviour come from the platform while every
 * surface gets one consistent look/focus-ring. `indeterminate` is a DOM-only
 * property (not a React attribute), so we set it imperatively. Replaces the
 * ad-hoc `<input type="checkbox" className="…accent-primary">` copies across
 * the subscriber and campaign lists.
 */
export interface CheckboxProps extends Omit<
  React.ComponentProps<"input">,
  "type"
> {
  indeterminate?: boolean;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate, ...props }, ref) => {
    const innerRef = React.useRef<HTMLInputElement>(null);
    React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);
    React.useEffect(() => {
      if (innerRef.current)
        innerRef.current.indeterminate = Boolean(indeterminate);
    }, [indeterminate]);
    return (
      <input
        ref={innerRef}
        data-slot="checkbox"
        type="checkbox"
        className={cn(
          "h-4 w-4 cursor-pointer rounded border-mw-ink/30 accent-[color:var(--mw-blue)] align-middle",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
