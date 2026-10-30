// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import {
  campaignTemplateCapabilities,
  campaignTemplateThumbnailUrl,
  searchCampaignTemplates,
  type CampaignTemplateSummary,
} from "@/lib/campaign-templates-api";
import { cn } from "@/lib/utils";

import { PreviewImage } from "./preview-image";

function eligible(items: CampaignTemplateSummary[], excludeId?: string) {
  return items.filter(
    (template) =>
      template.id !== excludeId &&
      campaignTemplateCapabilities(template).can_adapt,
  );
}

export function CampaignTemplateReferencePicker({
  selected,
  onChange,
  initialTemplates = [],
  max = 3,
  excludeId,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  initialTemplates?: CampaignTemplateSummary[];
  max?: number;
  excludeId?: string;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState(() =>
    eligible(initialTemplates, excludeId),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerID = useId();
  const searchID = `${pickerID}-search`;
  const helpID = `${pickerID}-help`;
  const errorID = `${pickerID}-error`;
  const selectedItems = useRef(
    new Map(items.map((template) => [template.id, template])),
  );
  const sequence = useRef(0);

  useEffect(() => {
    for (const template of items)
      selectedItems.current.set(template.id, template);
  }, [items]);

  useEffect(() => {
    const request = ++sequence.current;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void searchCampaignTemplates({
        q: query.trim() || undefined,
        perPage: 40,
      })
        .then((response) => {
          if (!active || request !== sequence.current) return;
          setItems(eligible(response.items, excludeId));
        })
        .catch((searchError: unknown) => {
          if (!active || request !== sequence.current) return;
          setError(
            apiErrorMessage(
              searchError,
              "Eligible reference designs could not be searched.",
            ),
          );
        })
        .finally(() => {
          if (active && request === sequence.current) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [excludeId, query]);

  const visible = useMemo(() => {
    const byID = new Map(items.map((template) => [template.id, template]));
    for (const id of selected) {
      const template = selectedItems.current.get(id);
      if (template) byID.set(id, template);
    }
    return Array.from(byID.values());
  }, [items, selected]);

  const toggle = (template: CampaignTemplateSummary) => {
    if (!campaignTemplateCapabilities(template).can_adapt) return;
    if (selected.includes(template.id)) {
      onChange(selected.filter((id) => id !== template.id));
      return;
    }
    if (selected.length < max) onChange([...selected, template.id]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={searchID}>Reference designs (optional)</Label>
        <Badge
          variant="outline"
          role="status"
          aria-live="polite"
          aria-label={`${selected.length} of ${max} reference designs selected`}
        >
          {selected.length}/{max}
        </Badge>
      </div>
      <p id={helpID} className="text-xs text-muted-foreground">
        Searches the complete server catalogue. Only designs the server marks
        eligible for adaptation can be selected.
      </p>
      <span className="relative block">
        <Search
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id={searchID}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search all eligible designs"
          className="h-9 pl-9"
          aria-describedby={error ? `${helpID} ${errorID}` : helpID}
        />
      </span>
      {error ? (
        <p id={errorID} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-label="Reference search status"
      >
        {loading
          ? "Searching the catalogue."
          : error
            ? "Reference search failed."
            : `${visible.length} eligible reference design${
                visible.length === 1 ? "" : "s"
              } found.`}
      </p>
      <div
        className="max-h-[420px] space-y-2 overflow-y-auto pr-1"
        role="group"
        aria-label="Eligible reference designs"
        aria-busy={loading}
      >
        {visible.map((template) => {
          const isSelected = selected.includes(template.id);
          const atLimit = selected.length >= max && !isSelected;
          return (
            <button
              key={template.id}
              type="button"
              aria-pressed={isSelected}
              aria-label={`${isSelected ? "Deselect" : "Select"} ${template.name}${
                atLimit ? "; maximum reference designs selected" : ""
              }`}
              disabled={atLimit}
              onClick={() => toggle(template)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md border p-2 text-left transition-colors",
                isSelected
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "hover:border-foreground/30 hover:bg-muted/40",
                atLimit && "cursor-not-allowed opacity-50",
              )}
            >
              <PreviewImage
                src={campaignTemplateThumbnailUrl(template)}
                alt=""
                className="h-14 w-11 shrink-0 rounded border object-cover object-top"
                wrapperClassName="h-14 w-11 shrink-0 min-h-0 py-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {template.name}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {[template.style, template.layout_archetype]
                    .filter(Boolean)
                    .join(" · ") ||
                    template.category ||
                    "Newsletter"}
                </span>
              </span>
            </button>
          );
        })}
        {!visible.length && !loading ? (
          <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">
            No eligible references match this search.
          </div>
        ) : null}
        {loading ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            Searching the catalogue…
          </p>
        ) : null}
      </div>
    </div>
  );
}
