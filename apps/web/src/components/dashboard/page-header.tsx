// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type DashboardPageHeaderTone = "blue" | "pink" | "yellow" | "ink";

const toneClasses: Record<DashboardPageHeaderTone, string> = {
  blue: "bg-mw-blue text-white",
  pink: "bg-mw-pink text-mw-ink",
  yellow: "bg-mw-yellow text-mw-ink",
  ink: "bg-mw-ink text-mw-yellow",
};

/**
 * Shared editorial header for authenticated product routes.
 *
 * The design site uses bold colour in chapters rather than sprinkling accents
 * over every control. This component follows that rule: the working surface is
 * calm paper, one compact colour block establishes the route, and the optional
 * operational rail holds changing data in one scan line.
 */
export function DashboardPageHeader({
  eyebrow,
  title,
  description,
  icon,
  actions,
  status,
  tone = "yellow",
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  tone?: DashboardPageHeaderTone;
  className?: string;
}) {
  return (
    <header
      data-slot="dashboard-page-header"
      data-tone={tone}
      className={cn(
        "relative isolate rounded-[18px_24px_18px_24px] border border-mw-ink/20 bg-card px-4 py-5 text-card-foreground shadow-[3px_4px_0_rgb(32_32_30_/_0.11)] sm:px-6 sm:py-6",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-px top-5 h-12 w-1.5 rounded-r-full",
          toneClasses[tone],
        )}
      />
      <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div
          className={cn(
            "grid min-w-0 items-start gap-x-3 gap-y-2 text-pretty sm:gap-x-4",
            icon ? "grid-cols-[auto_minmax(0,1fr)]" : "grid-cols-1",
          )}
        >
          {icon ? (
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 inline-flex size-11 shrink-0 rotate-[-1.5deg] items-center justify-center rounded-[10px_14px_10px_14px] border-[1.5px] border-mw-ink shadow-[2px_3px_0_var(--mw-ink)] sm:size-12 [&_svg]:size-5",
                toneClasses[tone],
              )}
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            {eyebrow ? (
              <p className="font-hand text-sm font-semibold leading-none text-mw-blue">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="mw-display mt-1 break-words text-[1.75rem] text-mw-ink sm:text-[2.15rem]">
              {title}
            </h1>
          </div>
          {description ? (
            <div
              className={cn(
                "max-w-3xl text-sm leading-6 text-muted-foreground sm:text-[0.95rem]",
                icon && "col-span-2 sm:col-span-1 sm:col-start-2",
              )}
            >
              {description}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div
            data-slot="dashboard-page-header-actions"
            className="flex w-full shrink-0 flex-wrap items-center gap-2 [&>*]:min-h-11 lg:w-auto lg:max-w-[52%] lg:justify-end"
          >
            {actions}
          </div>
        ) : null}
      </div>
      {status ? (
        <div
          data-slot="dashboard-page-header-status"
          className="mt-5 min-w-0 rounded-2xl border border-emerald-900/10 bg-gradient-to-br from-[#edf7f2] via-[#f5f9f8] to-[#fff8ec] px-3 py-3 text-foreground shadow-[inset_0_1px_0_rgb(255_255_255_/_0.9),0_4px_16px_rgb(32_32_30_/_0.025)] dark:border-white/10 dark:from-emerald-950/40 dark:via-card dark:to-card dark:shadow-none sm:px-4"
        >
          {status}
        </div>
      ) : null}
    </header>
  );
}
