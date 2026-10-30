// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";
import { FileCode2, SquareDashed } from "lucide-react";
import { useId } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import {
  getCampaignTemplateRegions,
  templateRegionKeys,
  type CampaignTemplateRegion,
} from "@/lib/template-regions-api";

/**
 * Saved editable regions for a template (desktop parity: the slideover's
 * Regions pane). Lists every `{{region:name}}…{{/region}}` zone the server
 * parsed from the SAVED source and opens the HTML editor on the one chosen.
 *
 * The list describes the saved version. When the draft has diverged the panel
 * says so, and the form re-finds each region by name instead of trusting a
 * byte offset from an older body.
 */
export function TemplateRegionsPanel({
  templateId,
  etag,
  sourceLabel,
  draftDiverged,
  onOpenRegion,
  onOpenEditor,
}: {
  templateId: string;
  etag: string | null | undefined;
  /** "HTML" or "MJML": which saved body the server parsed. */
  sourceLabel: string;
  draftDiverged: boolean;
  /** Open the source editor with this region (the `ordinal`-th of its name) selected. */
  onOpenRegion: (region: CampaignTemplateRegion, ordinal: number) => void;
  onOpenEditor: () => void;
}) {
  const headingId = useId();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: () => whoami(),
    staleTime: STALE.authMe,
  });
  const me = meQuery.data;
  const regionsQuery = useQuery({
    queryKey: templateRegionKeys.list(
      me?.tenant_id ?? "anon",
      me ? effectiveAuthRole(me) : null,
      templateId,
      etag,
    ),
    queryFn: ({ signal }) => getCampaignTemplateRegions(templateId, { signal }),
    enabled: Boolean(me),
    staleTime: STALE.detail,
  });
  const regions = Array.isArray(regionsQuery.data) ? regionsQuery.data : null;

  const ordinals = new Map<string, number>();
  const rows = regions
    ? regions.map((region) => {
        const ordinal = ordinals.get(region.name) ?? 0;
        ordinals.set(region.name, ordinal + 1);
        return { region, ordinal };
      })
    : [];

  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-3 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SquareDashed className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 id={headingId} className="text-sm font-medium">
          Editable regions
        </h2>
      </div>

      {meQuery.isError ? (
        <div role="alert" className="grid gap-2 text-sm">
          <p>
            {apiErrorMessage(
              meQuery.error,
              "Your workspace identity could not be loaded, so saved regions were not read.",
            )}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="justify-self-start"
            onClick={() => void meQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : regionsQuery.isError ? (
        <div role="alert" className="grid gap-2 text-sm">
          <p>
            Saved regions could not be loaded:{" "}
            {apiErrorMessage(regionsQuery.error, "The regions request failed.")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="justify-self-start"
            onClick={() => void regionsQuery.refetch()}
          >
            Retry saved regions
          </Button>
        </div>
      ) : !regions ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading saved regions…
        </p>
      ) : regions.length === 0 ? (
        <div className="grid gap-2 text-sm">
          <p className="font-medium">No editable regions</p>
          <p className="text-muted-foreground">
            Wrap each editable block in{" "}
            <code className="font-mono text-xs">
              {"{{region:name}}…{{/region}}"}
            </code>{" "}
            in the template source, then save, to surface it here.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="justify-self-start"
            onClick={onOpenEditor}
          >
            <FileCode2 className="h-4 w-4" aria-hidden />
            Open {sourceLabel} editor
          </Button>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {regions.length} editable region{regions.length === 1 ? "" : "s"} in
            the saved {sourceLabel}. Open the {sourceLabel} editor to review or
            change a region&apos;s default content.
          </p>
          {draftDiverged ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              Your source has unsaved changes. These regions describe the saved
              version; each one is located by name in your draft when opened.
            </p>
          ) : null}
          <ul className="grid gap-2">
            {rows.map(({ region, ordinal }) => (
              <li
                key={`${region.name}-${region.position}`}
                className="grid gap-2 rounded-md border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono">
                      {region.name}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      offset {region.position}, span {region.length}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Open ${sourceLabel} editor for region ${region.name}`}
                    onClick={() => onOpenRegion(region, ordinal)}
                  >
                    Open {sourceLabel} editor
                  </Button>
                </div>
                <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 font-mono text-[11px] leading-5">
                  {region.default_html || "(empty default)"}
                </pre>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
