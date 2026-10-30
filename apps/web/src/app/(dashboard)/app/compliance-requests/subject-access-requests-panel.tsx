// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Download, RefreshCw, ShieldAlert, UserRoundCheck } from "lucide-react";
import { toast } from "sonner";

import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  ARTICLE_17_ERASURE_HOLD_CODE,
  ARTICLE_17_ERASURE_HOLD_REASON,
  createSarAccessRequest,
  listSarStoreResponses,
  normalizeSarEmail,
  sarAccessDownloadPath,
  type SarAccessReceipt,
  type SarRegion,
  type SarRequest,
  type SarStoreResponse,
} from "@/lib/compliance-requests-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { newUUIDv7 } from "@/lib/http-fetch";
import { roleCanWrite } from "@/lib/use-admin-gate";

interface SubjectAccessRequestsPanelProps {
  identity: MeResponse | null;
  identityError: boolean;
  identityPending: boolean;
  identityRetrying: boolean;
  onRetryIdentity: () => void;
  requests: SarRequest[];
  requestsError: unknown;
  requestsFetching: boolean;
  requestsPending: boolean;
  reloadRequests: () => Promise<SarRequest[]>;
}

interface MutationIntent {
  fingerprint: string;
  idempotencyKey: string;
}

const REGIONS: Array<{ value: SarRegion; label: string }> = [
  { value: "GDPR", label: "EU / UK GDPR" },
  { value: "CCPA", label: "California CCPA / CPRA" },
  { value: "LGPD", label: "Brazil LGPD" },
  { value: "OTHER", label: "Other / not specified" },
];

