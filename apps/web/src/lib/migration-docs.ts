// SPDX-License-Identifier: AGPL-3.0-only
//
// Which migration sources have a per-source docs guide, and how to link to it.
// Keep in sync with the GUIDES map in
// `app/(docs)/docs/migrations/[source]/page.tsx` (a docs test asserts parity).
// The wizard, source cards, and detail header link here so the reference
// material that replaces the wall-of-text caveats is one click away (MIGR-017).

import type { Route } from "next";
import type { SourcePlatform } from "./types";

/** Sources with a dedicated `/docs/migrations/<slug>` guide. */
export const MIGRATION_DOCS_SOURCES: readonly SourcePlatform[] = [
  "mailchimp",
  "activecampaign",
  "hubspot",
  "customerio",
  "convertkit",
  "brevo",
  "beehiiv",
  "substack",
  "mailerlite",
  "sendy",
  "csv",
] as const;

const DOCS_SOURCE_SET = new Set<string>(MIGRATION_DOCS_SOURCES);

/** The general "how migrations work" guide index. */
export const MIGRATION_DOCS_INDEX = "/docs/migrations" as Route;

export function hasMigrationDocsGuide(source: SourcePlatform): boolean {
  return DOCS_SOURCE_SET.has(source);
}

/**
 * Link to the per-source docs guide, or the guide index when no source-specific
 * guide exists. Returning a never-null Route keeps callers simple.
 */
export function migrationDocsHref(source: SourcePlatform): Route {
  return (
    hasMigrationDocsGuide(source)
      ? `/docs/migrations/${source}`
      : MIGRATION_DOCS_INDEX
  ) as Route;
}
