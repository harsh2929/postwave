// SPDX-License-Identifier: AGPL-3.0-only
//
// After a successful import the payoff moment used to dead-end on a report card
// with no path to the data the user just imported (MIGR-022), and no way to
// begin a fresh import (MIGR-025). This surfaces cross-entity links to the
// imported subscribers/segments/templates plus a "Start another migration"
// action, reused by the wizard DoneStep and the detail page.
"use client";

import Link from "next/link";
import { ArrowRight, Layers, Plus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { SourcePlatform } from "@/lib/types";

export function ImportedDataLinks({
  source,
  showTemplates = false,
}: {
  source: SourcePlatform;
  showTemplates?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild size="sm" variant="outline">
        <Link href="/app/subscribers">
          <Users className="h-3.5 w-3.5" /> View imported subscribers
        </Link>
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href="/app/subscribers/segments">
          <Layers className="h-3.5 w-3.5" /> View segments
        </Link>
      </Button>
      {showTemplates ? (
        <Button asChild size="sm" variant="outline">
          <Link href="/app/templates">View templates</Link>
        </Button>
      ) : null}
      <Button asChild size="sm" variant="ghost">
        <Link href={`/app/migrations/new/${source}`}>
          <Plus className="h-3.5 w-3.5" /> Start another migration
        </Link>
      </Button>
    </div>
  );
}

export function StartAnotherMigrationLink({
  source,
}: {
  source: SourcePlatform;
}) {
  return (
    <Button asChild variant="outline">
      <Link href={`/app/migrations/new/${source}`}>
        Start another migration <ArrowRight className="h-4 w-4" />
      </Link>
    </Button>
  );
}
