// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TemplateBrowser } from "@/components/sequences/template-browser";
import type { SequenceTemplate } from "@/lib/voice-types";

interface TemplatePickerProps {
  templates: SequenceTemplate[];
  loadError?: string | null;
}

export function TemplatePickerClient({
  templates,
  loadError = null,
}: TemplatePickerProps) {
  return (
    <TemplateBrowser
      templates={templates}
      loadError={loadError}
      // Secondary embed under the manual builder — keep filters local so they
      // don't collide with the page URL; the shared browser still gives clear
      // search, category pills, favorites, and result counts (SEQ-018/039).
      persistInUrl={false}
      actions={(template) => (
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link href={`/app/sequences/new/${template.id}`}>
            Use this template
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      )}
    />
  );
}
