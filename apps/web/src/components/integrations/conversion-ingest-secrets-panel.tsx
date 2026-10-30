// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { AdminGateNotice } from "@/components/admin-gate-notice";
import { CopyTextButton } from "@/components/copy-text-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  effectiveAuthRole,
  whoami,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import {
  CONVERSION_INGEST_V2_CONTRACT,
  conversionIngestSecretLabelError,
  conversionIngestSecretsApi,
  type ConversionIngestSecretSummary,
  type IssuedConversionIngestSecret,
} from "@/lib/conversion-ingest-secrets-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { roleCanWrite, useAdminGate } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function revokeDescription(
  target: ConversionIngestSecretSummary | null,
  activeCount: number,
  registerComplete: boolean,
): string {
  if (!target) return "";
  const last =
    registerComplete && activeCount <= 1
      ? "This is the last live signed-ingest key. "
      : "";
  return (
    last +
    "Every conversion signed with “" +
    target.label +
    "” will be rejected immediately. During a planned rotation, move and " +
    "verify traffic on a new live key first. Revocation cannot be undone."
  );
}

function projectionLabel(item: ConversionIngestSecretSummary): string {
  switch (item.identityProjectionStatus) {
    case "ready":
      return "email HMAC ready";
    case "failed":
      return "email HMAC failed";
    default:
      return "email HMAC pending";
  }
}

function projectionGuidance(item: ConversionIngestSecretSummary): string {
  if (item.identityProjectionStatus === "ready") {
    return "Email-HMAC identities may use this exact key. Click-ID and external-ID-only events are also accepted.";
  }
  if (item.identityProjectionStatus === "pending") {
    return "Do not move email-HMAC traffic yet: those requests receive 503 until this key is ready. Refresh and keep the previous ready key live. Click-ID and external-ID-only events are unaffected.";
  }
  if (item.identityProjectionErrorCode === "secret_unavailable") {
    return "This key cannot prepare email identities. Keep the previous ready key live, revoke this failed key, then issue a replacement. Click-ID and external-ID-only events are unaffected.";
  }
  return "Email identity projection failed. Keep the previous ready key live, refresh, and contact support if the failure remains. Do not move email-HMAC traffic. Click-ID and external-ID-only events are unaffected.";
}

function issueOutcomeIsAmbiguous(error: unknown): boolean {
  if (!isApiError(error)) return true;
  return (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.kind === "aborted" ||
    error.kind === "parse" ||
    error.status === 408 ||
    error.status >= 500
  );
}

