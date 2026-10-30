// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Inbox,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/relative-time";
import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/dashboard/skeletons";
import { ApiError } from "@/lib/api";
import { effectiveAuthRole, whoami, whoamiFresh } from "@/lib/auth-api";
import {
  deleteSubmission,
  fetchSubmissionsCsv,
  getForm,
  listAllSubmissions,
  resendConfirmation,
} from "@/lib/forms-api";
import { downloadTextFile } from "@/lib/download";
import { formatCount, paginate, totalPages } from "@/lib/forms-list-helpers";
import {
  confirmationEmailProblem,
  filterSubmissions,
  SUBMISSION_STATUS_FILTERS,
  submissionStatusLabel,
  submissionTotals,
  type SubmissionStatusFilter,
} from "@/lib/submissions-helpers";
import { enumParam, intParam, stringParam } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";
import type { Form, FormSubmission } from "@/lib/forms-types";
import { qk, STALE } from "@/lib/query-keys";
import {
  assertFreshFormAuthority,
  canAdminForms,
  FORM_ADMIN_ONLY_MESSAGE,
} from "@/lib/forms-authority";

const perPage = 50;

const listSchema = {
  page: intParam(1),
  status: enumParam(SUBMISSION_STATUS_FILTERS, "all"),
  q: stringParam(""),
  from: stringParam(""),
  to: stringParam(""),
} as const;

async function loadData(id: string) {
  const [form, all] = await Promise.all([getForm(id), listAllSubmissions(id)]);
  return { form, all };
}

