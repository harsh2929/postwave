// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

type AnyProps = Record<string, unknown>;

function mergeRefs<T>(
  ...refs: (React.Ref<T> | undefined)[]
): React.RefCallback<T> {
  return (node: T) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref && typeof ref === "object") {
        (ref as React.MutableRefObject<T | null>).current = node;
      }
    }
  };
}

/**
 * Lightweight, dependency-free tooltip that appears on BOTH hover and keyboard
 * focus (a plain `title=` attribute only shows on mouse hover, so icon-only
 * actions were invisible to keyboard users) and dismisses on Escape.
 *
 * CRITICAL: this is an `asChild`-style wrapper. A parent may itself clone this
 * element and inject props onto it — most importantly Radix `DialogTrigger
 * asChild`/`DropdownMenuTrigger asChild`, which put their `onClick`, `ref`, and
 * aria/data attributes onto the *immediate* child. We therefore forward every
 * parent-injected prop (via `...rest`) and the `ref` onto the cloned trigger
 * child, and COMPOSE event handlers so the parent's, the child's, and our own
 * hover/focus/escape handlers all run. Dropping these (the previous version
 * did) silently breaks any trigger wrapped in a Tooltip.
 */
interface TooltipProps extends React.HTMLAttributes<HTMLElement> {
  label: string;
  children: React.ReactElement;
  side?: "top" | "bottom";
}

export const Tooltip = React.forwardRef<HTMLElement, TooltipProps>(
  function Tooltip({ label, children, side = "top", className, ...rest }, ref) {
    const [open, setOpen] = React.useState(false);
    const [position, setPosition] = React.useState({
      left: 0,
      top: 0,
      ready: false,
    });
    const id = React.useId();
    const triggerRef = React.useRef<HTMLElement | null>(null);
    const tooltipRef = React.useRef<HTMLSpanElement | null>(null);
    const show = () => {
      if (!open) {
        setPosition((current) => ({ ...current, ready: false }));
      }
      setOpen(true);
    };
    const hide = () => setOpen(false);

    // Portalling avoids a closed tooltip widening an overflow container, while
    // measured fixed positioning keeps an open tooltip inside the viewport even
    // when its trigger sits against a mobile edge. Recompute for nested scroll
    // containers as well as viewport resizes.
    React.useEffect(() => {
      if (!open) return;

      const updatePosition = () => {
        const triggerNode = triggerRef.current;
        const tooltipNode = tooltipRef.current;
        if (!triggerNode || !tooltipNode) return;

        const triggerRect = triggerNode.getBoundingClientRect();
        const tooltipRect = tooltipNode.getBoundingClientRect();
        const margin = 8;
        const gap = 6;
        const maxLeft = Math.max(
          margin,
          window.innerWidth - tooltipRect.width - margin,
        );
        const left = Math.min(
          Math.max(
            triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2,
            margin,
          ),
          maxLeft,
        );
        const above = triggerRect.top - tooltipRect.height - gap;
        const below = triggerRect.bottom + gap;
        const preferredTop =
          side === "top"
            ? above >= margin
              ? above
              : below
            : below + tooltipRect.height <= window.innerHeight - margin
              ? below
              : above;
        const maxTop = Math.max(
          margin,
          window.innerHeight - tooltipRect.height - margin,
        );
        const top = Math.min(Math.max(preferredTop, margin), maxTop);

        setPosition((current) =>
          current.ready && current.left === left && current.top === top
            ? current
            : { left, top, ready: true },
        );
      };

      updatePosition();
      window.addEventListener("resize", updatePosition);
      document.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        document.removeEventListener("scroll", updatePosition, true);
      };
    }, [label, open, side]);

    const child = children as React.ReactElement<AnyProps>;
    const cp = child.props as AnyProps;
    const rp = rest as AnyProps;

    // Run parent-injected handler, then the child's own, then ours.
    const compose =
      (name: string, ours?: (e: unknown) => void) => (event: unknown) => {
        (rp[name] as ((e: unknown) => void) | undefined)?.(event);
        (cp[name] as ((e: unknown) => void) | undefined)?.(event);
        ours?.(event);
      };

    const childRef = (child as unknown as { ref?: React.Ref<HTMLElement> }).ref;

    const trigger = React.cloneElement(child, {
      // Forward every parent-injected prop (onClick, aria-*, data-state, type…)
      // onto the real trigger so an `asChild` parent keeps working.
      ...rp,
      ref: mergeRefs(ref, childRef, triggerRef),
      "aria-describedby": open
        ? id
        : ((cp["aria-describedby"] as string | undefined) ??
          (rp["aria-describedby"] as string | undefined)),
      // Spreading `...rp` above would let a parent-injected onClick/onPointerDown
      // (Radix Dialog/DropdownMenu triggers) clobber the child's own handler.
      // Compose them so BOTH the parent's activation and the child's handler run.
      onClick: compose("onClick"),
      onPointerDown: compose("onPointerDown"),
      onMouseEnter: compose("onMouseEnter", show),
      onMouseLeave: compose("onMouseLeave", hide),
      onFocus: compose("onFocus", show),
      onBlur: compose("onBlur", hide),
      onKeyDown: compose("onKeyDown", (e) => {
        if ((e as React.KeyboardEvent).key === "Escape") hide();
      }),
    } as Partial<AnyProps>);

    return (
      <span className="relative inline-flex max-w-full">
        {trigger}
        {open && typeof document !== "undefined"
          ? createPortal(
              <span
                ref={tooltipRef}
                role="tooltip"
                id={id}
                data-slot="tooltip"
                className={cn(
                  "pointer-events-none fixed z-[100] w-max max-w-[calc(100vw-1rem)] break-words rounded-[6px_9px_6px_9px] border border-mw-ink/30 bg-mw-ink px-2 py-1 text-center text-xs text-mw-paper shadow-[2px_3px_0_rgb(32_32_30_/_0.18)]",
                  position.ready
                    ? "mw-tooltip-enter motion-reduce:animate-none"
                    : "opacity-0",
                  className,
                )}
                style={{
                  left: position.left,
                  top: position.top,
                  visibility: position.ready ? "visible" : "hidden",
                }}
              >
                {label}
              </span>,
              document.body,
            )
          : null}
      </span>
    );
  },
);
