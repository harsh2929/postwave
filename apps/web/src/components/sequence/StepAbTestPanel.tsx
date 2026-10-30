// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// A/B split editor for one email step (desktop parity automation-68; desktop
// reference apps/desktop/src/components/sequence/StepEditor.tsx:262-329,525
// and variants.ts). Controlled: the host owns the state and, on Save, turns it
// into the step's `email.variants` via {@link abTestVariants} — the list rides
// in the ordinary version-protected PATCH /api/v1/voice/sequences/{id}.
// The rules mirror services/voice generation.ValidateVariants: 2..4 arms, a
// subject and body on each, weights (basis points) totalling exactly 100%.

import { useId } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  VARIANT_MAX,
  VARIANT_MIN,
  addVariantDraft,
  bpToPct,
  draftsToVariants,
  removeVariantDraft,
  seedVariantDrafts,
  variantDraftsProblem,
  variantsToDrafts,
  weightsTotalBp,
  type VariantDraft,
} from "@/lib/flow-canvas-model";
import type { SequenceEmailVariant } from "@/lib/voice-types";
import { cn } from "@/lib/utils";

export interface AbTestState {
  enabled: boolean;
  drafts: VariantDraft[];
}

export interface AbTestBase {
  subject: string;
  body?: string;
  body_html?: string;
}

export function abTestStateFrom(
  variants: SequenceEmailVariant[] | undefined,
): AbTestState {
  return Array.isArray(variants) && variants.length > 0
    ? { enabled: true, drafts: variantsToDrafts(variants) }
    : { enabled: false, drafts: [] };
}

/**
 * The variants to store for this state: `undefined` clears the split; an
 * `error` names the first rule the drafts break.
 */
export function abTestVariants(
  state: AbTestState,
): { variants: SequenceEmailVariant[] | undefined } | { error: string } {
  if (!state.enabled) return { variants: undefined };
  const problem = variantDraftsProblem(state.drafts);
  if (problem) return { error: problem };
  return { variants: draftsToVariants(state.drafts) ?? undefined };
}

export function StepAbTestPanel({
  value,
  base,
  disabled,
  error,
  onChange,
}: {
  value: AbTestState;
  /** The email's own content — arm A of a freshly enabled test. */
  base: AbTestBase;
  disabled: boolean;
  /** Validation sentence from the host's last Save attempt. */
  error?: string | null;
  onChange: (next: AbTestState) => void;
}) {
  const toggleId = useId();
  const prefix = useId();
  const total = weightsTotalBp(value.drafts);

  const setDraft = (index: number, patch: Partial<VariantDraft>) =>
    onChange({
      ...value,
      drafts: value.drafts.map((draft, i) =>
        i === index ? { ...draft, ...patch } : draft,
      ),
    });

  return (
    <section aria-label="A/B test" className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id={toggleId}
          checked={value.enabled}
          disabled={disabled}
          onChange={(event) => {
            const enabled = event.target.checked;
            onChange({
              enabled,
              drafts:
                enabled && value.drafts.length === 0
                  ? seedVariantDrafts(base)
                  : value.drafts,
            });
          }}
        />
        <Label htmlFor={toggleId} className="text-sm font-medium">
          A/B test this email
        </Label>
      </div>
      {value.enabled ? (
        <>
          <p className="text-xs text-muted-foreground">
            Each subscriber is assigned one variant, the same one every time.
            Between {VARIANT_MIN} and {VARIANT_MAX} variants; weights must total
            100%. Nothing sends until a sequence runtime is available.
          </p>
          <ol className="space-y-3">
            {value.drafts.map((draft, index) => {
              const id = `${prefix}-${index}`;
              return (
                <li
                  key={index}
                  className="space-y-2 rounded-md bg-muted/40 p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">
                      Variant {draft.key}
                    </span>
                    <IconButton
                      size="sm"
                      aria-label={`Remove variant ${draft.key}`}
                      title={
                        value.drafts.length <= VARIANT_MIN
                          ? `An A/B test keeps at least ${VARIANT_MIN} variants.`
                          : `Remove variant ${draft.key}`
                      }
                      disabled={disabled || value.drafts.length <= VARIANT_MIN}
                      onClick={() =>
                        onChange({
                          ...value,
                          drafts: removeVariantDraft(value.drafts, index),
                        })
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                    <div className="space-y-1">
                      <Label htmlFor={`${id}-subject`} className="text-xs">
                        Variant {draft.key} subject
                      </Label>
                      <Input
                        id={`${id}-subject`}
                        value={draft.subject}
                        disabled={disabled}
                        onChange={(event) =>
                          setDraft(index, { subject: event.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${id}-weight`} className="text-xs">
                        Variant {draft.key} weight (%)
                      </Label>
                      <Input
                        id={`${id}-weight`}
                        inputMode="decimal"
                        value={draft.weight_pct}
                        disabled={disabled}
                        onChange={(event) =>
                          setDraft(index, { weight_pct: event.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-body`} className="text-xs">
                      Variant {draft.key} body
                    </Label>
                    <Textarea
                      id={`${id}-body`}
                      rows={4}
                      value={draft.body}
                      disabled={disabled}
                      onChange={(event) =>
                        setDraft(index, { body: event.target.value })
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || value.drafts.length >= VARIANT_MAX}
              title={
                value.drafts.length >= VARIANT_MAX
                  ? `An A/B test allows at most ${VARIANT_MAX} variants.`
                  : undefined
              }
              onClick={() =>
                onChange({ ...value, drafts: addVariantDraft(value.drafts) })
              }
            >
              <Plus className="h-4 w-4" /> Add variant
            </Button>
            <span
              className={cn(
                "text-xs tabular-nums",
                total === 10000
                  ? "text-muted-foreground"
                  : "text-warning-emphasis",
              )}
            >
              Weights total {total === null ? "—" : `${bpToPct(total)}%`}
            </span>
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