export default function SubmissionsPage() {
  const { id } = useParams<{ id: string }>();
  const { state, setState, reset } = useTableUrlState(listSchema);
  const { page, status, q, from, to } = state;

  const [emailInput, setEmailInput] = useState(q);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const queryClient = useQueryClient();

  // The URL is the durable list-state contract. Keep the draft field aligned
  // when Back/Forward or a same-route link changes `q`; otherwise the rows and
  // address bar can show the restored query while the input still shows the
  // search the operator just left.
  useEffect(() => setEmailInput(q), [q]);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const identity = meQuery.data;
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  const canAdmin = canAdminForms(identity);
  const sensitiveBaseKey = useMemo(
    () => ["forms-submissions-sensitive"] as const,
    [],
  );
  const submissionsKey = useMemo(
    () =>
      [
        ...sensitiveBaseKey,
        tenantId,
        identity?.user_id ?? "anon",
        role,
        viewerMode,
        id,
      ] as const,
    [sensitiveBaseKey, tenantId, identity?.user_id, role, viewerMode, id],
  );
  const dataQuery = useQuery({
    queryKey: submissionsKey,
    queryFn: () => loadData(id),
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
    gcTime: 0,
  });

  useEffect(() => {
    if (!canAdmin) {
      queryClient.removeQueries({ queryKey: sensitiveBaseKey, exact: false });
    }
  }, [canAdmin, queryClient, sensitiveBaseKey]);

  useEffect(
    () => () => {
      queryClient.removeQueries({ queryKey: submissionsKey, exact: true });
    },
    [queryClient, submissionsKey],
  );

  async function verifyAdminAuthority() {
    if (!identity || !canAdmin) throw new Error(FORM_ADMIN_ONLY_MESSAGE);
    const fresh = await whoamiFresh();
    assertFreshFormAuthority(identity, fresh, "admin");
  }

  // FORM-030: per-submission actions. Both reuse the existing per-item
  // endpoints and refetch the list: delete removes the row, and resend
  // records the email's outcome on it.
  const onDeleteSubmission = async (submissionId: string) => {
    try {
      await verifyAdminAuthority();
      await deleteSubmission(id, submissionId, { requireOnline: true });
      toast.success("Submission deleted.");
      await queryClient.invalidateQueries({ queryKey: submissionsKey });
    } catch (deleteError) {
      const message = "Could not delete the submission.";
      toast.error(message);
      throw deleteError instanceof Error ? deleteError : new Error(message);
    }
  };
  const onResendConfirmation = async (submissionId: string) => {
    try {
      await verifyAdminAuthority();
      const res = await resendConfirmation(id, submissionId, {
        requireOnline: true,
      });
      const message = res.resent_to
        ? `Confirmation re-sent to ${res.resent_to}.`
        : "Confirmation re-sent.";
      toast.success(message);
      return message;
    } catch (e) {
      const message =
        e instanceof ApiError && e.status === 409
          ? "This submission is already confirmed."
          : e instanceof Error
            ? e.message
            : "Could not resend the confirmation.";
      toast.error(message);
      throw new Error(message);
    } finally {
      void queryClient.invalidateQueries({ queryKey: submissionsKey });
    }
  };

  const form: Form | null = dataQuery.data?.form ?? null;
  const allItems = useMemo<FormSubmission[]>(
    () =>
      Array.isArray(dataQuery.data?.all.items) ? dataQuery.data?.all.items : [],
    [dataQuery.data],
  );
  const truncated = dataQuery.data?.all?.truncated ?? false;
  const grand = useMemo(() => submissionTotals(allItems), [allItems]);
  const invalidDateRange = Boolean(from && to && from > to);

  const filtered = useMemo(
    () =>
      invalidDateRange
        ? []
        : filterSubmissions(allItems, { status, email: q, from, to }),
    [allItems, status, q, from, to, invalidDateRange],
  );
  const pageCount = totalPages(filtered.length, perPage);
  const clampedPage = Math.min(page, pageCount);
  const rows = useMemo(
    () => paginate(filtered, clampedPage, perPage),
    [filtered, clampedPage],
  );

  const loading = meQuery.isLoading || (dataQuery.isPending && !dataQuery.data);
  const error =
    dataQuery.error instanceof Error
      ? dataQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : dataQuery.isError
          ? "Could not load submissions — this is a failed request, not a form nobody has filled in."
          : null;

  const isFiltered =
    status !== "all" || q.trim() !== "" || from !== "" || to !== "";

  async function exportCsv() {
    if (!canAdmin || !form || grand.total === 0 || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    try {
      await verifyAdminAuthority();
      const csv = await fetchSubmissionsCsv(form.id);
      downloadTextFile(
        `${form.slug}-submissions.csv`,
        csv,
        "text/csv;charset=utf-8",
      );
      toast.success("Export ready.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }

  if (meQuery.isError) {
    return (
      <div className="space-y-3 p-4 sm:p-6 lg:p-8">
        <h1 className="font-display text-xl font-semibold">Submissions</h1>
        <p role="alert" className="text-sm text-destructive">
          Workspace identity could not be verified, so submission data was not
          requested.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void meQuery.refetch()}
        >
          Retry identity
        </Button>
      </div>
    );
  }
  if (meQuery.isSuccess && !canAdmin) {
    return (
      <div className="space-y-3 p-4 sm:p-6 lg:p-8">
        <Link
          href={`/app/forms/${id}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Form editor
        </Link>
        <h1 className="font-display text-xl font-semibold">Submissions</h1>
        <p
          role="note"
          className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          {FORM_ADMIN_ONLY_MESSAGE} No submission inventory or personal data was
          requested.
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3 p-4 sm:p-6 lg:p-8">
        <h1 className="font-display text-xl font-semibold">Submissions</h1>
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void meQuery.refetch();
            if (canAdmin) void dataQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (loading || !form) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
        <h1 className="sr-only">Submissions</h1>
        <PageHeaderSkeleton />
        <TableSkeleton
          rows={8}
          columns={["w-56", "w-28", "w-24", "w-20", "w-40"]}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={`/app/forms/${form.id}`}
            className="inline-flex min-h-11 items-center rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
          >
            ← {form.name}
          </Link>
          <h1 className="font-display text-2xl font-semibold tracking-tight mt-1">
            Submissions
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {formatCount(grand.total)}
            {truncated ? "+" : ""} total · {formatCount(grand.confirmed)}{" "}
            confirmed · {formatCount(grand.pending)} pending
            {grand.received > 0
              ? ` · ${formatCount(grand.received)} ${grand.received === 1 ? "response" : "responses"} without consent`
              : ""}
            {isFiltered
              ? ` · ${formatCount(filtered.length)} match the filter`
              : ""}
          </p>
        </div>
        <Button
          variant="outline"
          className="min-h-11 sm:min-h-9"
          onClick={() => void exportCsv()}
          disabled={!canAdmin || grand.total === 0 || exporting}
        >
          <Download className="h-4 w-4" />
          {exporting ? "Exporting…" : "Export CSV"}
        </Button>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="xl:col-span-2">
          <Label htmlFor="sub-email" className="sr-only">
            Search by email
          </Label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setState({ q: emailInput.trim(), page: 1 });
            }}
            className="relative"
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="sub-email"
              className="pl-9 pr-9"
              placeholder="Search by email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
            />
            {emailInput ? (
              <button
                type="button"
                aria-label="Clear email search"
                onClick={() => {
                  setEmailInput("");
                  setState({ q: "", page: 1 });
                }}
                className="absolute right-0 top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:right-1 sm:size-8"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </form>
        </div>
        <div>
          <Label htmlFor="sub-status" className="sr-only">
            Status
          </Label>
          <Select
            id="sub-status"
            value={status}
            onChange={(e) =>
              setState({
                status: e.target.value as SubmissionStatusFilter,
                page: 1,
              })
            }
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending confirmation</option>
            <option value="confirmed">Confirmed</option>
            <option value="unsubscribed">Unsubscribed</option>
            <option value="received">Response only (no consent)</option>
          </Select>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:col-span-2 sm:grid-cols-2 xl:col-span-2">
          <div className="min-w-0">
            <Label htmlFor="sub-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="sub-from"
              type="date"
              className="min-w-0"
              value={from}
              onChange={(e) => setState({ from: e.target.value, page: 1 })}
            />
          </div>
          <div className="min-w-0">
            <Label htmlFor="sub-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="sub-to"
              type="date"
              className="min-w-0"
              value={to}
              onChange={(e) => setState({ to: e.target.value, page: 1 })}
            />
          </div>
        </div>
      </div>

      {invalidDateRange ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            The From date must be on or before the To date. Correct the range to
            filter submissions.
          </AlertDescription>
        </Alert>
      ) : allItems.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No submissions yet"
          description="Once your form goes live, signups will show up here."
        />
      ) : filtered.length === 0 ? (
        <div className="space-y-3">
          <EmptyState
            icon={Search}
            title="No submissions match your filters"
            description="Try widening the date range, clearing the status, or changing the email search."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setEmailInput("");
                  reset();
                }}
              >
                Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div
            role="region"
            aria-label="Form submissions"
            tabIndex={0}
            className="rounded-md border bg-card overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th scope="col" className="w-8 px-3 py-2" />
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Email
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Submitted
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    IP
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    User-agent
                  </th>
                  <th scope="col" className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((s) => (
                  <SubmissionRow
                    key={s.id}
                    submission={s}
                    onDelete={onDeleteSubmission}
                    onResend={onResendConfirmation}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page {clampedPage} of {pageCount} · {formatCount(filtered.length)}{" "}
              result{filtered.length === 1 ? "" : "s"}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={clampedPage <= 1}
                onClick={() => setState({ page: clampedPage - 1 })}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={clampedPage >= pageCount}
                onClick={() => setState({ page: clampedPage + 1 })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SubmissionRow({
  submission: s,
  onDelete,
  onResend,
}: {
  submission: FormSubmission;
  onDelete: (id: string) => Promise<void>;
  onResend: (id: string) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [resendPending, setResendPending] = useState(false);
  const [resendFeedback, setResendFeedback] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const deletePendingRef = useRef(false);
  const resendPendingRef = useRef(false);
  const deleteErrorRef = useRef<HTMLDivElement>(null);
  const resendFeedbackRef = useRef<HTMLParagraphElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const answerRowId = useId();
  const answers = Object.entries(s.customFields ?? {}).filter(
    ([, v]) => v !== "" && v != null,
  );
  const hasAnswers = answers.length > 0;
  const emailProblem = confirmationEmailProblem(s);

  useEffect(() => {
    if (deleteError) deleteErrorRef.current?.focus();
  }, [deleteError]);

  useEffect(() => {
    if (resendFeedback?.kind === "error") {
      resendFeedbackRef.current?.focus();
    }
  }, [resendFeedback]);

  const resend = async () => {
    if (resendPendingRef.current) return;
    resendPendingRef.current = true;
    setResendPending(true);
    setResendFeedback(null);
    try {
      const message = await onResend(s.id);
      setResendFeedback({ kind: "success", message });
    } catch (resendError) {
      setResendFeedback({
        kind: "error",
        message:
          resendError instanceof Error
            ? resendError.message
            : "Could not resend the confirmation.",
      });
    } finally {
      resendPendingRef.current = false;
      setResendPending(false);
    }
  };

  const remove = async () => {
    if (deletePendingRef.current) return;
    deletePendingRef.current = true;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await onDelete(s.id);
      setConfirmDelete(false);
    } catch (removeError) {
      setDeleteError(
        removeError instanceof Error
          ? removeError.message
          : "Could not delete the submission.",
      );
    } finally {
      deletePendingRef.current = false;
      setDeletePending(false);
    }
  };

  const menuItems: ActionMenuItem[] = [];
  if (s.status === "pending") {
    menuItems.push({
      label: "Resend confirmation",
      onSelect: () => void resend(),
      disabled: resendPending,
    });
  }
  menuItems.push({
    label: "Delete",
    destructive: true,
    onSelect: () => setConfirmDelete(true),
  });

  return (
    <>
      <tr className="hover:bg-muted/30">
        <td className="px-3 py-3 align-top">
          {hasAnswers ? (
            <button
              type="button"
              aria-label={open ? "Hide answers" : "Show answers"}
              aria-expanded={open}
              aria-controls={answerRowId}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex size-11 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-8"
            >
              {open ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          ) : null}
        </td>
        <td className="px-4 py-3 font-medium">
          <Link
            href={`/app/subscribers?q=${encodeURIComponent(s.email)}`}
            className="inline-flex min-h-11 items-center rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
            title={`Find ${s.email} in subscribers`}
          >
            {s.email}
          </Link>
          {resendFeedback ? (
            <p
              ref={resendFeedbackRef}
              tabIndex={resendFeedback.kind === "error" ? -1 : undefined}
              role={resendFeedback.kind === "error" ? "alert" : "status"}
              className={
                resendFeedback.kind === "error"
                  ? "mt-1 text-xs text-destructive"
                  : "mt-1 text-xs text-success"
              }
            >
              {resendFeedback.message}
            </p>
          ) : resendPending ? (
            <p role="status" className="mt-1 text-xs text-muted-foreground">
              Resending confirmation…
            </p>
          ) : emailProblem ? (
            <p
              className={
                emailProblem.tone === "error"
                  ? "mt-1 max-w-sm text-xs text-destructive"
                  : "mt-1 max-w-sm text-xs text-warning-emphasis"
              }
            >
              {emailProblem.message}
            </p>
          ) : null}
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          <RelativeTime iso={s.submittedAt} />
        </td>
        <td className="px-4 py-3">
          <Badge
            variant={
              s.status === "confirmed"
                ? "success"
                : s.status === "pending"
                  ? "warning"
                  : "outline"
            }
            title={
              s.status === "received"
                ? "The consent box was left unticked, so nothing was subscribed."
                : undefined
            }
          >
            {submissionStatusLabel(s.status)}
          </Badge>
        </td>
        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
          {s.ip ?? "—"}
        </td>
        <td
          className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[280px]"
          title={s.userAgent ?? undefined}
        >
          {s.userAgent ?? "—"}
        </td>
        <td className="px-3 py-3 text-right align-top">
          <ActionMenu
            label={`Actions for ${s.email}`}
            items={menuItems}
            triggerRef={actionsTriggerRef}
          />
          <Dialog
            open={confirmDelete}
            onOpenChange={(next) => {
              if (!next && deletePendingRef.current) return;
              setConfirmDelete(next);
              if (next) setDeleteError(null);
            }}
          >
            <DialogContent
              aria-busy={deletePending}
              onCloseAutoFocus={(event) => {
                const trigger = actionsTriggerRef.current;
                if (!trigger?.isConnected || trigger.disabled) return;
                event.preventDefault();
                trigger.focus();
                window.requestAnimationFrame(() => {
                  const active = document.activeElement;
                  const activeElement =
                    active instanceof HTMLElement ? active : null;
                  const usableFocusElsewhere =
                    activeElement?.isConnected &&
                    activeElement !== document.body &&
                    !activeElement.closest('[role="dialog"]');
                  if (!usableFocusElsewhere) {
                    const fallbackTrigger = actionsTriggerRef.current;
                    if (
                      fallbackTrigger?.isConnected &&
                      !fallbackTrigger.disabled
                    ) {
                      fallbackTrigger.focus();
                    }
                  }
                });
              }}
              onEscapeKeyDown={(event) => {
                if (deletePendingRef.current) event.preventDefault();
              }}
              onPointerDownOutside={(event) => {
                if (deletePendingRef.current) event.preventDefault();
              }}
            >
              <DialogHeader>
                <DialogTitle>Delete submission?</DialogTitle>
                <DialogDescription>
                  Delete the submission from {s.email}? This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              {deleteError ? (
                <Alert ref={deleteErrorRef} tabIndex={-1} variant="destructive">
                  <AlertDescription>{deleteError}</AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={deletePending}
                  >
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deletePending}
                  onClick={() => void remove()}
                >
                  {deletePending ? "Deleting…" : "Delete"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </td>
      </tr>
      {open && hasAnswers ? (
        <tr id={answerRowId} className="bg-muted/20">
          <td />
          <td colSpan={6} className="px-4 pb-4 pt-1">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {answers.map(([key, value]) => (
                <div key={key} className="flex gap-2 text-xs">
                  <dt className="font-mono text-muted-foreground">{key}</dt>
                  <dd className="[overflow-wrap:anywhere]">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}
