// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { renderTemplateWithSampleData } from "@/lib/template-merge-preview-api";

import { TemplatePreviewFrame } from "./template-preview";
import {
  SampleDataFields,
  sampleScenarioValues,
  type SampleScenario,
  useTemplateSampleData,
} from "./template-sample-data";

const MATRIX_SCENARIOS: readonly SampleScenario[] = ["defaults", "missing", "conditional_on", "long"];

/**
 * TemplatePreviewFrame + a "preview with sample data" panel. The panel
 * auto-detects the template's `{{ merge tags }}`, seeds them with the
 * template's declared variable defaults, and lets the user fill values in a
 * friendly per-key form (no hand-written JSON — TMPL-014). Values are merged
 * by the server's send-time engine, then rendered in a sandboxed iframe.
 */
export function TemplatePreviewWithVars({
  html,
  title,
  variables,
  source,
  compact = false,
}: {
  html: string;
  title: string;
  variables?: Array<Record<string, unknown>>;
  source?: string;
  compact?: boolean;
}): JSX.Element {
  const { keys, values, defaults, setValue, vars, applyScenario } = useTemplateSampleData(
    source ?? html,
    variables,
  );
  const [scenario, setScenario] = useState("defaults");
  const [rendered, setRendered] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [matrix, setMatrix] = useState<Partial<Record<SampleScenario, string>>>({});
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setRendered("");
    setPreviewError(null);
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void renderTemplateWithSampleData(html, vars, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setRendered(result.rendered);
          setPreviewError(result.error ?? null);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setPreviewError(
            error instanceof Error ? error.message : "The recipient preview is unavailable.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [html, vars]);

  useEffect(() => {
    if (!matrixOpen) return;
    const controller = new AbortController();
    setMatrix({});
    setMatrixError(null);
    setMatrixLoading(true);
    void Promise.all(MATRIX_SCENARIOS.map(async (option) => {
      const result = await renderTemplateWithSampleData(
        html, sampleScenarioValues(keys, defaults, option), controller.signal,
      );
      if (result.error) throw new Error(`${option}: ${result.error}`);
      return [option, result.rendered] as const;
    })).then((rows) => {
      if (!controller.signal.aborted) setMatrix(Object.fromEntries(rows));
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setMatrixError(cause instanceof Error ? cause.message : "Could not compare audience states.");
    }).finally(() => {
      if (!controller.signal.aborted) setMatrixLoading(false);
    });
    return () => controller.abort();
  }, [matrixOpen, html, keys, defaults]);

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
              {(["defaults", "missing", "conditional_on", "long"] as const).map((option) => (
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
                  {option === "defaults" ? "Defaults" : option === "missing" ? "Missing values" : option === "conditional_on" ? "Conditions on" : "Long values"}
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
            idPrefix="html-preview-var"
          />
          <p className="text-xs text-muted-foreground">
            Sample values are rendered by Moosewave’s merge engine, including
            declared defaults and conditional content. This is synthetic data,
            not a real recipient or a delivered email.
          </p>
        </div>
      </details>
      {previewError ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-emphasis">
          Preview could not be verified: {previewError}
        </p>
      ) : previewLoading ? (
        <p role="status" className="text-sm text-muted-foreground">Rendering recipient preview…</p>
      ) : (
        <TemplatePreviewFrame html={rendered} title={title} compact={compact} />
      )}
      {keys.length > 0 ? <div className="space-y-3 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="text-sm font-medium">Audience state matrix</p><p className="text-xs text-muted-foreground">Compare the same draft with defaults, absent values, truthy conditions, and long values.</p></div>
          <Button type="button" size="sm" variant="outline" aria-expanded={matrixOpen} onClick={() => setMatrixOpen((open) => !open)}>
            {matrixOpen ? "Hide matrix" : "Compare states"}
          </Button>
        </div>
        {matrixError ? <p role="alert" className="text-sm text-destructive">{matrixError}</p> : null}
        {matrixLoading ? <p role="status" className="text-sm text-muted-foreground">Rendering four audience states…</p> : null}
        {matrixOpen && !matrixLoading && !matrixError ? <div className="grid gap-3 xl:grid-cols-2">
          {MATRIX_SCENARIOS.map((option) => matrix[option] !== undefined ? <div key={option} className="min-w-0 rounded-md border p-2">
            <p className="pb-2 text-xs font-medium capitalize">{option.replaceAll("_", " ")}</p>
            <TemplatePreviewFrame html={matrix[option]} title={`${title} · ${option}`} compact />
          </div> : null)}
        </div> : null}
      </div> : null}
    </div>
  );
}
