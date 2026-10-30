// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * PasswordInput — the shared Input primitive with a show/hide reveal toggle
 * (AUTH-003). Used by every password field (login, signup, both reset fields)
 * so the reveal control, focus ring, and accessibility are identical
 * everywhere.
 *
 * The toggle is a real <button> (keyboard-operable), exposes an aria-label that
 * reflects state, and carries aria-pressed. The type flips between "password"
 * and "text" locally; the value is never persisted or logged.
 */
export type PasswordInputProps = Omit<React.ComponentProps<"input">, "type">;

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, disabled, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    const label = visible ? "Hide password" : "Show password";
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          disabled={disabled}
          className={cn("pr-10", className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          tabIndex={disabled ? -1 : 0}
          aria-pressed={visible}
          aria-label={label}
          title={label}
          className="absolute inset-y-0 right-0 flex items-center rounded-r-md px-3 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {visible ? (
            <EyeOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Eye className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
