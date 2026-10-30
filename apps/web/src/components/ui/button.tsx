// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { DisabledButtonSlot } from "@/components/ui/disabled-button-slot";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-pw-out active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
  {
    variants: {
      variant: {
        default: "mw-tactile bg-mw-yellow text-mw-ink",
        destructive:
          "bg-destructive-emphasis text-destructive-emphasis-foreground hover:bg-destructive-emphasis/90",
        outline:
          "border-[1.5px] border-[color:rgb(32_32_30_/_0.22)] bg-card shadow-[1px_2px_0_rgb(32_32_30_/_0.08)] hover:border-[color:var(--mw-blue)] hover:bg-[color:var(--mw-paper)] hover:text-mw-blue",
        secondary:
          "border border-[color:rgb(32_32_30_/_0.14)] bg-secondary text-secondary-foreground hover:bg-mw-pink-soft",
        ghost: "hover:bg-mw-pink-soft hover:text-mw-blue",
        link: "text-mw-blue underline-offset-4 hover:decoration-wavy hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows a spinner on native buttons and makes every rendered control busy
   *  and inoperable. `asChild` controls keep their single child, so they do
   *  not render the spinner, but are still guarded from activation. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      children,
      onClick,
      onClickCapture,
      tabIndex,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    const showSpinner = loading && !asChild;
    const blocked = Boolean(disabled || loading);

    if (asChild && blocked) {
      return (
        <DisabledButtonSlot
          data-slot="button"
          className={cn(buttonVariants({ variant, size, className }))}
          ref={ref as React.Ref<HTMLElement>}
          aria-disabled="true"
          data-disabled=""
          aria-busy={loading || undefined}
          tabIndex={-1}
          {...props}
        >
          {children}
        </DisabledButtonSlot>
      );
    }

    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={asChild ? undefined : blocked}
        aria-disabled={asChild && blocked ? true : undefined}
        data-disabled={asChild && blocked ? "" : undefined}
        aria-busy={loading || undefined}
        tabIndex={asChild && blocked ? -1 : tabIndex}
        onClickCapture={onClickCapture}
        onClick={onClick}
        {...props}
      >
        {asChild ? (
          // Slot requires exactly ONE child — pass it through untouched.
          children
        ) : (
          <>
            {showSpinner ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {children}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
