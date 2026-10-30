// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Forms & automations (audience-94): what targets this list. Read-only rows
 * linking into the Forms and Flows editors; two independent reads so one
 * failure never blanks the other.
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  listListAutomations,
  listListForms,
  type AudienceList,
} from "@/lib/lists-api";
import { listKeys, STALE, type RoleKey } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

import { LoadFailure, Muted, Pending, Section } from "./tab-chrome";

function statusVariant(status: string): "success" | "warning" | "secondary" | "outline" {
  const s = status.toLowerCase();
  if (s === "active" || s === "running" || s === "published" || s === "live")
    return "success";
  if (s === "paused") return "warning";
  if (s === "draft") return "secondary";
  return "outline";
}

export function ListFormsAutomationsTab({
  list,
  tenantId,
  roleKey,
}: {
  list: AudienceList;
  tenantId: string;
  roleKey: RoleKey;
}) {
  const forms = useQuery({
    queryKey: listKeys.forms(tenantId, roleKey, list.id),
    queryFn: ({ signal }) => listListForms(list.id, signal),
    staleTime: STALE.list,
  });
  const automations = useQuery({
    queryKey: listKeys.automations(tenantId, roleKey, list.id),
    queryFn: ({ signal }) => listListAutomations(list.id, signal),
    staleTime: STALE.list,
  });

  return (
    <div className="space-y-4">
      <Section
        title="Forms"
        description={
          <>
            Forms that subscribe people to{" "}
            <span className="font-medium text-foreground">{list.name}</span>.
          </>
        }
        aside={
          <Button asChild variant="outline" size="sm">
            <Link href="/app/forms">
              Manage forms <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          </Button>
        }
      >
        {forms.isPending ? (
          <Pending label="Loading forms" rows={2} />
        ) : forms.isError ? (
          <LoadFailure what="Forms" error={forms.error} busy={forms.isFetching} onRetry={() => void forms.refetch()} />
        ) : forms.data.length === 0 ? (
          <Muted>
            No forms feed this list yet. Create a form and pick {list.name} as
            its destination to start capturing signups.
          </Muted>
        ) : (
          <TableContainer aria-label={`Forms targeting ${list.name}`}>
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Form</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Opt-in</TableHead>
                  <TableHead scope="col">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {forms.data.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>
                      <Link
                        href={asRoute(`/app/forms/${encodeURIComponent(f.id)}`)}
                        className="font-medium hover:underline"
                      >
                        {f.name || f.slug || f.id}
                      </Link>
                      {f.slug ? (
                        <span className="block font-mono text-xs text-muted-foreground">/{f.slug}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(f.status)}>{f.status || "—"}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.opt_in_mode || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {f.updated_at ? <RelativeTime iso={f.updated_at} /> : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Section>

      <Section
        title="Automations"
        description={
          <>
            Flows triggered by, or gated on, membership of{" "}
            <span className="font-medium text-foreground">{list.name}</span>.
          </>
        }
        aside={
          <Button asChild variant="outline" size="sm">
            <Link href="/app/flows">
              Manage flows <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          </Button>
        }
      >
        {automations.isPending ? (
          <Pending label="Loading automations" rows={2} />
        ) : automations.isError ? (
          <LoadFailure what="Automations" error={automations.error} busy={automations.isFetching} onRetry={() => void automations.refetch()} />
        ) : automations.data.length === 0 ? (
          <Muted>
            No automations reference this list yet. Add a list-membership
            trigger or condition in a flow to wire one up.
          </Muted>
        ) : (
          <TableContainer aria-label={`Automations targeting ${list.name}`}>
            <Table className="min-w-[480px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Automation</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {automations.data.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link
                        href={asRoute(`/app/flows/${encodeURIComponent(a.id)}`)}
                        className="font-medium hover:underline"
                      >
                        {a.name || a.id}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(a.status)}>{a.status || "—"}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {a.updated_at ? <RelativeTime iso={a.updated_at} /> : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Section>
    </div>
  );
}
