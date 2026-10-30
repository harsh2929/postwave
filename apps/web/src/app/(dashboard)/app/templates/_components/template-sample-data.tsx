// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  extractConditionalKeys,
  extractMergeTags,
  templateVariableEntries,
} from "@/lib/template-merge-tags";

export type SampleScenario = "defaults" | "missing" | "long" | "conditional_on";

export function sampleScenarioValues(
  keys: readonly string[],
  defaults: Record<string, string>,
  scenario: SampleScenario,
): Record<string, string> {
  if (scenario === "defaults") return { ...defaults };
  return Object.fromEntries(
    keys.map((key) => [
      key,
      scenario === "missing"
        ? ""
        : scenario === "conditional_on"
          ? defaults[key] || "yes"
        : /(?:url|link|href)$/i.test(key)
          ? "https://example.invalid/preview"
          : "A particularly long sample value to check wrapping, spacing, and narrow inbox layouts",
    ]),
  );
}

/**
 * Sample-data model for previews: auto-detects the `{{ merge tags }}` in a
 * template body, seeds them with the template's declared variable defaults, and
 * lets the user fill values in a friendly per-key form instead of hand-writing
 * JSON (TMPL-014). Shared by the HTML and MJML preview branches so both reach
 * parity on sample-data preview (TMPL-010).
 */
export function useTemplateSampleData(
  source: string,
  variables: Array<Record<string, unknown>> | undefined,
) {
  // Callers often serialize draft variables inline. Normalize by value so an
  // unrelated parent render does not trigger another four-request preview run.
  const variablesSignature = JSON.stringify(variables ?? []);
  const seeds = useMemo(
    () => templateVariableEntries(JSON.parse(variablesSignature) as Array<Record<string, unknown>>),
    [variablesSignature],
  );
  const keys = useMemo(() => {
    const detected = Array.from(new Set([
      ...extractMergeTags(source),
      ...extractConditionalKeys(source),
    ]));
    const seen = new Set(detected);
    const extra = seeds.map((s) => s.key).filter((k) => !seen.has(k));
    return [...detected, ...extra];
  }, [source, seeds]);

  const seedMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const seed of seeds) if (seed.value) map[seed.key] = seed.value;
    return map;
  }, [seeds]);

  // Seed with declared defaults so the preview shows real sample data on open.
  const [values, setValues] = useState<Record<string, string>>(seedMap);

  const setValue = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const applyScenario = (scenario: SampleScenario) =>
    setValues(sampleScenarioValues(keys, seedMap, scenario));

  const vars = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = values[key];
      if (value) out[key] = value;
    }
    return out;
  }, [keys, values]);

  return { keys, values, defaults: seedMap, setValue, vars, applyScenario };
}

export function SampleDataFields({
  keys,
  values,
  onChange,
  idPrefix,
}: {
  keys: string[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  idPrefix: string;
}) {
  if (keys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No <code>{"{{ tag }}"}</code> merge variables were detected in this
        template.
      </p>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {keys.map((key) => {
        const id = `${idPrefix}-${key}`;
        return (
          <div key={key} className="grid gap-1">
            <Label htmlFor={id} className="font-mono text-xs">
              {key}
            </Label>
            <Input
              id={id}
              value={values[key] ?? ""}
              onChange={(event) => onChange(key, event.target.value)}
              placeholder={`Sample ${key}`}
            />
          </div>
        );
      })}
    </div>
  );
}
