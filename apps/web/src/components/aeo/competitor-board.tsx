// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  aeoKeys,
  deleteAeoCompetitor,
  isAeoContractError,
  listAeoCompetitors,
  upsertAeoCompetitor,
  type AEOCompetitorScore,
} from "@/lib/aeo-api";
import { apiErrorMessage } from "@/lib/api";
import { STALE, type RoleKey } from "@/lib/query-keys";

import { pct, splitTerms } from "./aeo-format";

export interface CompetitorBoardProps {
  tenantId: string;
  role: RoleKey;
  scores: AEOCompetitorScore[];
  canWrite: boolean;
  gateDescribedBy: string;
  writeDeniedReason: string | null;
  /** Invalidate the summary so the board's mention rates refresh. */
  onChanged: () => void;
}

/**
 * Head-to-head competitor mention rates. The roster comes from
 * GET /aeo/competitors (items + the tenant cap); the rates come from the
 * summary's competitor_board. Upsert is keyed on competitor_key, so re-adding
 * an existing key updates it rather than duplicating.
 */
export function CompetitorBoard({
  tenantId,
  role,
  scores,
  canWrite,
  gateDescribedBy,
  writeDeniedReason,
  onChanged,
}: CompetitorBoardProps) {
  const uid = useId();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [terms, setTerms] = useState("");
  const [domain, setDomain] = useState("");

  const listQuery = useQuery({
    queryKey: aeoKeys.competitors(tenantId, role),
    queryFn: listAeoCompetitors,
    staleTime: STALE.list,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({
      queryKey: aeoKeys.competitors(tenantId, role),
    });
    onChanged();
  };

  const add = useMutation({
    mutationFn: upsertAeoCompetitor,
    onSuccess: () => {
      setKey("");
      setName("");
      setTerms("");
      setDomain("");
      toast.success("Competitor saved");
      refresh();
    },
    onError: (err: unknown) => {
      toast.error("Add competitor failed", {
        description: apiErrorMessage(err),
      });
    },
  });

  const remove = useMutation({
    mutationFn: deleteAeoCompetitor,
    onSuccess: () => {
      toast.success("Competitor removed");
      refresh();
    },
  });

  const scoreByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of scores) m.set(s.key, s.mention_rate);
    return m;
  }, [scores]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canWrite || add.isPending) return;
    const competitorKey = key.trim().toLowerCase();
    const displayName = name.trim();
    if (!competitorKey || !displayName) {
      toast.error("Key + display name required");
      return;
    }
    add.mutate({
      competitor_key: competitorKey,
      display_name: displayName,
      terms: splitTerms(terms),
      domain: domain.trim(),
    });
  }

  const competitors = listQuery.data ? listQuery.data.items : [];
  const max = listQuery.data ? listQuery.data.max : 0;
  const atCap = listQuery.data !== undefined && competitors.length >= max;
  const describedBy = canWrite ? undefined : gateDescribedBy;
  const writeTitle = writeDeniedReason ?? undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Competitor comparison</CardTitle>
        <CardDescription>
          Head-to-head mention rates across the same probe sample.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {listQuery.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <span>
              Couldn&apos;t load competitor configuration:{" "}
              {isAeoContractError(listQuery.error)
                ? listQuery.error.message
                : apiErrorMessage(listQuery.error)}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void listQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : listQuery.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading competitors…
          </p>
        ) : competitors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add up to {max} competitors to track head-to-head mention rates.
          </p>
        ) : (
          <TableContainer aria-label="Competitor mention rates">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Competitor</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Mention rate</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {competitors.map((c) => (
                  <TableRow key={c.competitor_key}>
                    <TableCell>
                      <span className="font-medium">{c.display_name}</span>{" "}
                      <span className="text-muted-foreground">
                        ({c.competitor_key})
                      </span>
                    </TableCell>
                    <TableCell>{c.domain || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(scoreByKey.get(c.competitor_key) ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      <ConfirmDialog
                        trigger={
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={!canWrite || remove.isPending}
                            title={writeTitle}
                            aria-describedby={describedBy}
                          >
                            Remove
                          </Button>
                        }
                        title={`Remove ${c.display_name}?`}
                        description={`This deletes the "${c.competitor_key}" competitor row. Its head-to-head mention rate disappears from this board and from future rollups.`}
                        confirmLabel="Remove competitor"
                        onConfirm={() =>
                          remove
                            .mutateAsync(c.competitor_key)
                            .then(() => undefined)
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {atCap ? (
          <p className="text-xs text-muted-foreground">
            Maximum {max} competitors reached. Remove one to add another.
          </p>
        ) : (
          <form className="space-y-3" onSubmit={onSubmit}>
            <fieldset
              disabled={!canWrite}
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            >
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-key`}>Key</Label>
                <Input
                  id={`${uid}-key`}
                  value={key}
                  placeholder="acme"
                  onChange={(e) => setKey(e.currentTarget.value)}
                  aria-describedby={describedBy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-name`}>Display name</Label>
                <Input
                  id={`${uid}-name`}
                  value={name}
                  placeholder="Acme Mail"
                  onChange={(e) => setName(e.currentTarget.value)}
                  aria-describedby={describedBy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-terms`}>Terms (comma-separated)</Label>
                <Input
                  id={`${uid}-terms`}
                  value={terms}
                  placeholder="Acme, AcmeMail"
                  onChange={(e) => setTerms(e.currentTarget.value)}
                  aria-describedby={describedBy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-domain`}>Domain</Label>
                <Input
                  id={`${uid}-domain`}
                  value={domain}
                  placeholder="acme.com"
                  onChange={(e) => setDomain(e.currentTarget.value)}
                  aria-describedby={describedBy}
                />
              </div>
            </fieldset>
            <Button
              type="submit"
              variant="outline"
              disabled={!canWrite || add.isPending}
              loading={add.isPending}
              title={writeTitle}
              aria-describedby={describedBy}
            >
              {add.isPending ? "Adding…" : "Add competitor"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
