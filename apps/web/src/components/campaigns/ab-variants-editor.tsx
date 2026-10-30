// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { Copy, Eye, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { compileMjmlToHtml } from "@/lib/abtests-api";
import type { Variant } from "@/lib/abtests-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { EmailPreview } from "@/components/campaigns/email-preview";
import { ContentTestSendDialog } from "@/components/content-test-send-dialog";

const MAX_VARIANTS = 4;
const LABELS = ["A", "B", "C", "D"];

interface AbVariantsEditorProps {
  initial?: Variant[];
  onChange?: (variants: Variant[]) => void;
}

/** The two-arm default an A/B test starts with. Exported so the parent can seed
 *  its state with these exact variants — otherwise the editor showed A/B while
 *  the parent held [], and Save persisted zero variants (CAMP-028). */
export function defaultAbVariants(): Variant[] {
  return [defaultVariant("A", 50), defaultVariant("B", 50)];
}

/**
 * The first label not already taken by an existing arm.
 *
 * Naming by POSITION (`LABELS[variants.length]`) collides after a middle
 * variant is removed: [A, B, C] − B = [A, C], whose length is 2, so the next
 * add is named "C" again. `variant_label` is identity-bearing — ab-results
 * resolves an arm with `variants.find(v => v.variant_label === operand)` — so
 * two arms sharing a label report the second one's numbers under the first.
 */
export function nextVariantLabel(variants: Variant[]): string {
  const taken = new Set(
    variants.map((v) => (v.variant_label ?? "").trim().toUpperCase()),
  );
  const free = LABELS.find((l) => !taken.has(l));
  if (free) return free;
  // Past the fixed alphabet, keep counting until something is genuinely unused.
  for (let n = variants.length + 1; ; n += 1) {
    const candidate = `V${n}`;
    if (!taken.has(candidate.toUpperCase())) return candidate;
  }
}

/**
 * AbVariantsEditor — N variant cards (max 4) with subject, from-name, MJML
 * body, and a weight slider. Weights are normalized to sum to 100 on save;
 * we display them live and let the user fine-tune.
 */
