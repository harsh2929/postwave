// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

/**
 * Small client boundary used only for a disabled `Button asChild`.
 *
 * A disabled attribute has no effect on anchors, and Radix Slot composes the
 * child's click handler before its own. Keeping this guard in a dedicated
 * client component prevents disabled links from navigating without turning
 * every shared Button in server-rendered routes into hydrated client code.
 */
export const DisabledButtonSlot = React.forwardRef<
  HTMLElement,
  React.ComponentPropsWithoutRef<typeof Slot>
>(({ children, ...props }, ref) => {
  const inertChild = React.isValidElement(children)
    ? React.cloneElement(
        children as React.ReactElement<{
          onClick?: React.MouseEventHandler<HTMLElement>;
          onClickCapture?: React.MouseEventHandler<HTMLElement>;
        }>,
        {
          onClick: undefined,
          onClickCapture: undefined,
        },
      )
    : children;

  const stopActivation = (event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Slot
      {...props}
      ref={ref}
      onClickCapture={stopActivation}
      onClick={stopActivation}
    >
      {inertChild}
    </Slot>
  );
});
DisabledButtonSlot.displayName = "DisabledButtonSlot";
