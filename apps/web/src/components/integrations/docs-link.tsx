// SPDX-License-Identifier: AGPL-3.0-only
//
// One "View docs" link treatment shared by the catalog grid card and the
// catalog detail page (INTG-009). Absolute http(s) URLs open in a new tab with
// rel="noopener noreferrer" (they leave the app); relative/internal doc paths
// stay a plain in-app anchor. docs_url is arbitrary catalog data, not a
// statically-known route, so a plain <a> keeps it outside Next's typed-routes
// constraint while still navigating.

import { cn } from "@/lib/utils";

const EXTERNAL = /^https?:\/\//i;
const INTERNAL = /^(?:\/(?!\/)|#)/;
const BASE_CLASS =
  "inline-flex min-h-11 items-center rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-8";

export function DocsLink({
  href,
  className,
  children = "View docs →",
}: {
  href: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const external = EXTERNAL.test(href);
  if (!external && !INTERNAL.test(href)) return null;
  return (
    <a
      href={href}
      className={cn(BASE_CLASS, className)}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
      {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </a>
  );
}
