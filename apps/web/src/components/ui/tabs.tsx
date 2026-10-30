// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

type TabsListPrimitiveProps = React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.List
>;

/**
 * A tablist is a landmark-like composite control: announcing only "tablist"
 * gives a screen-reader user no clue which part of the page it switches. Make
 * its accessible name part of the component contract so a new callsite cannot
 * silently ship an anonymous list.
 */
type TabsListProps = Omit<
  TabsListPrimitiveProps,
  "aria-label" | "aria-labelledby"
> &
  (
    | { "aria-label": string; "aria-labelledby"?: never }
    | { "aria-label"?: never; "aria-labelledby": string }
  );

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    data-slot="tabs-list"
    className={cn(
      "flex w-full max-w-full touch-pan-x items-center justify-start gap-1 overflow-x-auto overscroll-x-contain rounded-[10px_14px_10px_14px] border border-[color:rgb(32_32_30_/_0.16)] bg-card p-1 text-muted-foreground shadow-[1px_2px_0_rgb(32_32_30_/_0.06)] sm:inline-flex sm:w-auto sm:justify-center",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, onClick, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    data-slot="tabs-trigger"
    className={cn(
      "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center whitespace-nowrap rounded-[7px_10px_7px_10px] px-3 py-2 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-mw-pink-soft data-[state=active]:text-mw-blue data-[state=active]:shadow-[0_2px_0_rgb(32_32_30_/_0.16)] sm:min-h-9 sm:min-w-0 sm:py-1 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:py-2",
      className,
    )}
    onClick={(event) => {
      onClick?.(event);
      // Radix activates pointer interaction on mousedown. Synthetic clicks
      // from tests, voice control, and some assistive technology do not always
      // include that prelude, so move focus explicitly; Radix's onFocus then
      // performs the same automatic activation as a keyboard arrow.
      if (!event.defaultPrevented) event.currentTarget.focus();
    }}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    data-slot="tabs-content"
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
