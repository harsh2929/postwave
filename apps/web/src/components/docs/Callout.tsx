// Moosewave docs - callout box: info, warn, danger.

import { AlertTriangle, Info, OctagonAlert } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { compactProse } from "@/styles/compact-prose";

export interface CalloutProps {
  variant?: "info" | "warn" | "danger";
  title?: string;
  children: ReactNode;
}

const VARIANTS = {
  info: {
    border: "border-blue-200",
    bg: "bg-blue-50",
    text: "text-blue-900",
    Icon: Info,
  },
  warn: {
    border: "border-amber-200",
    bg: "bg-amber-50",
    text: "text-amber-900",
    Icon: AlertTriangle,
  },
  danger: {
    border: "border-red-200",
    bg: "bg-red-50",
    text: "text-red-900",
    Icon: OctagonAlert,
  },
} as const;

export function Callout({
  variant = "info",
  title,
  children,
}: CalloutProps): JSX.Element {
  const v = VARIANTS[variant];
  const Icon = v.Icon;
  return (
    <div
      role="note"
      className={cn(
        "my-4 rounded-md border px-4 py-3 text-sm",
        v.border,
        v.bg,
        v.text,
      )}
    >
      <div className="flex gap-2">
        <Icon aria-hidden className="h-4 w-4 mt-0.5 flex-none" />
        <div className="flex-1 space-y-1">
          {title ? <div className="font-semibold">{title}</div> : null}
          <div className={cn(compactProse.small, "leading-relaxed")}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
