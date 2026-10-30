// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { TemplateBrowser } from "@/components/sequences/template-browser";
import { asRoute } from "@/lib/typed-routes";
import type { SequenceTemplate } from "@/lib/voice-types";

export function SequenceTemplatesBrowser({
  templates,
  loadError,
}: {
  templates: SequenceTemplate[];
  loadError: string | null;
}) {
  return (
    <TemplateBrowser
      templates={templates}
      loadError={loadError}
      emptyCatalogMessage="No sequence templates are available yet. They ship with Moosewave — check back once your workspace finishes provisioning."
      actions={(template) => (
        <>
          <Button asChild size="sm" variant="ghost">
            <Link href={asRoute(`/app/sequence-templates/${template.id}`)}>
              Preview
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`/app/sequences/new/${template.id}`}>Use sequence</Link>
          </Button>
        </>
      )}
    />
  );
}
