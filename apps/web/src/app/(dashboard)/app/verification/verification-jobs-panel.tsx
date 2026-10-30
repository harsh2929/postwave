// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { newUUIDv7 } from "@/lib/http-fetch";
import { STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  cancelVerificationJob,
  createVerificationJob,
  getVerificationJob,
  listVerificationJobResults,
  listVerificationJobs,
  parseVerificationAddressList,
  retainVerificationJobAttemptKey,
  sameVerificationJobRevision,
  VERIFICATION_RESULT_PAGE_SIZE,
  VERIFICATION_STATUSES,
  type CreateVerificationJobInput,
  type VerificationJob,
  type VerificationJobCreateSource,
  type VerificationJobResult,
  type VerificationStatus,
} from "@/lib/verification-api";

const CANCEL_TOKEN = "CANCEL RUN";
const POLL_INTERVAL_MS = 3_000;
const MAX_PASTE_CHARS = 2_000_000;
const MAX_TAG_CHARS = 512;

const SOURCE_LABEL: Record<VerificationJobCreateSource, string> = {
  inline: "Paste addresses",
  tag: "Subscribers with a tag",
  all_subscribers: "All subscribers",
};

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

interface RunDraft {
  input: CreateVerificationJobInput | null;
  /** Unique addresses when known client-side; null for server-resolved scopes. */
  unique: number | null;
  duplicates: number;
  error: string | null;
}

function buildRunDraft(
  source: VerificationJobCreateSource,
  addresses: string,
  tag: string,
): RunDraft {
  if (source === "all_subscribers") {
    return {
      input: { source: "all_subscribers" },
      unique: null,
      duplicates: 0,
      error: null,
    };
  }
  if (source === "tag") {
    const sourceRef = tag.trim();
    if (!sourceRef)
      return { input: null, unique: null, duplicates: 0, error: null };
    if (sourceRef.length > MAX_TAG_CHARS) {
      return {
        input: null,
        unique: null,
        duplicates: 0,
        error: `A tag is at most ${MAX_TAG_CHARS} characters.`,
      };
    }
    return {
      input: { source: "tag", source_ref: sourceRef },
      unique: null,
      duplicates: 0,
      error: null,
    };
  }
  if (!addresses.trim()) {
    return { input: null, unique: null, duplicates: 0, error: null };
  }
  const parsed = parseVerificationAddressList(addresses);
  if (parsed.invalid.length > 0) {
    const shown = parsed.invalid.slice(0, 3).join(", ");
    return {
      input: null,
      unique: parsed.emails.length,
      duplicates: parsed.duplicates,
      error: `${plural(parsed.invalid.length, "entry", "entries")} ${parsed.invalid.length === 1 ? "is" : "are"} not an address: ${shown}${parsed.invalid.length > 3 ? " and more" : ""}.`,
    };
  }
  if (parsed.emails.length === 0) {
    return {
      input: null,
      unique: 0,
      duplicates: parsed.duplicates,
      error: "Enter at least one email address.",
    };
  }
  return {
    input: { source: "inline", emails: parsed.emails },
    unique: parsed.emails.length,
    duplicates: parsed.duplicates,
    error: null,
  };
}

function runConsequence(draft: RunDraft, tag: string): string {
  const input = draft.input;
  if (!input) return "";
  const billing =
    "One provider credit can be spent per address that is neither cached nor filtered locally. An accepted run cannot be undone; it can only be canceled while pending or running.";
  if (input.source === "inline") {
    return `This run can spend provider credits for up to ${plural(draft.unique ?? 0, "unique address", "unique addresses")}. ${billing}`;
  }
  if (input.source === "tag") {
    return `This run resolves every subscriber tagged "${tag.trim()}" on the server. The final address count and credit ceiling are unknown until the run is accepted. ${billing}`;
  }
  return `This run resolves the entire subscriber directory on the server. The final address count and credit ceiling are unknown until the run is accepted. ${billing}`;
}

