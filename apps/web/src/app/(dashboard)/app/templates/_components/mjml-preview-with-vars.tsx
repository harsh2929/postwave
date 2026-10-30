// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { EmailPreview } from "@/components/EmailPreview";
import { Button } from "@/components/ui/button";
import { useState } from "react";

import {
  SampleDataFields,
  useTemplateSampleData,
} from "./template-sample-data";

/**
 * MJML preview with an auto-detected sample-data form. Detects the `{{ tags }}`
 * in the MJML source, seeds declared defaults, and forwards the filled values
 * to `EmailPreview`'s `vars` prop (which `renderEmailPreview` already threads
 * to the server renderer) — giving MJML templates the same sample-data preview
 * HTML-only templates already had (TMPL-010).
 */
export function MjmlPreviewWithVars({
  mjml,
  variables,
}: {
  mjml: string;
  variables?: Array<Record<string, unknown>>;
}) {
  const { keys, values, setValue, vars, applyScenario } = useTemplateSampleData(
    mjml,
    variables,
  );
  const [scenario, setScenario] = useState("defaults");

  return (
    <div className="space-y-3">
      <details
        className="rounded-lg border bg-muted/30 px-4 py-3"
        open={keys.length > 0}
      >
        <summary className="flex min-h-11 cursor-pointer items-center rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          Preview with sample data
        </summary>
        <div className="mt-3 space-y-3">
          {keys.length > 0 ? (
            <div className="flex flex-wrap gap-2" aria-label="Personalization scenarios">
              {(["defaults", "missing", "long"] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={scenario === option ? "secondary" : "outline"}
                  aria-pressed={scenario === option}
                  onClick={() => {
                    applyScenario(option);
                    setScenario(option);
                  }}
                >
                  {option === "defaults" ? "Defaults" : option === "missing" ? "Missing values" : "Long values"}
                </Button>
              ))}
            </div>
          ) : null}
          <SampleDataFields
            keys={keys}
            values={values}
            onChange={(key, value) => {
              setValue(key, value);
              setScenario("custom");
            }}
            idPrefix="mjml-preview-var"
          />
          <p className="text-xs text-muted-foreground">
            Values are substituted when the MJML is rendered below. Press
            &ldquo;Refresh preview&rdquo; after editing.
          </p>
        </div>
      </details>
      <EmailPreview mjml={mjml} vars={vars} />
    </div>
  );
}
