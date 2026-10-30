// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Per-page leads view (LAND-022): the conversions captured on one landing
// page, newest first, with email search and a CSV export. Reads the existing
// growth_surface_events store via GET /api/v1/landing-pages/{id}/leads.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, Download } from "lucide-react";
import { toast } from "sonner";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/dashboard/skeletons";
import { RelativeTime } from "@/components/relative-time";
import { fetchTextAuthed } from "@/lib/api";
import { downloadTextFile } from "@/lib/download";
import {
  landingLeadsCsvUrl,
  landingPagesApi,
  type LandingLead,
} from "@/lib/landing-pages-api";

// The leads endpoint returns up to 5,000 rows in one response, and every row
// used to be committed to the DOM inside a page whose whole budget is 3,000
// nodes. The full data set is still reachable — the CSV export below downloads
// all of it — so the table itself shows one window at a time, the way the
// discount-redemptions detail view already does.
const LEADS_PER_PAGE = 100;

export default function LandingLeadsPage() {
  const { id } = useParams<{ id: string }>();
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);

  const pageQuery = useQuery({
    queryKey: ["landing-page", id],
    queryFn: () => landingPagesApi.get(id),
  });
  const leadsQuery = useQuery({
    queryKey: ["landing-page-leads", id],
    queryFn: () => landingPagesApi.listLeads(id),
  });

  const filtered = useMemo<LandingLead[]>(() => {
    const term = search.trim().toLowerCase();
    const rows = Array.isArray(leadsQuery.data) ? leadsQuery.data : [];
    if (!term) return rows;
    return rows.filter((l) => l.email.toLowerCase().includes(term));
  }, [leadsQuery.data, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / LEADS_PER_PAGE));
  // Clamped rather than reset: narrowing the search shrinks the result set
  // under a page number the user already chose.
  const clampedPage = Math.min(page, pageCount);
  const visible = useMemo(
    () =>
      filtered.slice(
        (clampedPage - 1) * LEADS_PER_PAGE,
        clampedPage * LEADS_PER_PAGE,
      ),
    [clampedPage, filtered],
  );

  async function onExport() {
    setExporting(true);
    try {
      const csv = await fetchTextAuthed(landingLeadsCsvUrl(id));
      downloadTextFile("landing-page-leads.csv", csv, "text/csv;charset=utf-8");
      toast.success("Leads exported.");
    } catch {
      toast.error("Could not export leads.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
      <div>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="[@media(pointer:coarse)]:min-h-11"
        >
          <Link href={`/app/landing-pages/${id}`}>
            <ArrowLeft className="h-4 w-4" />
            Back to editor
          </Link>
        </Button>
        <h1 className="mt-2 text-xl font-semibold">
          Leads{pageQuery.data ? ` · ${pageQuery.data.name}` : ""}
        </h1>
        {pageQuery.isError ? (
          <div
            role="alert"
            className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            <p>Could not load this landing page — its name is missing above.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="[@media(pointer:coarse)]:min-h-11"
              onClick={() => void pageQuery.refetch()}
            >
              Retry page
            </Button>
          </div>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Everyone who converted on this landing page, newest first.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search by email"
          aria-label="Search submissions by email"
          className="max-w-xs"
        />
        <Button
          type="button"
          variant="outline"
          className="ml-auto [@media(pointer:coarse)]:min-h-11"
          disabled={exporting || (leadsQuery.data?.length ?? 0) === 0}
          onClick={() => void onExport()}
        >
          <Download className="h-4 w-4" />
          {exporting ? "Exporting…" : "Export CSV"}
        </Button>
      </div>

      {leadsQuery.isPending ? (
        <div role="status" aria-label="Loading landing page leads">
          <TableSkeleton />
        </div>
      ) : leadsQuery.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          <p>
            Could not load leads — this is a failed request, not a page without
            conversions.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => void leadsQuery.refetch()}
          >
            Retry leads
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={search ? "No matching leads" : "No leads yet"}
          description={
            search
              ? "Try a different email search."
              : "Conversions on this page will appear here as visitors subscribe."
          }
        />
      ) : (
        <div
          role="region"
          aria-label="Landing page submissions"
          tabIndex={0}
          className="rounded-md border bg-card overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Email
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Converted
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((lead, i) => {
                const meta = Object.entries(lead.metadata ?? {}).filter(
                  ([, v]) => v !== "" && v != null,
                );
                return (
                  <tr key={`${lead.email}-${lead.at}-${i}`}>
                    <td className="max-w-[18rem] px-4 py-3 font-medium [overflow-wrap:anywhere]">
                      <Link
                        href={`/app/subscribers?q=${encodeURIComponent(lead.email)}`}
                        className="inline-flex max-w-full items-center rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [overflow-wrap:anywhere] [@media(pointer:coarse)]:min-h-11"
                      >
                        {lead.email}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <RelativeTime iso={lead.at} />
                    </td>
                    <td className="max-w-md px-4 py-3 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {meta.length
                        ? meta.map(([k, v]) => `${k}: ${String(v)}`).join(" · ")
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!leadsQuery.isPending && !leadsQuery.isError && pageCount > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {clampedPage} of {pageCount} · {filtered.length} leads
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="[@media(pointer:coarse)]:min-h-11"
              disabled={clampedPage === 1}
              onClick={() => setPage(Math.max(1, clampedPage - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="[@media(pointer:coarse)]:min-h-11"
              disabled={clampedPage >= pageCount}
              onClick={() => setPage(Math.min(pageCount, clampedPage + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
