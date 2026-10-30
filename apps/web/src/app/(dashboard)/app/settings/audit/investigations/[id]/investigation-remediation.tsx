// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

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
  approveAuditInvestigation,
  rejectAuditInvestigation,
  type AuditInvestigation,
} from "@/lib/audit-investigations-api";

import { InvestigationDecision } from "../_components/investigation-decision";

/**
 * The proposed remediation plan and its whole-plan Approve / Reject decision.
 * The page loads it after the investigation itself so the decision dialogs
 * stay out of the route's first paint.
 */
export function InvestigationRemediation({
  id,
  investigation,
  isAdmin,
  onDecided,
}: {
  id: string;
  investigation: AuditInvestigation;
  isAdmin: boolean;
  /** Re-reads the investigation and the list once a decision is recorded. */
  onDecided: () => void;
}) {
  const approve = useMutation({
    mutationFn: () => approveAuditInvestigation(id),
    onSuccess: (receipt) => {
      // The server states what approval did and did not do; say that.
      toast.success(receipt.message || "Remediation plan approved.");
      onDecided();
    },
  });
  const reject = useMutation({
    mutationFn: (reason: string) => rejectAuditInvestigation(id, reason),
    onSuccess: () => {
      toast.success("Investigation rejected.");
      onDecided();
    },
  });
  const actionCount = investigation.proposed_actions.length;

  return (
    <>
      {actionCount === 0 ? (
        <p className="text-sm text-muted-foreground">No actions proposed.</p>
      ) : (
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Rationale</TableHead>
                <TableHead className="text-right">Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {investigation.proposed_actions.map((action) => (
                <TableRow
                  key={action.id}
                  data-testid="investigation-action-row"
                >
                  <TableCell className="font-mono text-xs">
                    {action.action}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {action.target_id || "—"}
                  </TableCell>
                  <TableCell>{action.severity}</TableCell>
                  <TableCell className="max-w-md whitespace-normal">
                    {action.rationale}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {investigation.status === "draft"
                      ? "Included in plan"
                      : investigation.status}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <InvestigationDecision
        investigation={investigation}
        isAdmin={isAdmin}
        busy={approve.isPending || reject.isPending}
        onApprove={async () => {
          await approve.mutateAsync();
        }}
        onReject={async (reason) => {
          await reject.mutateAsync(reason);
        }}
      />
    </>
  );
}