export function VerificationJobsPanel({
  identity,
  queryKeyBase,
}: {
  identity: MeResponse;
  queryKeyBase: readonly unknown[];
}) {
  const role = effectiveAuthRole(identity);
  const canWrite = roleCanWrite(role) && !identity.viewer_mode;
  const queryClient = useQueryClient();
  const listKey = [...queryKeyBase, "jobs"] as const;
  const jobs = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => listVerificationJobs({ signal, limit: 50 }),
    staleTime: STALE.list,
    retry: false,
  });
  const rows = useMemo(
    () => (Array.isArray(jobs.data) ? jobs.data : []),
    [jobs.data],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailKey = [...queryKeyBase, "job", selectedId ?? "none"] as const;
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => getVerificationJob(selectedId ?? "", { signal }),
    enabled: selectedId !== null,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.is_terminal ? false : POLL_INTERVAL_MS,
  });
  useEffect(() => {
    if (!detail.data?.is_terminal) return;
    // Detail polling stops at a terminal receipt. Refresh the surrounding
    // history and usage once so they do not keep showing a pending run or
    // pre-run credit totals beside its completed/failed result.
    for (const suffix of ["jobs", "credits", "cache"]) {
      void queryClient.invalidateQueries({
        queryKey: [...queryKeyBase, suffix],
      });
    }
  }, [
    detail.data?.is_terminal,
    detail.data?.job.id,
    queryClient,
    queryKeyBase,
  ]);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const operation = useRef<AbortController | null>(null);
  const active = useRef(true);

  // Run creation draft. The billing key is bound to the exact request body so
  // an unchanged retry reuses it and any edit mints a new one.
  const [source, setSource] = useState<VerificationJobCreateSource>("inline");
  const [addresses, setAddresses] = useState("");
  const [tag, setTag] = useState("");
  const [starting, setStarting] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const draft = useMemo(
    () => buildRunDraft(source, addresses, tag),
    [source, addresses, tag],
  );

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      operation.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (
      selectedId &&
      jobs.data &&
      !jobs.data.some((job) => job.id === selectedId)
    ) {
      setSelectedId(null);
      setError(null);
      setSuccess(null);
    }
  }, [jobs.data, selectedId]);

  async function start(): Promise<void> {
    const input = draft.input;
    if (!canWrite || startPending || pending || !input) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setStartPending(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const fingerprint = JSON.stringify(input);
      if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
        attempt.current = { fingerprint, key: newUUIDv7() };
      }
      const job = await createVerificationJob(
        input,
        attempt.current.key,
        controller.signal,
      );
      attempt.current = null;
      queryClient.setQueryData<VerificationJob[]>(listKey, (current) => [
        job,
        ...(Array.isArray(current) ? current : []).filter(
          (row) => row.id !== job.id,
        ),
      ]);
      setSelectedId(job.id);
      setStarting(false);
      setAddresses("");
      setTag("");
      setSuccess({
        title: "Run accepted",
        body: `Run ${job.id} was accepted as ${job.status} with ${plural(job.total, "address", "addresses")}${
          job.duplicates > 0
            ? ` after the server removed ${plural(job.duplicates, "duplicate")}`
            : ""
        }. Progress and per-address results appear in its detail.`,
      });
      void queryClient.invalidateQueries({ queryKey: listKey });
    } catch (caught) {
      if (!retainVerificationJobAttemptKey(caught)) attempt.current = null;
      if (!controller.signal.aborted && active.current) {
        setError(
          apiErrorMessage(caught, "The verification run was not confirmed."),
        );
        throw caught;
      }
    } finally {
      if (active.current && operation.current === controller) {
        setStartPending(false);
      }
      if (operation.current === controller) operation.current = null;
    }
  }

  async function cancel(): Promise<void> {
    const reviewed = detail.data;
    if (!canWrite || pending || !reviewed || reviewed.is_terminal) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const before = await getVerificationJob(reviewed.job.id, {
        signal: controller.signal,
        fresh: true,
      });
      if (
        before.is_terminal ||
        !sameVerificationJobRevision(reviewed.job, before.job)
      ) {
        queryClient.setQueryData(detailKey, before);
        throw new Error(
          "This verification run changed after the cancellation dialog opened. Review its latest state before trying again.",
        );
      }
      await cancelVerificationJob(reviewed.job.id, controller.signal);
      const after = await getVerificationJob(reviewed.job.id, {
        signal: controller.signal,
        fresh: true,
      });
      queryClient.setQueryData(detailKey, after);
      queryClient.setQueryData<VerificationJob[]>(listKey, (current) =>
        (Array.isArray(current) ? current : []).map((job) =>
          job.id === after.job.id ? after.job : job,
        ),
      );
      if (after.job.status !== "canceled") {
        throw new Error(
          after.is_terminal
            ? `The run reached ${after.job.status} before cancellation took effect. Its terminal state was preserved.`
            : "The cancellation request returned, but a fresh read did not confirm a canceled state.",
        );
      }
      setConfirming(false);
      setSuccess({
        title: "Job state confirmed",
        body:
          after.job.ambiguous > 0
            ? `Cancellation confirmed. ${after.job.ambiguous.toLocaleString()} already-dispatched attempt(s) have an ambiguous provider outcome and may still have consumed credits.`
            : "Cancellation was confirmed by a fresh server read. Completed results remain available.",
      });
    } catch (caught) {
      if (!controller.signal.aborted && active.current) {
        setError(
          apiErrorMessage(
            caught,
            "Could not confirm verification cancellation.",
          ),
        );
        void detail.refetch();
        void jobs.refetch();
        throw caught;
      }
    } finally {
      if (active.current && operation.current === controller) setPending(false);
      if (operation.current === controller) operation.current = null;
    }
  }

  const busy = pending || startPending;

  return (
    <section aria-labelledby="v-jobs" className="rounded-lg border p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="v-jobs" className="text-base font-medium">
            Verification runs
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Start a durable bulk run, then inspect its server-reconciled
            progress, measured credit use, and per-address results. If the
            server holds bulk creation, its refusal is shown verbatim.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={jobs.isFetching || busy}
          onClick={() => void jobs.refetch()}
        >
          {jobs.isFetching ? "Refreshing…" : "Refresh jobs"}
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Job action not confirmed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {success ? (
        <Alert className="mt-4">
          <AlertTitle>{success.title}</AlertTitle>
          <AlertDescription>{success.body}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-4 rounded-md border p-4">
        <h3 className="text-sm font-medium">Start a verification run</h3>
        {!canWrite ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Owner or admin access outside viewer mode is required to start a
            run, because a run can spend provider credits.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <div>
              <Label htmlFor="v-run-source">Recipient source</Label>
              <Select
                id="v-run-source"
                className="mt-1"
                value={source}
                disabled={busy}
                onChange={(event) =>
                  setSource(event.target.value as VerificationJobCreateSource)
                }
              >
                {(
                  Object.keys(SOURCE_LABEL) as VerificationJobCreateSource[]
                ).map((option) => (
                  <option key={option} value={option}>
                    {SOURCE_LABEL[option]}
                  </option>
                ))}
              </Select>
            </div>
            {source === "inline" ? (
              <div>
                <Label htmlFor="v-run-addresses">Email addresses</Label>
                <Textarea
                  id="v-run-addresses"
                  className="mt-1 min-h-28"
                  value={addresses}
                  maxLength={MAX_PASTE_CHARS}
                  disabled={busy}
                  placeholder={"person@example.com\nanother@company.com"}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={Boolean(draft.error)}
                  aria-describedby="v-run-addresses-help"
                  onChange={(event) => setAddresses(event.target.value)}
                />
                <p
                  id="v-run-addresses-help"
                  className="mt-1 text-xs text-muted-foreground"
                >
                  Separate addresses with a line break, comma, semicolon, or
                  space.
                  {draft.unique !== null && draft.unique > 0
                    ? ` ${plural(draft.unique, "unique address", "unique addresses")} ready${
                        draft.duplicates > 0
                          ? `; ${plural(draft.duplicates, "duplicate")} removed`
                          : ""
                      }.`
                    : ""}
                </p>
              </div>
            ) : null}
            {source === "tag" ? (
              <div>
                <Label htmlFor="v-run-tag">Exact subscriber tag</Label>
                <Input
                  id="v-run-tag"
                  className="mt-1"
                  value={tag}
                  maxLength={MAX_TAG_CHARS}
                  disabled={busy}
                  autoComplete="off"
                  aria-invalid={Boolean(draft.error)}
                  onChange={(event) => setTag(event.target.value)}
                />
              </div>
            ) : null}
            {source === "all_subscribers" ? (
              <p className="self-end text-sm text-muted-foreground">
                Resolves the current subscriber directory on the server. The
                final address count and credit ceiling are unknown until the run
                is accepted.
              </p>
            ) : null}
          </div>
        )}
        {canWrite && draft.error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {draft.error}
          </p>
        ) : null}
        {canWrite ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={!draft.input || busy}
              loading={startPending}
              onClick={() => {
                setError(null);
                setSuccess(null);
                setStarting(true);
              }}
            >
              {startPending ? "Starting run…" : "Start verification run"}
            </Button>
            <span className="text-xs text-muted-foreground">
              An uncertain submit can be retried unchanged under the same
              billing identity.
            </span>
          </div>
        ) : null}
      </div>

      <h3 className="mt-6 text-sm font-medium">Recent jobs</h3>
      {jobs.isPending && !jobs.data ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Loading verification jobs…
        </p>
      ) : jobs.isError && !jobs.data ? (
        <Alert variant="destructive" className="mt-2">
          <AlertTitle>Job history unavailable</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(
              jobs.error,
              "Verification jobs have not been shown as an empty history.",
            )}
          </AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No verification jobs have been recorded.
        </p>
      ) : (
        <div className="mt-2 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
          <ul
            className="max-h-[34rem] space-y-2 overflow-auto"
            aria-label="Verification jobs"
          >
            {rows.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  className="w-full rounded-md border p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-pressed={selectedId === job.id}
                  onClick={() => {
                    setSelectedId(job.id);
                    setError(null);
                    setSuccess(null);
                  }}
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs">{job.id}</span>
                    <JobStatusBadge status={job.status} />
                  </span>
                  <span className="mt-2 block text-sm text-muted-foreground">
                    {job.processed.toLocaleString()} /{" "}
                    {job.total.toLocaleString()} processed ·{" "}
                    {job.credits_spent.toLocaleString()} credit(s)
                  </span>
                  <time
                    className="mt-1 block text-xs text-muted-foreground"
                    dateTime={job.created_at}
                  >
                    {formatWireTimestamp(
                      job.created_at,
                      "Unknown creation time",
                    )}
                  </time>
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0 rounded-md border p-4">
            {!selectedId ? (
              <p className="text-sm text-muted-foreground">
                Select a run to inspect its server-reconciled totals.
              </p>
            ) : detail.isPending && !detail.data ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading run detail…
              </p>
            ) : detail.isError && !detail.data ? (
              <Alert variant="destructive">
                <AlertTitle>Run detail unavailable</AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>
                    {apiErrorMessage(
                      detail.error,
                      "The selected run could not be verified.",
                    )}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={detail.isFetching}
                    onClick={() => void detail.refetch()}
                  >
                    Retry detail
                  </Button>
                </AlertDescription>
              </Alert>
            ) : detail.data ? (
              <JobDetail
                detail={detail.data}
                refreshing={detail.isFetching}
                pending={busy}
                canCancel={canWrite}
                queryKeyBase={queryKeyBase}
                onRefresh={() => void detail.refetch()}
                onCancel={() => setConfirming(true)}
              />
            ) : null}
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Non-terminal detail refreshes every three seconds. The response is
        authenticated and job-ID bound but does not include a tenant ID; tenant
        isolation is enforced by the server session, tenant context, and RLS.
      </p>

      <ConfirmDialog
        open={starting}
        onOpenChange={setStarting}
        title="Start verification run?"
        description={<span>{runConsequence(draft, tag)}</span>}
        confirmLabel="Start run"
        confirmVariant="default"
        onConfirm={start}
      />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Cancel verification run?"
        description={
          <span>
            Pending work will stop and the run cannot be resumed. Completed
            results remain. A provider request that was already dispatched can
            finish after cancellation; the server records that outcome as
            ambiguous and it may still consume a credit. The API has no
            conditional-write token, so a small race remains after the fresh
            state preflight.
          </span>
        }
        confirmLabel="Cancel run"
        confirmationToken={CANCEL_TOKEN}
        onConfirm={cancel}
      />
    </section>
  );
}

