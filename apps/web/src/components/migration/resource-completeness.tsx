// SPDX-License-Identifier: AGPL-3.0-only
import type { VerificationReport } from "@/lib/types";
import { Badge } from "@/components/ui/badge";

type ResourceRow = NonNullable<
  VerificationReport["resource_completeness"]
>[number];

export function ResourceCompleteness({
  rows,
  title = "Migration parity",
  preview = false,
}: {
  rows?: ResourceRow[];
  title?: string;
  preview?: boolean;
}) {
  if (!rows || rows.length === 0) return null;

  return (
    <section>
      <h3 className="text-sm font-medium mb-2">{title}</h3>
      {preview ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Planned counts only. No records have been imported by this preview.
        </p>
      ) : null}
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="text-left font-medium px-3 py-2">
                Resource
              </th>
              <th scope="col" className="text-right font-medium px-3 py-2">
                Found
              </th>
              <th scope="col" className="text-right font-medium px-3 py-2">
                {preview ? "Planned" : "Imported"}
              </th>
              <th scope="col" className="text-left font-medium px-3 py-2">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.resource} className="border-t align-top">
                {/* Row header: found/imported/status are all counts *about*
                    this resource, and a screen reader reading them without it
                    gets four numbers and no subject. */}
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <div className="font-medium">{row.label}</div>
                  {row.notes && row.notes.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1 max-w-xl">
                      {row.notes[0]}
                    </p>
                  )}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">
                  {row.source_total.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {row.imported.toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={statusVariant(row.status)}>
                    {resourceCompletenessStatusLabel(row.status, preview)}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function resourceCompletenessStatusLabel(
  status: ResourceRow["status"],
  preview = false,
): string {
  switch (status) {
    case "imported_runtime":
      return preview ? "Planned import" : "Imported";
    case "partial_runtime":
      return preview ? "Partial planned import" : "Partially imported";
    case "preserved_for_rebuild":
      return preview ? "Rebuild review planned" : "Preserved for rebuild";
    case "manual_rebuild_required":
      return "Manual rebuild required";
    case "not_supported":
      return "Not supported";
    case "not_detected":
      return "Not detected";
  }
}

function statusVariant(
  status: ResourceRow["status"],
): "success" | "warning" | "secondary" | "destructive" {
  switch (status) {
    case "imported_runtime":
      return "success";
    case "partial_runtime":
    case "preserved_for_rebuild":
    case "manual_rebuild_required":
      return "warning";
    case "not_supported":
      return "destructive";
    case "not_detected":
      return "secondary";
  }
}
