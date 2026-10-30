// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

import { Button } from "@/components/ui/button";
import type { CampaignTemplateSummary } from "@/lib/campaign-templates-api";

// The header action is the only eager client import on the preview route
// that pulls the campaign-templates API module (capability derivation); it
// loads behind a disabled button of the same size so the header keeps its
// shape (bundle budget). The boundary lives in a client component because
// next/dynamic inside a server page stays in the eager graph.
function HeaderActionFallback({ label }: { label: string }) {
  return (
    <Button type="button" disabled aria-busy role="status">
      {label}
    </Button>
  );
}

const LazyUseTemplateAction = dynamic(
  () =>
    import("./deferred-template-actions").then(
      (m) => m.LazyUseTemplateAction,
    ),
  { loading: () => <HeaderActionFallback label="Use template" /> },
);

const LazyAdaptTemplateAction = dynamic(
  () =>
    import("./deferred-template-actions").then(
      (m) => m.LazyAdaptTemplateAction,
    ),
  { loading: () => <HeaderActionFallback label="Make it mine" /> },
);

export function TemplateHeaderAction({
  template,
  label,
}: {
  template: CampaignTemplateSummary;
  label: string;
}) {
  return template.template_kind === "reference" ? (
    <LazyAdaptTemplateAction template={template} label={label} />
  ) : (
    <LazyUseTemplateAction template={template} label={label} />
  );
}