function JobStatusBadge({ status }: { status: VerificationJob["status"] }) {
  const variant =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "destructive"
        : status === "canceled"
          ? "outline"
          : "info";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

function JobDetail({
  detail,
  refreshing,
  pending,
  canCancel,
  queryKeyBase,
  onRefresh,
  onCancel,
}: {
  detail: Awaited<ReturnType<typeof getVerificationJob>>;
  refreshing: boolean;
  pending: boolean;
  canCancel: boolean;
  queryKeyBase: readonly unknown[];
  onRefresh: () => void;
  onCancel: () => void;
}) {
  const summary = VERIFICATION_STATUSES.flatMap((status) => {
    const count = detail.summary[status];
    return typeof count === "number" ? [[status, count] as const] : [];
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-all font-mono text-xs">{detail.job.id}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <JobStatusBadge status={detail.job.status} />
            <Badge variant="outline" className="capitalize">
              {detail.job.source.replaceAll("_", " ")}
            </Badge>
            <Badge variant="outline">{detail.job.execution_mode} mode</Badge>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={refreshing || pending}
          onClick={onRefresh}
        >
          {refreshing ? "Refreshing…" : "Refresh detail"}
        </Button>
      </div>

      <dl className="grid gap-2 sm:grid-cols-2">
        {[
          ["Processed", detail.job.processed],
          ["Total", detail.job.total],
          ["Cache hits", detail.job.cache_hits],
          ["Local filtered", detail.job.local_filtered],
          ["Vendor verified", detail.job.vendor_verified],
          ["Credits spent", detail.credits_spent],
          ["Credits saved", detail.credits_saved],
          ["Duplicates", detail.job.duplicates],
          ["Ambiguous", detail.job.ambiguous],
          ["Attempts", detail.job.attempts],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-md bg-muted/40 p-3">
            <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">
              {Number(value).toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>

      {summary.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium">Verdict summary</h3>
          <ul className="mt-2 divide-y rounded-md border">
            {summary.map(([status, count]) => (
              <li
                key={status}
                className="flex items-center justify-between gap-3 p-2 text-sm capitalize"
              >
                <span>{statusLabel(status)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {count.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail.job.has_error ? (
        <Alert variant="destructive">
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription>
            The server withheld raw infrastructure detail and returned only a
            sanitized failure state
            {detail.job.failure_code
              ? ` (${detail.job.failure_code.replaceAll("_", " ")})`
              : ""}
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {!detail.is_terminal && canCancel ? (
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel run
          </Button>
        ) : null}
        {!detail.is_terminal && !canCancel ? (
          <span className="text-sm text-muted-foreground">
            Owner or admin access is required to cancel this run.
          </span>
        ) : null}
        {detail.is_terminal ? (
          <span className="text-sm text-muted-foreground">
            This run is terminal and cannot be canceled.
          </span>
        ) : null}
      </div>

      {detail.is_terminal ? (
        <JobResults
          key={detail.job.id}
          jobId={detail.job.id}
          summary={detail.summary}
          queryKeyBase={queryKeyBase}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Per-address results are listed once the run is terminal.
        </p>
      )}
    </div>
  );
}

function verdictVariant(
  status: VerificationStatus,
): "success" | "destructive" | "warning" {
  if (status === "valid") return "success";
  if (status === "catch_all" || status === "unknown") return "warning";
  return "destructive";
}

function resultEvidence(row: VerificationJobResult): string {
  if (!row.processed) {
    return row.attempt_state === "ambiguous"
      ? "provider request dispatched; outcome unconfirmed and never shown as a verdict"
      : `not processed (${row.attempt_state})`;
  }
  const parts = [
    row.cached
      ? "cached result"
      : row.billable
        ? "provider credit spent"
        : "local check",
    row.provider ?? null,
    typeof row.score === "number" ? `score ${row.score}` : null,
    row.did_you_mean ? `did you mean ${row.did_you_mean}` : null,
    row.checked_at ? formatWireTimestamp(row.checked_at, "") : null,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function JobResults({
  jobId,
  summary,
  queryKeyBase,
}: {
  jobId: string;
  summary: Partial<Record<VerificationStatus, number>>;
  queryKeyBase: readonly unknown[];
}) {
  const [filter, setFilter] = useState<VerificationStatus | "">("");
  const [offset, setOffset] = useState(0);
  const results = useQuery({
    queryKey: [
      ...queryKeyBase,
      "job",
      jobId,
      "results",
      filter || "all",
      offset,
    ] as const,
    queryFn: ({ signal }) =>
      listVerificationJobResults(jobId, { status: filter, offset, signal }),
    staleTime: STALE.list,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const page = results.data;
  const rows = page?.results ?? [];
  const filterOptions = VERIFICATION_STATUSES.filter(
    (status) => (summary[status] ?? 0) > 0,
  );

  return (
    <div aria-busy={results.isFetching} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 id="v-job-results" className="text-sm font-medium">
            Per-address results
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Rows are ordered as the server stored them. Failed or canceled runs
            can include rows that were never processed.
          </p>
        </div>
        <div className="min-w-48">
          <Label htmlFor="v-results-filter">Filter results</Label>
          <Select
            id="v-results-filter"
            className="mt-1"
            value={filter}
            disabled={results.isFetching}
            onChange={(event) => {
              setFilter(event.target.value as VerificationStatus | "");
              setOffset(0);
            }}
          >
            <option value="">All statuses</option>
            {filterOptions.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)} ({(summary[status] ?? 0).toLocaleString()}
                )
              </option>
            ))}
          </Select>
        </div>
      </div>

      {results.isPending && !page ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading results…
        </p>
      ) : results.isError && !page ? (
        <Alert variant="destructive">
          <AlertTitle>Results unavailable</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {apiErrorMessage(
                results.error,
                "This page of results could not be verified.",
              )}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={results.isFetching}
              onClick={() => void results.refetch()}
            >
              Retry results
            </Button>
          </AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {offset > 0
            ? "No rows on this page."
            : filter
              ? `No ${statusLabel(filter)} rows were recorded for this run.`
              : "No per-address rows were recorded for this run."}
        </p>
      ) : (
        <TableContainer aria-labelledby="v-job-results">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead>Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.email}>
                  <TableCell className="break-all font-mono text-xs">
                    {row.email}
                  </TableCell>
                  <TableCell>
                    {row.processed ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={verdictVariant(row.status)}
                          className="capitalize"
                        >
                          {statusLabel(row.status)}
                        </Badge>
                        {row.sub_status ? (
                          <span className="text-xs text-muted-foreground">
                            {statusLabel(row.sub_status)}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <Badge variant="outline">
                        {row.attempt_state === "ambiguous"
                          ? "ambiguous"
                          : "not processed"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {resultEvidence(row)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {results.isError && page ? (
        <p role="alert" className="text-sm text-destructive">
          {apiErrorMessage(
            results.error,
            "The next page could not be verified; the last verified rows remain visible.",
          )}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {rows.length > 0
            ? `Rows ${(offset + 1).toLocaleString()} to ${(offset + rows.length).toLocaleString()}${page?.has_more ? "; more available" : ""}`
            : ""}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={offset === 0 || results.isFetching}
            onClick={() =>
              setOffset(Math.max(0, offset - VERIFICATION_RESULT_PAGE_SIZE))
            }
          >
            Previous page
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!page?.has_more || results.isFetching}
            onClick={() => setOffset(offset + VERIFICATION_RESULT_PAGE_SIZE)}
          >
            Next page
          </Button>
        </div>
      </div>
    </div>
  );
}