export function ConversionIngestSecretsPanel() {
  const client = useQueryClient();
  const adminGate = useAdminGate();
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<IssuedConversionIngestSecret | null>(
    null,
  );
  const [stored, setStored] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issueUncertain, setIssueUncertain] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] =
    useState<ConversionIngestSecretSummary | null>(null);
  const [abandonOpen, setAbandonOpen] = useState(false);

  const identity = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = identity.data?.tenant_id ?? "anon";
  const role = identity.data ? effectiveAuthRole(identity.data) : null;
  const registerKey = useMemo(
    () =>
      [
        ...base("conversion-ingest-secrets", tenantId, role),
        "register",
      ] as const,
    [role, tenantId],
  );
  const register = useInfiniteQuery({
    queryKey: registerKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      conversionIngestSecretsApi.list({ signal, cursor: pageParam }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: identity.isSuccess && adminGate.canWrite,
    staleTime: STALE.list,
  });
  const registerPages = Array.isArray(register.data?.pages)
    ? register.data.pages
    : [];
  const pageItems = registerPages.flatMap((page) => page.items);
  const pageCursors = registerPages.flatMap((page) =>
    page.nextCursor ? [page.nextCursor] : [],
  );
  const duplicatePageIds =
    new Set(pageItems.map((item) => item.keyId)).size !== pageItems.length;
  const duplicatePageCursors = new Set(pageCursors).size !== pageCursors.length;
  const items = duplicatePageIds || duplicatePageCursors ? [] : pageItems;
  const activeCount = items.filter((item) => item.revokedAt === null).length;
  useUnsavedChangesGuard(issuing || issued !== null || issueUncertain);

  async function verifyAuthority(opened: MeResponse): Promise<void> {
    const current = await whoamiFresh();
    if (
      current.user_id !== opened.user_id ||
      current.tenant_id !== opened.tenant_id
    ) {
      throw new Error(
        "Workspace identity changed. Reload before changing signing keys.",
      );
    }
    if (!roleCanWrite(effectiveAuthRole(current))) {
      throw new Error("An owner or admin role is required.");
    }
  }

  async function issue(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!identity.data || issued || issuing || issueUncertain) return;
    const normalized = label.trim();
    const validation = conversionIngestSecretLabelError(normalized);
    if (validation) {
      setOperationError(validation);
      return;
    }
    setIssuing(true);
    setOperationError(null);
    let submitted = false;
    try {
      await verifyAuthority(identity.data);
      submitted = true;
      const result = await conversionIngestSecretsApi.issue(normalized);
      setIssueUncertain(false);
      setIssued(result);
      setStored(false);
      setLabel("");
      toast.success(
        result.identityProjectionStatus === "ready"
          ? "Server signing key issued and email HMAC ready"
          : result.identityProjectionStatus === "failed"
            ? "Server signing key issued; email HMAC projection failed"
            : "Server signing key issued; email HMAC projection is pending",
      );
      void client.invalidateQueries({ queryKey: registerKey }).catch(() => {
        toast.warning(
          "The key was issued, but the register refresh failed. Keep the one-time secret open and review the register before retrying.",
        );
      });
    } catch (error) {
      if (submitted && issueOutcomeIsAmbiguous(error)) {
        setIssueUncertain(true);
        setOperationError(null);
        toast.error(
          "The issue outcome is unknown. Reconcile the key register before issuing again.",
        );
        try {
          await register.refetch();
        } catch {
          // The persistent recovery notice remains authoritative even when the
          // best-effort refresh itself cannot complete.
        }
        return;
      }
      const message = apiErrorMessage(
        error,
        "The signing key could not be issued.",
      );
      setOperationError(message);
      toast.error(message);
    } finally {
      setIssuing(false);
    }
  }

  async function revoke(target: ConversionIngestSecretSummary): Promise<void> {
    if (!identity.data) throw new Error("Workspace identity is unavailable.");
    await verifyAuthority(identity.data);
    await conversionIngestSecretsApi.revoke(target.keyId);
    toast.success("Server signing key revoked");
    void client.invalidateQueries({ queryKey: registerKey });
  }

  const loading =
    identity.isPending ||
    (adminGate.canWrite && register.isPending && register.data === undefined);
  const registerError =
    identity.error ??
    (duplicatePageIds || duplicatePageCursors
      ? new Error(
          "The signed-ingest key register repeated a key or cursor across pages and could not be verified.",
        )
      : adminGate.canWrite
        ? register.error
        : null);

  return (
    <section
      className="mt-8 border-t border-border pt-6"
      data-testid="conversion-ingest-secrets"
    >
      <div className="mb-4 flex items-start gap-3">
        <ShieldCheck
          className="mt-0.5 size-5 shrink-0 text-primary"
          aria-hidden
        />
        <div>
          <h2 className="text-lg font-semibold">
            Trusted server conversion ingest
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            These HMAC signing secrets authenticate authoritative server feeds.
            They are private credentials and are separate from the publishable
            browser tracking keys above.
          </p>
        </div>
      </div>

      <div className="mb-4 rounded-lg border bg-muted/20 p-3 text-xs leading-5">
        <p className="font-medium">Rotate overlap-first</p>
        <p className="text-muted-foreground">
          Issue a new key, wait until it says email HMAC ready, move the sender,
          verify accepted traffic, then revoke the old key. Keep both live
          during the handover. If a key leaked, revoke it immediately even when
          it is the last live key.
        </p>
      </div>

      <details className="mb-4 rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Exact signed-ingest v2 contract
        </summary>
        <div className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
          <p>
            POST <code>/api/public/conversions/ingest</code> (or the bounded
            batch route). Sign the exact raw JSON bytes; UTF-8 lengths below are
            byte lengths.
          </p>
          {CONVERSION_INGEST_V2_CONTRACT.map((line) => (
            <code
              key={line}
              role="region"
              aria-label="Conversion ingest protocol requirement"
              tabIndex={0}
              className="block overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 font-mono text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {line}
            </code>
          ))}
          <p>
            Derive the email pseudonym inside the sender. Send only{" "}
            <code>identity.email_hmac_sha256</code>; never send{" "}
            <code>identity.email</code>, plaintext email, or unsalted{" "}
            <code>email_sha256</code> to this API.
          </p>
        </div>
      </details>

      <AdminGateNotice
        gate={adminGate}
        className="mb-4"
        readOnlyMessage="Signed-ingest key management is admin-only. Ask a workspace owner or admin to issue, rotate, or revoke these private credentials."
      />

      {issued ? (
        <div
          className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3"
          role="alert"
        >
          <p className="text-sm font-semibold text-warning-emphasis">
            Store this secret now — this is its only display.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Put it in an approved secret manager. Clipboard history, browser
            extensions, and screen capture may retain copied credentials.
          </p>
          <div
            className={
              "mt-3 rounded-md border p-2 text-xs leading-5 " +
              (issued.identityProjectionStatus === "failed"
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : issued.identityProjectionStatus === "ready"
                  ? "border-success/40 bg-success/5 text-success"
                  : "border-warning/40 bg-warning/5 text-warning-emphasis")
            }
            role={
              issued.identityProjectionStatus === "failed" ? "alert" : "status"
            }
          >
            <strong>{projectionLabel(issued)}.</strong>{" "}
            {projectionGuidance(issued)} Updated{" "}
            {formatDate(issued.identityProjectionUpdatedAt)}.
          </div>
          <dl className="mt-3 grid gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Key ID (not secret)</dt>
              <dd className="break-all font-mono">{issued.keyId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Signing secret</dt>
              <dd className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded border bg-background px-2 py-2 font-mono">
                  {issued.secret}
                </code>
                <CopyTextButton
                  value={issued.secret}
                  label="Copy secret"
                  copiedLabel="Secret copied"
                  className="w-full sm:w-auto"
                />
              </dd>
            </div>
          </dl>
          <label className="mt-3 flex items-start gap-2 text-xs leading-5">
            <Checkbox
              checked={stored}
              onChange={(event) => setStored(event.target.checked)}
            />
            <span>
              I stored this exact secret and its key ID in an approved secret
              manager.
            </span>
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!stored}
              onClick={() => {
                setIssued(null);
                setStored(false);
              }}
            >
              Acknowledge and clear
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAbandonOpen(true)}
            >
              Abandon secret
            </Button>
          </div>
        </div>
      ) : null}

      {adminGate.canWrite ? (
        <form onSubmit={issue} className="mb-4 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <label
              htmlFor="conversion-ingest-secret-label"
              className="mb-1 block text-sm text-muted-foreground"
            >
              New server key label
            </label>
            <input
              id="conversion-ingest-secret-label"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={label}
              autoComplete="off"
              spellCheck={false}
              disabled={issuing || issued !== null || issueUncertain}
              onChange={(event) => {
                setLabel(event.target.value);
                setOperationError(null);
              }}
              placeholder="Production checkout service"
            />
          </div>
          <Button
            type="submit"
            className="w-full sm:w-auto"
            disabled={
              !label.trim() || issuing || issued !== null || issueUncertain
            }
            loading={issuing}
          >
            {issuing ? "Issuing…" : "Issue server key"}
          </Button>
        </form>
      ) : null}

      {operationError ? (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {operationError}
        </p>
      ) : null}
      {issueUncertain ? (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <p className="font-medium">The issue outcome is unknown.</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Refresh and inspect the key register. If a new key ID appeared,
            revoke it, then issue a replacement. Its one-time secret cannot be
            recovered. Never retry this issuance blindly.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={register.isFetching}
              onClick={() => void register.refetch()}
            >
              {register.isFetching ? "Refreshing…" : "Refresh key register"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setIssueUncertain(false);
                setOperationError(null);
              }}
            >
              Register reconciled — allow replacement
            </Button>
          </div>
        </div>
      ) : null}
      {registerError ? (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <span>
            {apiErrorMessage(
              registerError,
              "The signed-ingest key register could not be loaded.",
            )}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              void client.resetQueries({ queryKey: registerKey, exact: true })
            }
          >
            Retry
          </Button>
        </div>
      ) : null}
      {loading ? (
        <div className="space-y-2" aria-label="Loading server signing keys">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}
      {!loading &&
      adminGate.canWrite &&
      !registerError &&
      items.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No server signing keys"
          description="Issue the first private HMAC credential for signed server-to-server conversion ingest. This is not a browser tracking key."
        />
      ) : null}

      <div className="space-y-2">
        {items.map((item) => {
          const active = item.revokedAt === null;
          const stateClass = active
            ? "bg-success/15 text-success"
            : "bg-muted text-muted-foreground";
          return (
            <div
              key={item.keyId}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words text-sm font-medium">
                    {item.label}
                  </span>
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-[11px] " + stateClass
                    }
                  >
                    {active ? "active" : "revoked"}
                  </span>
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-[11px] " +
                      (item.identityProjectionStatus === "ready"
                        ? "bg-success/15 text-success"
                        : item.identityProjectionStatus === "failed"
                          ? "bg-destructive/15 text-destructive"
                          : "bg-warning/15 text-warning-emphasis")
                    }
                  >
                    {projectionLabel(item)}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {item.keyId}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Issued {formatDate(item.createdAt)}
                  {item.revokedAt
                    ? " · revoked " + formatDate(item.revokedAt)
                    : ""}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {projectionGuidance(item)} Projection updated{" "}
                  {formatDate(item.identityProjectionUpdatedAt)}.
                </p>
              </div>
              {active && adminGate.canWrite ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-destructive hover:text-destructive sm:w-auto"
                  disabled={issuing || issued !== null}
                  onClick={() => setRevokeTarget(item)}
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>

      {adminGate.canWrite && register.hasNextPage && !registerError ? (
        <Button
          type="button"
          variant="outline"
          className="mt-3 w-full sm:w-auto"
          disabled={register.isFetchingNextPage}
          loading={register.isFetchingNextPage}
          onClick={() => void loadNextQueryPage(register, register.isEnabled)}
        >
          {register.isFetchingNextPage
            ? "Loading more…"
            : "Load more server keys"}
        </Button>
      ) : null}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="Revoke this server signing key?"
        description={revokeDescription(
          revokeTarget,
          activeCount,
          !register.hasNextPage,
        )}
        confirmLabel="Revoke server key"
        onConfirm={async () => {
          const target = revokeTarget;
          if (!target) return;
          await revoke(target);
          setRevokeTarget(null);
        }}
      />
      <ConfirmDialog
        open={abandonOpen}
        onOpenChange={setAbandonOpen}
        title="Abandon the one-time signing secret?"
        description="The secret will be cleared from this page and cannot be displayed again. The key remains active until explicitly revoked."
        confirmLabel="Abandon secret"
        confirmationToken="ABANDON"
        onConfirm={() => {
          setIssued(null);
          setStored(false);
        }}
      />
    </section>
  );
}