export function SubjectAccessRequestsPanel({
  identity,
  identityError,
  identityPending,
  identityRetrying,
  onRetryIdentity,
  requests,
  requestsError,
  requestsFetching,
  requestsPending,
  reloadRequests,
}: SubjectAccessRequestsPanelProps) {
  const role = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = Boolean(
    identity && !identity.viewer_mode && roleCanWrite(role),
  );
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [region, setRegion] = useState<SarRegion>("GDPR");
  const [notes, setNotes] = useState("");
  const [fanoutEnabled, setFanoutEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SarAccessReceipt | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const [downloadingID, setDownloadingID] = useState<string | null>(null);
  const [storeState, setStoreState] = useState<{
    requestId: string;
    rows: SarStoreResponse[] | null;
    error: string | null;
  } | null>(null);
  const [storesLoading, setStoresLoading] = useState(false);

  const activeRef = useRef(true);
  const operationRef = useRef<"create" | "download" | "stores" | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const intentRef = useRef<MutationIntent | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  function clearIntent(): void {
    intentRef.current = null;
    setSubmitError(null);
  }

  function startNewAttempt(): void {
    intentRef.current = null;
    setSubmitError(null);
  }

  function resetDialog(): void {
    setOpen(false);
    // A response or readback failure can leave the server outcome unknown.
    // Preserve that exact intent across close/reopen so Retry cannot mint a
    // second bundle accidentally. Input changes or an explicit new attempt
    // are the only ways to rotate its key.
    if (submitError && !receipt && intentRef.current) return;
    setEmail("");
    setRegion("GDPR");
    setNotes("");
    setFanoutEnabled(false);
    setSubmitError(null);
    setReceipt(null);
    intentRef.current = null;
  }

  function onOpenChange(nextOpen: boolean): void {
    if (operationRef.current) return;
    if (!nextOpen) {
      resetDialog();
      queueMicrotask(() => triggerRef.current?.focus());
      return;
    }
    setActionNotice(null);
    setOpen(true);
  }

  async function createAccessRequest(): Promise<void> {
    if (!identity || !canAdmin || operationRef.current) return;
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeSarEmail(email);
    } catch (caught) {
      setSubmitError(apiErrorMessage(caught, "Enter a valid email address."));
      emailRef.current?.focus();
      return;
    }

    const input = { email: normalizedEmail, fanoutEnabled, notes, region };
    const fingerprint = JSON.stringify(input);
    let intent = intentRef.current;
    if (!intent || intent.fingerprint !== fingerprint) {
      intent = { fingerprint, idempotencyKey: newUUIDv7() };
      intentRef.current = intent;
    }
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    operationRef.current = "create";
    setSubmitting(true);
    setSubmitError(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const created = await createSarAccessRequest(input, {
        idempotencyKey: intent.idempotencyKey,
        signal: controller.signal,
      });
      const latest = await reloadRequests();
      const readback = latest.find((request) => request.id === created.id);
      if (
        !readback ||
        readback.kind !== "access" ||
        readback.status !== "ready" ||
        readback.subscriberEmail !== created.subscriberEmail ||
        readback.eventCount !== created.eventCount ||
        readback.consentCount !== created.consentCount ||
        readback.bundleBytes !== created.bundleBytes
      ) {
        throw new Error(
          "The subject-access request was not confirmed by a matching server readback. No completion claim was made.",
        );
      }
      if (!activeRef.current || controller.signal.aborted) return;
      intentRef.current = null;
      setReceipt(created);
      setActionNotice({
        kind: "success",
        text: `Request ${shortID(created.id)} was created and read back from the server.`,
      });
      toast.success("Subject-access bundle is ready.");
    } catch (caught) {
      if (!activeRef.current || controller.signal.aborted) return;
      setSubmitError(
        apiErrorMessage(
          caught,
          "Could not create the subject-access request. Nothing was reported as ready.",
        ),
      );
    } finally {
      if (operationRef.current === "create") operationRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
      if (activeRef.current) setSubmitting(false);
    }
  }

  async function download(requestId: string): Promise<void> {
    if (!identity || !canAdmin || operationRef.current) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    operationRef.current = "download";
    setDownloadingID(requestId);
    setActionNotice(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const latest = await reloadRequests();
      const readback = latest.find((item) => item.id === requestId);
      if (!readback) {
        throw new Error(
          "This subject-access request was not present in the fresh server read.",
        );
      }
      const path = sarAccessDownloadPath(readback);
      if (!activeRef.current || controller.signal.aborted) return;
      startBrowserDownload(path);
      setActionNotice({
        kind: "success",
        text: `Download started for request ${shortID(readback.id)} after a fresh authority and server-state check.`,
      });
    } catch (caught) {
      if (!activeRef.current || controller.signal.aborted) return;
      setActionNotice({
        kind: "error",
        text: apiErrorMessage(
          caught,
          "Could not authorize the subject-access download.",
        ),
      });
    } finally {
      if (operationRef.current === "download") operationRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
      if (activeRef.current) setDownloadingID(null);
    }
  }

  async function loadStoreResponses(requestId: string): Promise<void> {
    if (!identity || !canAdmin || operationRef.current) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    operationRef.current = "stores";
    setStoresLoading(true);
    setStoreState({ requestId, rows: null, error: null });
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const rows = await listSarStoreResponses(requestId, {
        signal: controller.signal,
      });
      if (!activeRef.current || controller.signal.aborted) return;
      setStoreState({ requestId, rows, error: null });
    } catch (caught) {
      if (!activeRef.current || controller.signal.aborted) return;
      setStoreState({
        requestId,
        rows: null,
        error: apiErrorMessage(
          caught,
          "Could not load connected-store access receipts.",
        ),
      });
    } finally {
      if (operationRef.current === "stores") operationRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
      if (activeRef.current) setStoresLoading(false);
    }
  }

  return (
    <GovernanceSection
      icon={UserRoundCheck}
      title="Data-subject requests"
      description="Create and download read-only Article 15 disclosures. Article 17 execution remains separately held."
    >
      <div className="space-y-5">
        <section className="space-y-3" aria-labelledby="article-15-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="article-15-title" className="text-sm font-semibold">
                Subject access — GDPR Article 15 / CCPA
              </h3>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                Build a Moosewave disclosure and optionally search connected
                stores in read-only mode. Provider deletion policies are never
                executed by this operation.
              </p>
            </div>
            {canAdmin ? (
              <Button
                ref={triggerRef}
                type="button"
                onClick={() => onOpenChange(true)}
              >
                New access request
              </Button>
            ) : null}
          </div>

          {identityPending ? (
            <GovernanceLoading label="Verifying SAR authority…" rows={2} />
          ) : identityError || !identity ? (
            <GovernanceError
              message="Workspace authority could not be verified, so no subject data was requested."
              retrying={identityRetrying}
              onRetry={onRetryIdentity}
            />
          ) : !canAdmin ? (
            <Alert>
              <AlertTitle>Owner or admin access required</AlertTitle>
              <AlertDescription>
                Subject-access bundles contain personal and consent data. This
                session is read-only, so the inventory was not fetched and no
                creation or download control is enabled.
              </AlertDescription>
            </Alert>
          ) : requestsPending ? (
            <GovernanceLoading
              label="Loading subject-access requests…"
              rows={3}
            />
          ) : requestsError ? (
            <GovernanceError
              message="Could not read subject-access requests. This failure is not an empty inventory."
              retrying={requestsFetching}
              onRetry={() => void reloadRequests()}
            />
          ) : requests.length === 0 ? (
            <GovernanceEmpty>
              No subject-access or historical erasure receipts are recorded.
            </GovernanceEmpty>
          ) : (
            <ul className="divide-y rounded-xl border">
              {requests.map((request) => (
                <li key={request.id} className="min-w-0 space-y-3 p-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="break-all font-mono text-xs text-muted-foreground">
                          {request.id}
                        </p>
                        <Badge variant={statusVariant(request.status)}>
                          {request.status}
                        </Badge>
                        <Badge variant="outline">
                          {request.kind === "access"
                            ? "Article 15 access"
                            : "Historical erasure receipt"}
                        </Badge>
                      </div>
                      <p className="mt-2 break-all text-sm font-medium">
                        {request.subscriberEmail}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Requested{" "}
                        {formatWireTimestamp(
                          request.requestedAt,
                          "at an unknown time",
                        )}
                        {request.region ? ` · ${request.region}` : ""}
                        {request.kind === "access"
                          ? ` · ${request.eventCount.toLocaleString()} events · ${request.consentCount.toLocaleString()} consent records · ${formatBytes(request.bundleBytes)}`
                          : request.rowsDeleted === null
                            ? " · affected-row count unavailable"
                            : ` · ${request.rowsDeleted.toLocaleString()} affected records`}
                      </p>
                    </div>
                    {request.kind === "access" &&
                    request.status === "ready" ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={Boolean(operationRef.current)}
                          loading={downloadingID === request.id}
                          onClick={() => void download(request.id)}
                        >
                          <Download className="size-4" aria-hidden />
                          Download ZIP
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={Boolean(operationRef.current)}
                          onClick={() => void loadStoreResponses(request.id)}
                        >
                          <RefreshCw
                            className={`size-4 ${
                              storesLoading &&
                              storeState?.requestId === request.id
                                ? "animate-spin"
                                : ""
                            }`}
                            aria-hidden
                          />
                          Store receipts
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {request.error ? (
                    <p role="alert" className="text-xs text-destructive">
                      {request.error}
                    </p>
                  ) : null}
                  {storeState?.requestId === request.id ? (
                    <StoreResponsesState
                      loading={storesLoading}
                      rows={storeState.rows}
                      error={storeState.error}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {actionNotice ? (
            <Alert
              role={actionNotice.kind === "error" ? "alert" : "status"}
              variant={
                actionNotice.kind === "error" ? "destructive" : "default"
              }
            >
              <AlertTitle>Subject-access action</AlertTitle>
              <AlertDescription>{actionNotice.text}</AlertDescription>
            </Alert>
          ) : null}
        </section>

        <Alert role="note" variant="warning">
          <ShieldAlert className="size-4" aria-hidden />
          <AlertTitle>
            Right to erasure — GDPR Article 17 unavailable
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{ARTICLE_17_ERASURE_HOLD_REASON}</p>
            <p>
              The server returns 409{" "}
              <code className="break-all">
                {ARTICLE_17_ERASURE_HOLD_CODE}
              </code>{" "}
              before the first write and does not persist a success receipt.
              Existing historical receipts do not make execution available.
            </p>
            <Button type="button" variant="outline" disabled>
              Erasure unavailable
            </Button>
          </AlertDescription>
        </Alert>
      </div>

      <AccessRequestDialog
        canAdmin={canAdmin}
        email={email}
        emailRef={emailRef}
        fanoutEnabled={fanoutEnabled}
        notes={notes}
        onClearIntent={clearIntent}
        onCreate={() => void createAccessRequest()}
        onDownloadReceipt={(created) => void download(created.id)}
        onEmailChange={setEmail}
        onFanoutChange={setFanoutEnabled}
        onNotesChange={setNotes}
        onNewAttempt={startNewAttempt}
        onOpenChange={onOpenChange}
        onRegionChange={setRegion}
        open={open}
        receipt={receipt}
        region={region}
        reset={resetDialog}
        submitError={submitError}
        submitting={submitting}
        downloading={downloadingID === receipt?.id}
      />
    </GovernanceSection>
  );
}

function shortID(id: string): string {
  return id.slice(0, 8);
}

function startBrowserDownload(path: string): void {
  const anchor = document.createElement("a");
  anchor.href = path;
  anchor.rel = "noopener";
  anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function statusVariant(
  status: SarRequest["status"],
): "success" | "warning" | "destructive" {
  if (status === "ready") return "success";
  if (status === "pending") return "warning";
  return "destructive";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function StoreResponsesState({
  error,
  loading,
  rows,
}: {
  error: string | null;
  loading: boolean;
  rows: SarStoreResponse[] | null;
}) {
  if (loading) {
    return <GovernanceLoading label="Loading connected-store receipts…" />;
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Store receipts unavailable</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (rows === null) return null;
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No connected-store receipts were recorded for this request.
      </p>
    );
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2" aria-label="Store receipts">
      {rows.map((row, index) => (
        <li
          key={row.id ?? `${row.provider}-${index}`}
          className="rounded-lg border bg-muted/20 p-3 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium capitalize">{row.provider}</span>
            <Badge variant={row.status === "error" ? "destructive" : "outline"}>
              {row.status.replace(/_/gu, " ")}
            </Badge>
          </div>
          {row.customerId ? (
            <p className="mt-1 break-all text-muted-foreground">
              Customer {row.customerId}
            </p>
          ) : null}
          {row.createdAt ? (
            <p className="mt-1 text-muted-foreground">
              Recorded {formatWireTimestamp(row.createdAt, "at an unknown time")}
            </p>
          ) : null}
          {row.receiptUrl ? (
            <a
              className="mt-2 inline-flex font-medium text-primary underline-offset-4 hover:underline"
              href={row.receiptUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open provider receipt
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface AccessRequestDialogProps {
  canAdmin: boolean;
  downloading: boolean;
  email: string;
  emailRef: RefObject<HTMLInputElement | null>;
  fanoutEnabled: boolean;
  notes: string;
  onClearIntent: () => void;
  onCreate: () => void;
  onDownloadReceipt: (receipt: SarAccessReceipt) => void;
  onEmailChange: (value: string) => void;
  onFanoutChange: (value: boolean) => void;
  onNotesChange: (value: string) => void;
  onNewAttempt: () => void;
  onOpenChange: (open: boolean) => void;
  onRegionChange: (value: SarRegion) => void;
  open: boolean;
  receipt: SarAccessReceipt | null;
  region: SarRegion;
  reset: () => void;
  submitError: string | null;
  submitting: boolean;
}

function AccessRequestDialog({
  canAdmin,
  downloading,
  email,
  emailRef,
  fanoutEnabled,
  notes,
  onClearIntent,
  onCreate,
  onDownloadReceipt,
  onEmailChange,
  onFanoutChange,
  onNotesChange,
  onNewAttempt,
  onOpenChange,
  onRegionChange,
  open,
  receipt,
  region,
  reset,
  submitError,
  submitting,
}: AccessRequestDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeDisabled={submitting || downloading}
        onEscapeKeyDown={(event) =>
          (submitting || downloading) && event.preventDefault()
        }
        onInteractOutside={(event) =>
          (submitting || downloading) && event.preventDefault()
        }
      >
        <DialogHeader>
          <DialogTitle>
            {receipt
              ? "Subject-access bundle ready"
              : "New subject-access request"}
          </DialogTitle>
          <DialogDescription>
            {receipt
              ? "The result below was matched against a fresh request-list read before completion was reported."
              : "Create a read-only disclosure. This does not erase Moosewave or connected-store data."}
          </DialogDescription>
        </DialogHeader>

        {receipt ? (
          <div className="space-y-3">
            <Alert>
              <UserRoundCheck className="size-4" aria-hidden />
              <AlertTitle>Bundle ready and read back</AlertTitle>
              <AlertDescription>
                Request {shortID(receipt.id)} contains{" "}
                {receipt.eventCount.toLocaleString()} events and{" "}
                {receipt.consentCount.toLocaleString()} consent records (
                {formatBytes(receipt.bundleBytes)}).
              </AlertDescription>
            </Alert>
            <StoreResponsesState
              loading={false}
              rows={receipt.storeResponses}
              error={null}
            />
          </div>
        ) : (
          <div className="space-y-4 py-1">
            <div className="space-y-2">
              <Label htmlFor="sar-subject-email">Data-subject email</Label>
              <Input
                ref={emailRef}
                id="sar-subject-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                maxLength={254}
                value={email}
                disabled={submitting}
                aria-invalid={Boolean(submitError)}
                onChange={(event) => {
                  onEmailChange(event.target.value);
                  onClearIntent();
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sar-region">Legal region</Label>
              <Select
                id="sar-region"
                value={region}
                disabled={submitting}
                onChange={(event) => {
                  onRegionChange(event.target.value as SarRegion);
                  onClearIntent();
                }}
              >
                {REGIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sar-notes">Internal notes (optional)</Label>
              <Textarea
                id="sar-notes"
                maxLength={4_096}
                rows={3}
                value={notes}
                disabled={submitting}
                onChange={(event) => {
                  onNotesChange(event.target.value);
                  onClearIntent();
                }}
              />
              <p className="text-xs text-muted-foreground">
                Notes are operator context; do not add unrelated personal data.
              </p>
            </div>
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <Checkbox
                checked={fanoutEnabled}
                disabled={submitting}
                onChange={(event) => {
                  onFanoutChange(event.target.checked);
                  onClearIntent();
                }}
              />
              <span>
                <span className="block font-medium">Search connected stores</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  Collect matching records in read-only mode. Provider deletion
                  policies are ignored.
                </span>
              </span>
            </label>
            {submitError ? (
              <div className="space-y-2">
                <Alert variant="destructive" role="alert">
                  <AlertTitle>Request not confirmed</AlertTitle>
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
                <p className="text-xs leading-5 text-muted-foreground">
                  Retry keeps the same request key in case the first outcome
                  was ambiguous. Starting a new attempt may create a second
                  disclosure bundle.
                </p>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting || downloading}
            onClick={reset}
          >
            Close
          </Button>
          {receipt ? (
            <Button
              type="button"
              loading={downloading}
              disabled={!canAdmin || submitting || downloading}
              onClick={() => onDownloadReceipt(receipt)}
            >
              <Download className="size-4" aria-hidden />
              Download ZIP
            </Button>
          ) : (
            <>
              {submitError ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={submitting}
                  onClick={onNewAttempt}
                >
                  Start new attempt
                </Button>
              ) : null}
              <Button
                type="button"
                loading={submitting}
                disabled={!canAdmin || submitting}
                onClick={onCreate}
              >
                {submitError
                  ? "Retry access request"
                  : "Create access bundle"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
