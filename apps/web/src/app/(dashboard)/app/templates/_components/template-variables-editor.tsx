// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Plus, X } from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  emptyTemplateVariableDraft,
  TEMPLATE_VARIABLE_DEFAULT_MAX,
  TEMPLATE_VARIABLE_LABEL_MAX,
  TEMPLATE_VARIABLE_MAX,
  TEMPLATE_VARIABLE_NAME_MAX,
  type TemplateVariableDraft,
} from "@/lib/template-regions-api";

/**
 * Merge-variable editor for a template draft (desktop parity:
 * TemplateDetailSlideover's VariablesEditor). Controlled: the form owns the
 * drafts and persists them with the rest of the template in one save, so the
 * unsaved-changes guard and the concurrency token cover variables too.
 */
export function TemplateVariablesEditor({
  variables,
  onChange,
  disabled = false,
}: {
  variables: TemplateVariableDraft[];
  onChange: (next: TemplateVariableDraft[]) => void;
  disabled?: boolean;
}) {
  const headingId = useId();
  const atLimit = variables.length >= TEMPLATE_VARIABLE_MAX;

  const update = (index: number, patch: Partial<TemplateVariableDraft>) => {
    onChange(
      variables.map((variable, i) =>
        i === index ? { ...variable, ...patch } : variable,
      ),
    );
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id={headingId} className="text-sm font-medium">
          Merge variables
        </h2>
        <p className="text-xs text-muted-foreground">
          Used as <code className="font-mono">{"{{ name }}"}</code> in the body
          and filled with the default in previews.
        </p>
      </div>

      {variables.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          No merge variables yet. Add one to surface a merge tag in this
          template.
        </p>
      ) : (
        <ul className="grid gap-2">
          {variables.map((variable, index) => {
            const position = index + 1;
            return (
              <li
                key={index}
                className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_auto] sm:items-center"
              >
                <Input
                  aria-label={`Variable ${position} name`}
                  className="font-mono"
                  placeholder="name"
                  value={variable.name}
                  maxLength={TEMPLATE_VARIABLE_NAME_MAX}
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, {
                      name: event.target.value
                        .replace(/[^A-Za-z0-9_]/g, "_")
                        .slice(0, TEMPLATE_VARIABLE_NAME_MAX),
                    })
                  }
                />
                <Input
                  aria-label={`Variable ${position} label`}
                  placeholder="Label"
                  value={variable.label}
                  maxLength={TEMPLATE_VARIABLE_LABEL_MAX}
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, { label: event.target.value })
                  }
                />
                <Input
                  aria-label={`Variable ${position} default content`}
                  placeholder="Default content"
                  value={variable.default}
                  maxLength={TEMPLATE_VARIABLE_DEFAULT_MAX}
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, { default: event.target.value })
                  }
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                  aria-label={`Remove variable ${variable.name || position}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange(variables.filter((_, i) => i !== index))
                  }
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-8"
          disabled={disabled || atLimit}
          onClick={() => onChange([...variables, emptyTemplateVariableDraft()])}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add variable
        </Button>
        {atLimit ? (
          <span className="text-xs text-muted-foreground">
            Maximum {TEMPLATE_VARIABLE_MAX} variables reached.
          </span>
        ) : null}
      </div>
    </section>
  );
}
