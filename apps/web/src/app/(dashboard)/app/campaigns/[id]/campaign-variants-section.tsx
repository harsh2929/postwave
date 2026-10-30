// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  asNumber,
  asString,
  type CampaignVariant,
} from "./campaign-detail-helpers";

export function CampaignVariantsSection({
  campaignBodyHtml,
  campaignPreviewText,
  campaignSubject,
  onChange,
  variants,
}: {
  campaignBodyHtml?: string;
  campaignPreviewText?: string;
  campaignSubject: string;
  onChange: (variants: CampaignVariant[]) => void;
  variants: CampaignVariant[];
}) {
  function patchVariant(index: number, patch: CampaignVariant) {
    onChange(
      variants.map((variant, i) =>
        i === index ? { ...variant, ...patch } : variant,
      ),
    );
  }

  function addVariant() {
    const nextIndex = variants.length + 1;
    onChange([
      ...variants,
      {
        id: `variant-${Date.now()}`,
        name: `Variant ${nextIndex}`,
        subject: campaignSubject,
        preview_text: campaignPreviewText ?? "",
        body_html: campaignBodyHtml ?? "",
        weight: nextIndex === 1 ? 100 : 50,
      },
    ]);
  }

  function removeVariant(index: number) {
    onChange(variants.filter((_, i) => i !== index));
  }

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold">Draft content variants</h2>
          <p className="text-sm text-muted-foreground">
            {variants.length} content variation
            {variants.length === 1 ? "" : "s"} in this draft. To run a
            statistical A/B test with winner selection, use the A/B test page.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addVariant}>
          <Plus className="h-4 w-4" />
          Add variant
        </Button>
      </div>
      <div className="mt-4 grid gap-3">
        {variants.length === 0 && (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Add variants to bind A/B content directly to this campaign draft.
          </div>
        )}
        {variants.map((variant, index) => (
          <div
            key={`${asString(variant.id, "variant")}-${index}`}
            className="rounded-md border p-3"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-sm font-medium">Variant {index + 1}</div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeVariant(index)}
                aria-label={`Remove variant ${index + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor={`variant-name-${index}`}>Name</Label>
                <Input
                  id={`variant-name-${index}`}
                  value={asString(variant.name, asString(variant.label))}
                  onChange={(event) =>
                    patchVariant(index, { name: event.target.value })
                  }
                />
              </div>
              <div className="grid gap-2 md:col-span-2">
                <Label htmlFor={`variant-subject-${index}`}>Subject</Label>
                <Input
                  id={`variant-subject-${index}`}
                  value={asString(variant.subject, campaignSubject)}
                  onChange={(event) =>
                    patchVariant(index, { subject: event.target.value })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`variant-weight-${index}`}>Weight</Label>
                <Input
                  id={`variant-weight-${index}`}
                  type="number"
                  min={0}
                  max={100}
                  value={asNumber(variant.weight, 50)}
                  onChange={(event) =>
                    patchVariant(index, {
                      weight: Number(event.target.value) || 0,
                    })
                  }
                />
              </div>
              <div className="grid gap-2 md:col-span-2">
                <Label htmlFor={`variant-preview-${index}`}>Preview text</Label>
                <Input
                  id={`variant-preview-${index}`}
                  value={asString(variant.preview_text)}
                  onChange={(event) =>
                    patchVariant(index, { preview_text: event.target.value })
                  }
                />
              </div>
              <div className="grid gap-2 md:col-span-3">
                <Label htmlFor={`variant-html-${index}`}>Variant HTML</Label>
                <Textarea
                  id={`variant-html-${index}`}
                  className="min-h-[160px] font-mono text-xs"
                  value={asString(variant.body_html)}
                  onChange={(event) =>
                    patchVariant(index, { body_html: event.target.value })
                  }
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
