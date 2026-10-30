// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Slot } from "@radix-ui/react-slot";
import dynamic from "next/dynamic";
import {
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from "react";

import type { ConfirmDialog } from "./confirm-dialog";

type ConfirmDialogProps = ComponentProps<typeof ConfirmDialog>;

// Slot is typed for any element; the triggers it wraps here are buttons, and
// DialogTrigger gives them `type="button"`.
const TriggerSlot = Slot as ForwardRefExoticComponent<
  ButtonHTMLAttributes<HTMLButtonElement> & RefAttributes<HTMLButtonElement>
>;

// The dialog implementation (Radix Dialog with its focus scope, dismissable
// layer and scroll lock) is ~37 KiB of a route's initial JavaScript, for a
// confirmation most visits never open. It loads when one first opens.
const LazyConfirmDialog = dynamic(
  () => import("./confirm-dialog").then((module) => module.ConfirmDialog),
  {
    ssr: false,
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading confirmation…
      </span>
    ),
  },
);

/**
 * ConfirmDialog, with the same props, for routes near their bundle budget.
 *
 * The trigger renders at once, carrying what DialogTrigger gives it
 * (`type="button"`, `aria-haspopup="dialog"`, `aria-expanded`, `data-state`).
 * The dialog mounts the first time it opens and then stays mounted, so closing
 * it animates and returns focus exactly as ConfirmDialog does: to the trigger,
 * or to `returnFocusRef` / `fallbackFocusRef` when given.
 */
export function DeferredConfirmDialog({
  trigger,
  open: openProp,
  onOpenChange,
  returnFocusRef,
  ...props
}: ConfirmDialogProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [activated, setActivated] = useState(open);
  // A controlled dialog can be opened by its owner without a trigger click.
  if (open && !activated) setActivated(true);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  return (
    <>
      {trigger ? (
        <TriggerSlot
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-state={open ? "open" : "closed"}
          onClick={(event) => {
            if (!event.defaultPrevented) setOpen(true);
          }}
        >
          {trigger}
        </TriggerSlot>
      ) : null}
      {activated ? (
        <LazyConfirmDialog
          {...props}
          open={open}
          onOpenChange={setOpen}
          returnFocusRef={returnFocusRef ?? (trigger ? triggerRef : undefined)}
        />
      ) : null}
    </>
  );
}
