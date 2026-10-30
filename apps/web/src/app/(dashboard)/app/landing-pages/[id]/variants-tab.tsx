// SPDX-License-Identifier: AGPL-3.0-only
//
// LAND-037 — A/B variants manager for a landing page. Lists variants with their
// traffic weight and per-variant view/conversion metrics, and lets the operator
// add/weight/retire variants. A variant captures a snapshot of page content, so
// the workflow is: edit the page on the Content tab, then "Capture current
// content as a variant" here — giving two servable arms whose split + metrics
// are fully tracked. Weight 0 pauses an arm without deleting its history.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  landingPagesApi,
  type LandingPageVariant,
  type LandingPageVariantInput,
} from "@/lib/landing-pages-api";
import type { MeResponse } from "@/lib/auth-api";
import {
  confirmFreshLandingPageAdminAuthority,
  LANDING_PAGE_ADMIN_ONLY_MESSAGE,
} from "@/lib/landing-page-authority";

function pctLabel(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function VariantsTab({
  pageId,
  currentBlocks,
  baseKey,
  identity,
  canAdmin,
}: {
  pageId: string;
  currentBlocks: Array<Record<string, unknown>>;
  baseKey: readonly unknown[];
  identity: MeResponse | null | undefined;
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const key = [...baseKey, "variants", pageId] as const;
  const variantsQuery = useQuery({
    queryKey: key,
    queryFn: () => landingPagesApi.listVariants(pageId),
  });
  const variants = useMemo(
    () => (Array.isArray(variantsQuery.data) ? variantsQuery.data : []),
    [variantsQuery.data],
  );

  const [newName, setNewName] = useState("");
  const activeWritesRef = useRef<Set<string>>(new Set());
  const invalidate = () => void qc.invalidateQueries({ queryKey: key });

  async function runAdminWrite<T>(
    lockKey: string,
    transport: () => Promise<T>,
  ): Promise<T> {
    if (!canAdmin || !identity) {
      throw new Error(LANDING_PAGE_ADMIN_ONLY_MESSAGE);
    }
    if (activeWritesRef.current.has(lockKey)) {
      throw new Error("This variant change is already in progress.");
    }
    activeWritesRef.current.add(lockKey);
    try {
      await confirmFreshLandingPageAdminAuthority(identity);
      return await transport();
    } finally {
      activeWritesRef.current.delete(lockKey);
    }
  }

  // Capturing the current page content twice without editing in between would
  // produce two byte-identical arms — the operator thinks they're testing but
  // both serve the same thing. Detect that so we can warn + block the capture.
  const currentSig = useMemo(
    () => JSON.stringify(currentBlocks ?? []),
    [currentBlocks],
  );
  const duplicateOfExisting = useMemo(
    () => variants.some((v) => JSON.stringify(v.blocks ?? []) === currentSig),
    [variants, currentSig],
  );

  const createMutation = useMutation({
    mutationFn: (intent: LandingPageVariantInput) =>
      runAdminWrite("create", () =>
        landingPagesApi.createVariant(pageId, intent),
      ),
    onSuccess: () => {
      setNewName("");
      invalidate();
      toast.success("Variant captured.");
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not add variant."),
  });

  const patchMutation = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Parameters<typeof landingPagesApi.updateVariant>[2];
    }) =>
      runAdminWrite(`variant:${id}`, () =>
        landingPagesApi.updateVariant(pageId, id, patch),
      ),
    onSuccess: () => invalidate(),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not update variant."),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      runAdminWrite(`variant:${id}`, () =>
        landingPagesApi.deleteVariant(pageId, id),
      ),
    onSuccess: () => {
      invalidate();
      toast.success("Variant deleted.");
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not delete variant."),
  });

  const totalWeight = variants.reduce(
    (sum, v) => sum + (v.weight > 0 ? v.weight : 0),
    0,
  );

  return (
    <section className="space-y-4 rounded-md border bg-card p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">A/B variants</h2>
        <p className="text-xs text-muted-foreground">
          Split traffic across content variants and compare conversion. A
          published page with variants serves each visitor one arm (weighted)
          and attributes their conversion to it. With no variants, the page
          serves its own content as the control.
        </p>
      </div>

      {canAdmin ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">New variant name</span>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={`Variant ${variants.length + 1}`}
              className="h-9 w-48"
            />
          </label>
          <Button
            type="button"
            size="sm"
            disabled={createMutation.isPending || duplicateOfExisting}
            title={
              duplicateOfExisting
                ? "This matches an existing variant exactly. Edit the page content on the Content tab first, then capture."
                : undefined
            }
            onClick={() =>
              createMutation.mutate({
                name: newName.trim() || `Variant ${variants.length + 1}`,
                weight: 50,
                // Freeze the exact nested page content represented by this
                // click before the online authority check begins.
                blocks: structuredClone(currentBlocks),
                is_control: variants.length === 0,
              })
            }
          >
            <Plus className="h-4 w-4" />
            Capture current content as a variant
          </Button>
          {duplicateOfExisting ? (
            <p className="w-full text-xs text-warning-emphasis">
              The current page content is identical to an existing variant. Edit
              the page (Content tab) before capturing so the arms actually
              differ.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {LANDING_PAGE_ADMIN_ONLY_MESSAGE} Variant metrics remain available to
          review.
        </p>
      )}

      {variantsQuery.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : variantsQuery.isError ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground sm:flex-row sm:items-center sm:justify-between"
        >
          <p>
            Could not load variants — this is a failed request, not an empty
            experiment.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void variantsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : variants.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
          No variants yet. Capture the current page content as your first
          variant, then edit the page and capture a second to start an A/B test.
        </p>
      ) : (
        <div
          role="region"
          aria-label="Landing page A/B variants"
          tabIndex={0}
          className="overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <table className="w-full text-sm">
            <caption className="sr-only">Landing page A/B variants</caption>
            <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Variant
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Traffic
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Views
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Conversions
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Rate
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {variants.map((v) => (
                <VariantRow
                  key={v.id}
                  v={v}
                  totalWeight={totalWeight}
                  canWrite={canAdmin}
                  busy={patchMutation.isPending || deleteMutation.isPending}
                  onPatch={(patch) =>
                    patchMutation.mutate({
                      id: v.id,
                      patch: structuredClone(patch),
                    })
                  }
                  onDelete={() => deleteMutation.mutate(v.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function VariantRow({
  v,
  totalWeight,
  canWrite,
  busy,
  onPatch,
  onDelete,
}: {
  v: LandingPageVariant;
  totalWeight: number;
  canWrite: boolean;
  busy: boolean;
  onPatch: (patch: { weight?: number; is_control?: boolean }) => void;
  onDelete: () => void;
}) {
  const [weight, setWeight] = useState(String(v.weight));
  // The backend clamps weight (e.g. negatives → 0); resync the input to the
  // server value after a refetch so the field never lies about what was saved.
  useEffect(() => {
    setWeight(String(v.weight));
  }, [v.weight]);
  const share =
    totalWeight > 0 && v.weight > 0
      ? `${Math.round((v.weight / totalWeight) * 100)}%`
      : v.weight === 0
        ? "paused"
        : "—";

  return (
    <tr className={v.is_control ? "bg-primary/5" : ""}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{v.name || "Untitled"}</span>
          {v.is_control ? (
            <span className="rounded-full border border-primary/40 px-2 py-0.5 text-[10px] font-medium text-primary">
              control
            </span>
          ) : canWrite ? (
            <button
              type="button"
              className="inline-flex min-h-8 items-center rounded-sm text-xs text-muted-foreground underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              disabled={busy}
              onClick={() => onPatch({ is_control: true })}
            >
              make control
            </button>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2">
        {canWrite ? (
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={0}
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              onBlur={() => {
                const w = Number(weight);
                if (Number.isFinite(w) && w >= 0 && w !== v.weight) {
                  onPatch({ weight: Math.floor(w) });
                }
              }}
              aria-label={`Weight for ${v.name}`}
              className="h-8 w-20"
            />
            <span className="text-xs text-muted-foreground">{share}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {v.weight} ({share})
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {v.views.toLocaleString()}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {v.conversions.toLocaleString()}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {v.views > 0 ? pctLabel(v.conversion_rate) : "—"}
      </td>
      <td className="px-3 py-2 text-right">
        {canWrite ? (
          <ConfirmDialog
            title={`Delete variant "${v.name || "Untitled"}"?`}
            description="The variant is removed. Its recorded views/conversions stay in history."
            confirmLabel="Delete"
            onConfirm={onDelete}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-destructive hover:text-destructive"
                aria-label={`Delete ${v.name}`}
                disabled={busy}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            }
          />
        ) : null}
      </td>
    </tr>
  );
}