export function AbVariantsEditor({ initial, onChange }: AbVariantsEditorProps) {
  const variants =
    initial && initial.length > 0 ? initial : defaultAbVariants();

  const update = (next: Variant[]) => {
    onChange?.(next);
  };

  const onPatch = (idx: number, patch: Partial<Variant>) => {
    update(variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  };

  const onRemove = (idx: number) => {
    if (variants.length <= 2) return;
    update(variants.filter((_, i) => i !== idx));
  };

  const onAdd = () => {
    if (variants.length >= MAX_VARIANTS) return;
    const label = nextVariantLabel(variants);
    const evenWeight = Math.floor(100 / (variants.length + 1));
    update([...variants, defaultVariant(label, evenWeight)]);
  };

  const onDuplicate = (idx: number) => {
    if (variants.length >= MAX_VARIANTS) return;
    const label = nextVariantLabel(variants);
    const source = variants[idx];
    const copy: Variant = {
      ...source,
      id: undefined,
      variant_label: label,
      subject: source.subject ? `${source.subject} (copy)` : "",
    };
    update([...variants.slice(0, idx + 1), copy, ...variants.slice(idx + 1)]);
  };

  const totalWeight = variants.reduce((acc, v) => acc + (v.weight || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Weights total {totalWeight}. They&apos;ll be normalized to 100% on
          save.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAdd}
          disabled={variants.length >= MAX_VARIANTS}
        >
          <Plus className="h-4 w-4" /> Add variant
        </Button>
      </div>

      <div className="space-y-3">
        {variants.map((v, idx) => (
          <VariantCard
            key={idx}
            variant={v}
            index={idx}
            canRemove={variants.length > 2}
            canDuplicate={variants.length < MAX_VARIANTS}
            onPatch={(patch) => onPatch(idx, patch)}
            onRemove={() => onRemove(idx)}
            onDuplicate={() => onDuplicate(idx)}
          />
        ))}
      </div>
    </div>
  );
}

function VariantCard({
  variant,
  index,
  canRemove,
  canDuplicate,
  onPatch,
  onRemove,
  onDuplicate,
}: {
  variant: Variant;
  index: number;
  canRemove: boolean;
  canDuplicate: boolean;
  onPatch: (patch: Partial<Variant>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const togglePreview = async () => {
    if (previewHtml !== null) {
      setPreviewHtml(null);
      return;
    }
    setPreviewing(true);
    try {
      const html = await compileMjmlToHtml(variant.body_mjml ?? "");
      setPreviewHtml(html);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not compile preview.",
      );
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-foreground text-background text-xs font-semibold">
              {variant.variant_label}
            </span>
            <span className="text-sm font-medium">
              Variant {variant.variant_label}
            </span>
          </div>
          <div
            className="grid w-full grid-cols-[minmax(0,1fr)_repeat(3,2.75rem)] gap-1 sm:flex sm:w-auto sm:items-center"
            role="group"
            aria-label={`Actions for variant ${variant.variant_label}`}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 min-w-0 px-2 sm:min-h-0 sm:px-3"
              onClick={() => void togglePreview()}
              disabled={previewing}
              aria-label={`${previewHtml !== null ? "Hide preview" : "Preview"} variant ${variant.variant_label}`}
            >
              {previewing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
              {previewHtml !== null ? "Hide preview" : "Preview"}
            </Button>
            {/* CAMP-046: send this variant's own subject + body to an inbox. */}
            <ContentTestSendDialog
              content={() => ({
                subject: variant.subject ?? "",
                body_mjml: variant.body_mjml || undefined,
                body_html: previewHtml || undefined,
              })}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 min-w-11 px-2 sm:min-h-0 sm:min-w-0 sm:px-3"
                  aria-label={`Send a test of variant ${variant.variant_label}`}
                >
                  <Send className="h-4 w-4" />
                </Button>
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 min-w-11 px-2 sm:min-h-0 sm:min-w-0 sm:px-3"
              onClick={onDuplicate}
              disabled={!canDuplicate}
              aria-label={`Duplicate variant ${variant.variant_label}`}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 min-w-11 px-2 sm:min-h-0 sm:min-w-0 sm:px-3"
              onClick={onRemove}
              disabled={!canRemove}
              aria-label={`Remove variant ${variant.variant_label}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`subject-${index}`}>Subject</Label>
            <Input
              id={`subject-${index}`}
              value={variant.subject ?? ""}
              onChange={(e) => onPatch({ subject: e.target.value })}
              placeholder="Subject line"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`from-${index}`}>From name</Label>
            <Input
              id={`from-${index}`}
              value={variant.from_name ?? ""}
              onChange={(e) => onPatch({ from_name: e.target.value })}
              placeholder="The Demo Team"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`from-email-${index}`}>From email</Label>
            <Input
              id={`from-email-${index}`}
              type="email"
              value={variant.from_email ?? ""}
              onChange={(e) => onPatch({ from_email: e.target.value })}
              placeholder="team@example.com"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`body-${index}`}>Body (MJML)</Label>
          <Textarea
            id={`body-${index}`}
            value={variant.body_mjml ?? ""}
            onChange={(e) => onPatch({ body_mjml: e.target.value })}
            rows={6}
            className="font-mono text-xs"
            placeholder="<mjml>…</mjml>"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>Weight</Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {variant.weight}%
            </span>
          </div>
          <Slider
            value={variant.weight}
            min={0}
            max={100}
            step={5}
            onChange={(value) => onPatch({ weight: value })}
            aria-label={`Weight for variant ${variant.variant_label}`}
          />
        </div>

        {previewHtml !== null ? (
          <EmailPreview
            html={previewHtml}
            emptyLabel="This variant has no compiled content yet."
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function defaultVariant(label: string, weight: number): Variant {
  return {
    variant_label: label,
    subject: "",
    from_name: "",
    from_email: "",
    body_mjml: "",
    weight,
  };
}
