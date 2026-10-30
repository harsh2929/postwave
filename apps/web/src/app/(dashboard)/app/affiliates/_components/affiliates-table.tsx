// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  updateAffiliate,
  type AffiliateProgramRow,
} from "@/lib/affiliates-api";
import { formatCents } from "@/lib/affiliates-types";

import { AffiliateStatusBadge } from "./status-badge";

/**
 * Affiliates list table with inline moderation (BILL-031): pending rows get an
 * Approve action, approved rows a Suspend action, plus multi-select bulk
 * approval — so operators don't have to open each detail page → Settings tab →
 * status select just to approve one affiliate. Backed by the mounted
 * PATCH /api/v1/admin/affiliates/{id}. Truncates long names/emails (BILL-041).
 */
export function AffiliatesTable({ rows }: { rows: AffiliateProgramRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const pendingIds = useMemo(
    () =>
      rows
        .filter((r) => r.affiliate.status === "pending")
        .map((r) => r.affiliate.id),
    [rows],
  );
  const selectedPending = pendingIds.filter((id) => selected.has(id));
  const allPendingSelected =
    pendingIds.length > 0 && selectedPending.length === pendingIds.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllPending() {
    setSelected(allPendingSelected ? new Set() : new Set(pendingIds));
  }

  async function setStatus(id: string, status: "approved" | "suspended") {
    setBusy(true);
    try {
      await updateAffiliate(id, { status });
      toast.success(
        status === "approved" ? "Affiliate approved." : "Affiliate suspended.",
      );
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not update affiliate.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function approveSelected() {
    setBusy(true);
    const ids = [...selectedPending];
    try {
      const results = await Promise.allSettled(
        ids.map((id) => updateAffiliate(id, { status: "approved" })),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - ok;
      if (ok > 0)
        toast.success(`Approved ${ok} affiliate${ok === 1 ? "" : "s"}.`);
      if (failed > 0)
        toast.error(`${failed} approval${failed === 1 ? "" : "s"} failed.`);
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {selectedPending.length > 0 ? (
        <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-2 text-sm">
          <span>{selectedPending.length} pending selected</span>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void approveSelected()}
          >
            Approve selected
          </Button>
        </div>
      ) : null}
      <TableContainer>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-10">
                {pendingIds.length > 0 ? (
                  <Checkbox
                    aria-label="Select all pending affiliates"
                    checked={allPendingSelected}
                    onChange={toggleAllPending}
                  />
                ) : null}
              </TableHead>
              <TableHead scope="col">Affiliate</TableHead>
              <TableHead scope="col">Country</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col" className="text-right">
                Lifetime commission
              </TableHead>
              <TableHead scope="col" className="text-right">
                Conversions
              </TableHead>
              <TableHead scope="col" className="text-right">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ affiliate: a, lifetime }) => (
              <TableRow key={a.id} className="hover:bg-muted/30">
                <TableCell>
                  {a.status === "pending" ? (
                    <Checkbox
                      aria-label={`Select ${a.name}`}
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                    />
                  ) : null}
                </TableCell>
                <TableCell className="max-w-[220px]">
                  <Link
                    href={`/app/affiliates/${a.id}`}
                    className="block truncate font-medium hover:underline underline-offset-4"
                    title={a.name}
                  >
                    {a.name}
                  </Link>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={a.email}
                  >
                    {a.email}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {a.country ?? "—"}
                </TableCell>
                <TableCell>
                  <AffiliateStatusBadge status={a.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCents(lifetime.totalCommissionCents)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {lifetime.conversions.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    {a.status === "pending" ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => void setStatus(a.id, "approved")}
                      >
                        Approve
                      </Button>
                    ) : null}
                    {a.status === "approved" ? (
                      <ConfirmDialog
                        trigger={
                          <Button type="button" size="sm" variant="outline">
                            Suspend
                          </Button>
                        }
                        title={`Suspend ${a.name}?`}
                        description="Suspended affiliates stop accruing new commission. You can re-approve them later."
                        confirmLabel="Suspend"
                        confirmVariant="destructive"
                        onConfirm={() => setStatus(a.id, "suspended")}
                      />
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}
