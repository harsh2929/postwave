// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Form-variant configuration (FORM-009). The control plane is mounted, but the
// public hosted-form renderer does not call its picker, so this surface never
// claims its stored counters or weights are live traffic evidence.

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableSkeleton } from "@/components/dashboard/skeletons";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  createFormVariant,
  deleteFormVariant,
  listFormVariantPromotions,
  listFormVariants,
  updateFormVariant,
} from "@/lib/forms-api";
import { formatCount } from "@/lib/forms-list-helpers";
import { base, qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import type { FormVariant, FormVariantStatus } from "@/lib/forms-types";

const STATUS_VARIANT: Record<
  FormVariantStatus,
  "success" | "secondary" | "outline" | "warning"
> = {
  exploring: "secondary",
  paused: "warning",
  promoted: "success",
};

const VARIANT_RUNTIME_HOLD =
  "Configuration only: hosted form rendering does not currently call the variant picker, so no public traffic is split and these counters are not live evidence. Evaluation and promotion stay unavailable until public render and submission attribution are mounted.";

export function VariantsPanel({ formId }: { formId: string }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [traffic, setTraffic] = useState("50");
  const [pendingDelete, setPendingDelete] = useState<FormVariant | null>(null);
  const [editing, setEditing] = useState<FormVariant | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editTraffic, setEditTraffic] = useState("");

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const tenantId = identity?.tenant_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = Boolean(
    identity && !identity.viewer_mode && roleCanWrite(role),
  );
  const variantsBase = useMemo(
    () => [...base("forms", tenantId, role), "variants", formId] as const,
    [tenantId, role, formId],
  );

  const variantsQuery = useQuery({
    queryKey: [...variantsBase, "list"] as const,
    queryFn: () => listFormVariants(formId),
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const promotionsQuery = useQuery({
    queryKey: [...variantsBase, "promotions"] as const,
    queryFn: () => listFormVariantPromotions(formId),
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: variantsBase,
      exact: false,
    });

  const createMut = useMutation({
    mutationFn: async () => {
      if (!identity) throw new Error("Workspace identity is unavailable.");
      await verifyFreshAdminAuthority(identity);
      return createFormVariant(formId, {
        label: label.trim(),
        trafficPct: Number(traffic),
      });
    },
    onSuccess: async () => {
      setLabel("");
      await invalidate();
      toast.success("Variant created.");
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Could not create variant.",
      ),
  });

  const editMut = useMutation({
    mutationFn: async () => {
      if (!identity || !editing)
        throw new Error("Workspace identity or variant is unavailable.");
      await verifyFreshAdminAuthority(identity);
      return updateFormVariant(formId, editing.id, {
        label: editLabel.trim(),
        trafficPct: Number(editTraffic),
      });
    },
    onSuccess: async () => {
      await invalidate();
      setEditing(null);
      toast.success("Variant configuration updated.");
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Variant update failed.",
      ),
  });

  const variants = Array.isArray(variantsQuery.data) ? variantsQuery.data : [];
  const promotions = Array.isArray(promotionsQuery.data)
    ? promotionsQuery.data
    : [];
  const trafficNumber = Number(traffic);
  const createValid =
    label.trim().length > 0 &&
    label.trim().length <= 64 &&
    traffic.trim().length > 0 &&
    Number.isInteger(trafficNumber) &&
    trafficNumber >= 0 &&
    trafficNumber <= 100;
  const editTrafficNumber = Number(editTraffic);
  const editValid =
    editLabel.trim().length > 0 &&
    editLabel.trim().length <= 64 &&
    editTraffic.trim().length > 0 &&
    Number.isInteger(editTrafficNumber) &&
    editTrafficNumber >= 0 &&
    editTrafficNumber <= 100;

  function openEdit(variant: FormVariant) {
    setEditing(variant);
    setEditLabel(variant.label);
    setEditTraffic(String(variant.trafficPct));
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h3 className="text-sm font-semibold">A/B variants</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Store alternative display configurations and traffic weights for a
          future hosted-form runtime.
        </p>
      </div>

      <p
        role="note"
        className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
      >
        {VARIANT_RUNTIME_HOLD}
      </p>

      {/* Create */}
      {canAdmin ? (
        <form
          className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (createValid && !createMut.isPending) createMut.mutate();
          }}
        >
          <div className="flex-1 min-w-[12rem]">
            <Label htmlFor="variant-label">Variant label</Label>
            <Input
              id="variant-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Headline B"
              maxLength={64}
            />
          </div>
          <div className="w-28">
            <Label htmlFor="variant-traffic">Traffic %</Label>
            <Input
              id="variant-traffic"
              type="number"
              min={0}
              max={100}
              value={traffic}
              onChange={(e) => setTraffic(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={!createValid || createMut.isPending}>
            {createMut.isPending ? "Adding…" : "Add variant"}
          </Button>
        </form>
      ) : meQuery.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Verifying workspace authority…
        </p>
      ) : meQuery.isError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 p-3"
        >
          <p className="text-sm text-destructive">
            Workspace identity could not be verified, so variant data and write
            controls were not requested.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={meQuery.isFetching}
            onClick={() => void meQuery.refetch()}
          >
            {meQuery.isFetching ? "Retrying…" : "Retry identity"}
          </Button>
        </div>
      ) : (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          Variant configuration is read-only. Owner or admin access is required
          to create, edit, or delete it.
        </p>
      )}

      {/* List */}
      {!meQuery.isSuccess ? null : variantsQuery.isPending &&
        !variantsQuery.data ? (
        <TableSkeleton
          rows={3}
          columns={["w-40", "w-16", "w-20", "w-20", "w-20", "w-16"]}
        />
      ) : variantsQuery.isError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 p-3"
        >
          <p className="text-sm text-destructive">
            Variant configuration could not be loaded. This is not an empty
            configuration.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={variantsQuery.isFetching}
            onClick={() => void variantsQuery.refetch()}
          >
            {variantsQuery.isFetching ? "Retrying…" : "Retry variants"}
          </Button>
        </div>
      ) : variants.length === 0 ? (
        <div className="rounded-md border bg-card p-8 text-center text-sm text-muted-foreground">
          {canAdmin
            ? "No variant configurations yet. Add one above to prepare a future hosted-form runtime."
            : "No variant configurations exist. An owner or admin can prepare one for a future hosted-form runtime."}
        </div>
      ) : (
        <div
          role="region"
          aria-label="Form variants"
          tabIndex={0}
          className="rounded-md border bg-card overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Variant
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  Traffic
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  Impressions
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  Submissions
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  Conversion
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {variants.map((v) => (
                <tr key={v.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{v.label}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {v.trafficPct}%
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatCount(Number(v.impressions))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatCount(Number(v.submissions))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {(v.conversionRate * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_VARIANT[v.status] ?? "outline"}>
                      {v.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canAdmin ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(v)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setPendingDelete(v)}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Promotions history */}
      {promotions.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Stored promotion records
          </h4>
          <p className="text-xs text-muted-foreground">
            Historical control-plane records are not proof that the current
            public form served variant traffic.
          </p>
          <ul className="space-y-1 text-sm">
            {promotions.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2"
              >
                <span className="font-medium">Winner:</span>
                <code className="text-xs">{p.winnerVariantId}</code>
                <span className="text-muted-foreground">
                  {(p.winnerRate * 100).toFixed(1)}% vs{" "}
                  {(p.runnerUpRate * 100).toFixed(1)}% · z={p.zScore.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {promotionsQuery.isError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 p-3"
        >
          <p className="text-sm text-destructive">
            Stored promotion records could not be loaded.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={promotionsQuery.isFetching}
            onClick={() => void promotionsQuery.refetch()}
          >
            {promotionsQuery.isFetching ? "Retrying…" : "Retry records"}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title="Delete variant?"
        description={
          pendingDelete
            ? `"${pendingDelete.label}" and its metrics will be removed.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!pendingDelete || !identity) return;
          try {
            await verifyFreshAdminAuthority(identity);
            await deleteFormVariant(formId, pendingDelete.id);
            await invalidate();
            toast.success("Variant deleted.");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Delete failed.");
          } finally {
            setPendingDelete(null);
          }
        }}
      />

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !editMut.isPending) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit variant configuration</DialogTitle>
            <DialogDescription>
              This updates stored configuration only. It does not activate live
              traffic splitting or evaluation.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (editValid && !editMut.isPending) editMut.mutate();
            }}
          >
            <div>
              <Label htmlFor="edit-variant-label">Variant label</Label>
              <Input
                id="edit-variant-label"
                value={editLabel}
                maxLength={64}
                disabled={editMut.isPending}
                onChange={(event) => setEditLabel(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="edit-variant-traffic">Stored traffic %</Label>
              <Input
                id="edit-variant-traffic"
                type="number"
                min={0}
                max={100}
                step={1}
                value={editTraffic}
                disabled={editMut.isPending}
                onChange={(event) => setEditTraffic(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={editMut.isPending}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!editValid || editMut.isPending}>
                {editMut.isPending ? "Saving…" : "Save configuration"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
