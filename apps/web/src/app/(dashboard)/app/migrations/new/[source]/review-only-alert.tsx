// SPDX-License-Identifier: AGPL-3.0-only
//
// The Klaviyo / Customer.io discover-step caveats were single 200-300 word
// AlertDescription paragraphs users wouldn't read (MIGR-014). This renders a
// short lede + scannable bulleted caveats, with the complete original text kept
// verbatim behind an expandable "Full details" — nothing is dropped, it's just
// scannable. A docs link points at the deeper guide.
"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { BookOpen } from "lucide-react";

import type { Route } from "next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ReviewOnlyAlert({
  title,
  lede,
  bullets,
  details,
  docsHref,
}: {
  title: string;
  lede: ReactNode;
  bullets: ReactNode[];
  details: ReactNode;
  docsHref?: Route;
}) {
  return (
    <Alert variant="warning">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{lede}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
        <details className="mt-2 group">
          <summary className="cursor-pointer text-xs font-medium text-foreground/80 hover:text-foreground">
            Full details
          </summary>
          <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {details}
          </div>
        </details>
        {docsHref ? (
          <Link
            href={docsHref}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            <BookOpen className="h-3 w-3" /> Read the migration guide
          </Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
