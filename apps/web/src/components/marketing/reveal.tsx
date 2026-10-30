// SPDX-License-Identifier: AGPL-3.0-only
//
// Lightweight server-only compatibility wrappers for the marketing surface.
//
// They retain the former motion component API without sending a client motion
// runtime or hiding server-rendered content before hydration. The visual system
// uses tactile hover/press states elsewhere, while these wrappers stay static.

import Link from "next/link";
import type { ComponentProps, CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

type Tag = "div" | "section" | "article" | "li" | "p" | "span";

export function FadeRise({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: Tag;
}): JSX.Element {
  const Comp = as;
  return <Comp className={className}>{children}</Comp>;
}

export function TiltIn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
  direction?: "left" | "right";
}): JSX.Element {
  return <div className={className}>{children}</div>;
}

export function MarqueeRule({
  className,
  colorClass = "bg-pw-ember-500",
}: {
  className?: string;
  colorClass?: string;
}): JSX.Element {
  return (
    <div aria-hidden className={className ?? "h-[2px] w-16"}>
      <div className={`h-full w-full ${colorClass}`} />
    </div>
  );
}

export function PillarNumber({
  children,
  className,
}: {
  children: string;
  className?: string;
}): JSX.Element {
  return <span className={className}>{children}</span>;
}

export function PulseOpacity({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={className}>{children}</div>;
}

export function Stagger({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  staggerChildren?: number;
  delayChildren?: number;
  // false = an on-load entrance (the hero, which is already in view), so the
  // children opt out of the scroll timeline rather than sitting at their
  // final frame.
  scrollTrigger?: boolean;
  as?: "div" | "section" | "ul" | "ol";
}): JSX.Element {
  const Comp = as;
  return <Comp className={className}>{children}</Comp>;
}

export function StaggerItem({
  children,
  className,
  as = "div",
  style,
}: {
  children: ReactNode;
  className?: string;
  as?: Tag;
  style?: CSSProperties;
}): JSX.Element {
  const Comp = as;
  return (
    <Comp className={className} style={style}>
      {children}
    </Comp>
  );
}

const VARIANT_CLASSES = {
  primary:
    "inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 text-white px-5 py-3 text-sm font-medium shadow-[0_2px_0_0_#7A081B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2",
  ghost:
    "inline-flex items-center justify-center rounded-md border border-pw-line bg-transparent text-pw-ink2 hover:border-pw-ink2/40 hover:bg-pw-surface px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2",
} as const;

/**
 * The marketing CTA link. The spring hover/press the motion version animated
 * is a transform transition; the browser runs it on the compositor either way.
 */
export function MotionLink({
  children,
  variant = "primary",
  className,
  ...rest
}: Omit<ComponentProps<typeof Link>, "children" | "className"> & {
  children: ReactNode;
  variant?: keyof typeof VARIANT_CLASSES;
  className?: string;
}): JSX.Element {
  return (
    <Link {...rest} className={cn(VARIANT_CLASSES[variant], className)}>
      {children}
    </Link>
  );
}
