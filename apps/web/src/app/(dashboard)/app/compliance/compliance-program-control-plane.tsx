// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileCheck2,
  History,
  RotateCcw,
  ShieldBan,
  X,
} from "lucide-react";
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import {
  attestComplianceProgram,
  complianceFrameworkMeta,
  getComplianceProgram,
  listComplianceEvents,
  revokeComplianceProgram,
  type ComplianceAttestationInput,
  type ComplianceEvent,
  type ComplianceFramework,
  type ComplianceFrameworkMeta,
  type ComplianceProgram,
} from "@/lib/compliance-programs-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

type MutableFramework = Exclude<ComplianceFramework, "hipaa">;
const UTF8 = new TextEncoder();

function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

function statusVariant(
  status: ComplianceProgram["status"],
): "success" | "warning" | "destructive" | "outline" {
  if (status === "attested") return "success";
  if (status === "in_progress") return "warning";
  if (status === "unsupported") return "destructive";
  return "outline";
}

function statusLabel(status: ComplianceProgram["status"]): string {
  if (status === "attested") return "Attested";
  if (status === "in_progress") return "Not attested";
  if (status === "unsupported") return "Not offered";
  return "Revoked";
}

function displayTime(value: string | undefined, fallback = "Not recorded") {
  return formatWireTimestamp(value, fallback, (date) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  );
}

function sameLoadedRevision(
  opened: ComplianceProgram,
  fresh: ComplianceProgram,
): boolean {
  return (
    opened.framework === fresh.framework &&
    opened.status === fresh.status &&
    (opened.updatedAt ?? null) === (fresh.updatedAt ?? null)
  );
}

function defaultRenewalDate(months: number | null): string {
  if (!months) return "";
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function attestationInputError(
  input: ComplianceAttestationInput,
): string | null {
  const email = input.signedByEmail.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || utf8Bytes(email) > 320) {
    return "Enter one valid signer email address.";
  }
  if (utf8Bytes(input.signerName?.trim() ?? "") > 200) {
    return "Counter-signer must be at most 200 UTF-8 bytes.";
  }
  if (utf8Bytes(input.documentPath?.trim() ?? "") > 2048) {
    return "Evidence path must be at most 2,048 UTF-8 bytes.";
  }
  const digest = input.documentSha256?.trim() ?? "";
  if (digest && !/^[a-f0-9]{64}$/iu.test(digest)) {
    return "Document SHA-256 must be exactly 64 hexadecimal characters.";
  }
  if (utf8Bytes(input.notes?.trim() ?? "") > 4000) {
    return "Notes must be at most 4,000 UTF-8 bytes.";
  }
  if (input.renewalAt) {
    const renewal = Date.parse(input.renewalAt);
    if (!Number.isFinite(renewal)) return "Choose a valid renewal date.";
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (renewal < startOfToday.getTime()) {
      return "Renewal date cannot be in the past.";
    }
    const tenYears = new Date();
    tenYears.setFullYear(tenYears.getFullYear() + 10);
    if (renewal > tenYears.getTime()) {
      return "Renewal date cannot be more than 10 years away.";
    }
  }
  return null;
}

function AttestationDialog({
  meta,
  programme,
  identity,
  busy,
  onClose,
  onSubmit,
}: {
  meta: ComplianceFrameworkMeta;
  programme: ComplianceProgram;
  identity: MeResponse;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: ComplianceAttestationInput) => Promise<void>;
}) {
  const initial = useMemo(
    () => ({
      signedByEmail: programme.signedByEmail || identity.email,
      signerName: programme.signerName || "",
      documentPath: "",
      documentSha256: "",
      notes: "",
      renewalDate: defaultRenewalDate(meta.renewalCadenceMonths),
    }),
    [
      identity.email,
      meta.renewalCadenceMonths,
      programme.signedByEmail,
      programme.signerName,
    ],
  );
  const [signedByEmail, setSignedByEmail] = useState(initial.signedByEmail);
  const [signerName, setSignerName] = useState(initial.signerName);
  const [documentPath, setDocumentPath] = useState(initial.documentPath);
  const [documentSha256, setDocumentSha256] = useState(initial.documentSha256);
  const [notes, setNotes] = useState(initial.notes);
  const [renewalDate, setRenewalDate] = useState(initial.renewalDate);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const dirty =
    signedByEmail !== initial.signedByEmail ||
    signerName !== initial.signerName ||
    documentPath !== initial.documentPath ||
    documentSha256 !== initial.documentSha256 ||
    notes !== initial.notes ||
    renewalDate !== initial.renewalDate;
  useUnsavedChangesGuard(dirty && !busy);

  const input: ComplianceAttestationInput = {
    signedByEmail,
    signerName,
    documentPath,
    documentSha256,
    notes,
    ...(renewalDate
      ? { renewalAt: new Date(`${renewalDate}T00:00:00Z`).toISOString() }
      : {}),
    ...(programme.updatedAt ? { expectedUpdatedAt: programme.updatedAt } : {}),
  };

  function requestClose() {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  }

  function review() {
    const nextError = attestationInputError(input);
    setError(nextError);
    if (!nextError) setReviewOpen(true);
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent closeDisabled={busy} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {programme.status === "attested"
                ? `Record ${meta.short} renewal`
                : `Attest to ${meta.short}`}
            </DialogTitle>
            <DialogDescription>
              This records a workspace assertion and appends immutable evidence.
              Moosewave stores the assertion; it does not independently certify
              the framework gates.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              review();
            }}
          >
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Review the attestation</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="compliance-signer-email">Signer email</Label>
                <Input
                  id="compliance-signer-email"
                  type="email"
                  required
                  maxLength={320}
                  autoComplete="email"
                  value={signedByEmail}
                  disabled={busy}
                  onChange={(event) => setSignedByEmail(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="compliance-signer-name">
                  Counter-signer (optional)
                </Label>
                <Input
                  id="compliance-signer-name"
                  maxLength={200}
                  value={signerName}
                  disabled={busy}
                  onChange={(event) => setSignerName(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="compliance-document-path">
                Private evidence reference (optional)
              </Label>
              <Input
                id="compliance-document-path"
                maxLength={2048}
                placeholder="s3://private-compliance/soc2/report.pdf"
                value={documentPath}
                disabled={busy}
                onChange={(event) => setDocumentPath(event.target.value)}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Stored as a reference, not uploaded here. Never enter
                credentials, access tokens, PHI, or a public sharing link.
                {programme.documentPath
                  ? " Leave blank to retain the current reference."
                  : ""}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="compliance-document-sha">
                Document SHA-256 (optional)
              </Label>
              <Input
                id="compliance-document-sha"
                inputMode="text"
                maxLength={64}
                className="font-mono"
                placeholder="64 hexadecimal characters"
                value={documentSha256}
                disabled={busy}
                onChange={(event) => setDocumentSha256(event.target.value)}
              />
              {programme.documentSha256 ? (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  Current digest: {programme.documentSha256}. Leave blank to
                  retain it.
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_13rem]">
              <div className="space-y-2">
                <Label htmlFor="compliance-notes">Notes (optional)</Label>
                <Textarea
                  id="compliance-notes"
                  maxLength={4000}
                  value={notes}
                  disabled={busy}
                  onChange={(event) => setNotes(event.target.value)}
                />
                <p className="text-right text-xs tabular-nums text-muted-foreground">
                  {utf8Bytes(notes).toLocaleString()} / 4,000 UTF-8 bytes
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="compliance-renewal-date">
                  Next review (optional)
                </Label>
                <Input
                  id="compliance-renewal-date"
                  type="date"
                  value={renewalDate}
                  disabled={busy}
                  onChange={(event) => setRenewalDate(event.target.value)}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Review attestation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={reviewOpen}
        onOpenChange={(open) => !busy && setReviewOpen(open)}
        title={`Record ${meta.short} attestation?`}
        description={
          <span>
            Record <strong>{signedByEmail.trim()}</strong> as the signer and
            append a permanent{" "}
            {programme.status === "attested" ? "renewal" : "attestation"}
            {documentSha256.trim()
              ? " with a document digest"
              : " without a document digest"}
            .
          </span>
        }
        confirmLabel={
          programme.status === "attested"
            ? "Record renewal"
            : "Record attestation"
        }
        confirmVariant="default"
        onConfirm={() => onSubmit(input)}
      />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard this attestation draft?"
        description="The signer, evidence reference, digest, notes, and renewal date entered here will be lost."
        confirmLabel="Discard draft"
        onConfirm={onClose}
      />
    </>
  );
}

function RevocationDialog({
  meta,
  programme,
  busy,
  onClose,
  onSubmit,
}: {
  meta: ComplianceFrameworkMeta;
  programme: ComplianceProgram;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const dirty = reason.trim().length > 0;
  useUnsavedChangesGuard(dirty && !busy);

  function requestClose() {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent closeDisabled={busy}>
          <DialogHeader>
            <DialogTitle>Revoke {meta.short} attestation</DialogTitle>
            <DialogDescription>
              The workspace loses its attested status immediately. Existing
              evidence remains in the append-only event ledger.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="compliance-revoke-reason">Reason (optional)</Label>
            <Textarea
              id="compliance-revoke-reason"
              maxLength={2000}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Scope changed, evidence expired, or another reviewed reason"
            />
            <p className="text-right text-xs tabular-nums text-muted-foreground">
              {utf8Bytes(reason).toLocaleString()} / 2,000 UTF-8 bytes
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={requestClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => setReviewOpen(true)}
            >
              Review revocation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={reviewOpen}
        onOpenChange={(open) => !busy && setReviewOpen(open)}
        title={`Permanently record the ${meta.short} revocation?`}
        description={
          <span>
            This revokes revision{" "}
            <span className="break-all font-mono">{programme.updatedAt}</span>.
            Type <strong>{meta.short}</strong> to confirm the exact framework.
          </span>
        }
        confirmationToken={meta.short}
        confirmLabel={`Revoke ${meta.short}`}
        onConfirm={() => onSubmit(reason)}
      />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard the revocation reason?"
        description={`The ${meta.short} attestation has not been revoked.`}
        confirmLabel="Discard reason"
        onConfirm={onClose}
      />
    </>
  );
}

function EvidenceValue({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          mono ? "mt-1 break-all font-mono text-xs" : "mt-1 break-words text-sm"
        }
      >
        {children}
      </dd>
    </div>
  );
}

function EventRow({ event }: { event: ComplianceEvent }) {
  return (
    <li className="rounded-lg border bg-background p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold capitalize">
            {event.eventType.replace(/_/gu, " ")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {displayTime(event.at)} · event #{event.id.toLocaleString()}
          </p>
        </div>
        <Badge
          variant={event.eventType === "revoked" ? "destructive" : "outline"}
        >
          Immutable event
        </Badge>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Signer</dt>
          <dd className="break-all">{event.signedByEmail || "Not recorded"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Counter-signer</dt>
          <dd className="break-words">
            {event.counterSignedBy || "Not recorded"}
          </dd>
        </div>
      </dl>
      {event.documentPath ? (
        <p className="mt-2 break-all text-xs text-muted-foreground">
          Evidence reference:{" "}
          <span className="font-mono">{event.documentPath}</span>
        </p>
      ) : null}
      {event.documentSha256 ? (
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
          SHA-256: {event.documentSha256}
        </p>
      ) : null}
      {event.notes ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-5">
          {event.notes}
        </p>
      ) : null}
    </li>
  );
}

export function ComplianceProgramControlPlane({
  identity,
  programs,
  queryKeyBase,
  refreshPrograms,
}: {
  identity: MeResponse;
  programs: readonly ComplianceProgram[];
  queryKeyBase: readonly unknown[];
  refreshPrograms: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ComplianceFramework | null>(null);
  const [attestOpen, setAttestOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const meta = selected ? complianceFrameworkMeta(selected) : null;
  const selectedSummary = selected
    ? (programs.find((programme) => programme.framework === selected) ?? null)
    : null;
  const detailKey = [...queryKeyBase, "program", selected] as const;
  const eventsKey = [...queryKeyBase, "events", selected] as const;
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) =>
      getComplianceProgram(selected as ComplianceFramework, { signal }),
    enabled: Boolean(selected && selected !== "hipaa"),
    retry: false,
  });
  const events = useInfiniteQuery({
    queryKey: eventsKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      listComplianceEvents(selected as ComplianceFramework, {
        signal,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (lastPage, _pages, _lastPageParam, pageParams) =>
      lastPage.nextCursor && !pageParams.includes(lastPage.nextCursor)
        ? lastPage.nextCursor
        : undefined,
    enabled: Boolean(selected && selected !== "hipaa"),
    retry: false,
  });
  const eventRows = useMemo(
    () => events.data?.pages?.flatMap((page) => page.events) ?? [],
    [events.data?.pages],
  );

  function choose(framework: ComplianceFramework) {
    if (mutationBusy) return;
    setSelected((current) => (current === framework ? null : framework));
    setAttestOpen(false);
    setRevokeOpen(false);
    setMutationError(null);
  }

  async function refreshAfterMutation(
    framework: MutableFramework,
    confirmed: ComplianceProgram,
  ) {
    queryClient.setQueryData(
      [...queryKeyBase, "program", framework],
      confirmed,
    );
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: [...queryKeyBase, "events", framework],
      }),
      refreshPrograms(),
    ]);
  }

  async function attest(input: ComplianceAttestationInput): Promise<void> {
    if (!selected || selected === "hipaa" || !detail.data || mutationBusy)
      return;
    const target = selected;
    const opened = detail.data;
    setMutationBusy(true);
    setMutationError(null);
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await getComplianceProgram(target, { fresh: true });
      if (!sameLoadedRevision(opened, before)) {
        queryClient.setQueryData(detailKey, before);
        throw new Error(
          "This programme changed after the form opened. Nothing was written; review the refreshed evidence.",
        );
      }
      const receipt = await attestComplianceProgram(target, {
        ...input,
        ...(before.updatedAt ? { expectedUpdatedAt: before.updatedAt } : {}),
      });
      const confirmed = await getComplianceProgram(target, { fresh: true });
      if (
        confirmed.status !== "attested" ||
        confirmed.updatedAt !== receipt.updatedAt ||
        confirmed.signedByEmail !== input.signedByEmail.trim()
      ) {
        throw new Error(
          "The attestation request returned, but a fresh read did not confirm the exact recorded revision.",
        );
      }
      await refreshAfterMutation(target, confirmed);
      setAttestOpen(false);
      toast.success(
        before.status === "attested"
          ? `${meta?.short ?? target} renewal recorded.`
          : `${meta?.short ?? target} attestation recorded.`,
      );
    } catch (caught) {
      const message = apiErrorMessage(
        caught,
        "The compliance attestation could not be recorded.",
      );
      setMutationError(message);
      void detail.refetch();
      void events.refetch();
      throw caught instanceof Error ? caught : new Error(message);
    } finally {
      setMutationBusy(false);
    }
  }

  async function revoke(reason: string): Promise<void> {
    if (!selected || selected === "hipaa" || !detail.data || mutationBusy)
      return;
    const target = selected;
    const opened = detail.data;
    if (opened.status !== "attested" || !opened.updatedAt) {
      throw new Error(
        "Only the exact loaded attested revision can be revoked.",
      );
    }
    setMutationBusy(true);
    setMutationError(null);
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await getComplianceProgram(target, { fresh: true });
      if (!sameLoadedRevision(opened, before) || !before.updatedAt) {
        queryClient.setQueryData(detailKey, before);
        throw new Error(
          "This programme changed after the revocation opened. Nothing was written; review the refreshed evidence.",
        );
      }
      const receipt = await revokeComplianceProgram(target, {
        reason,
        expectedUpdatedAt: before.updatedAt,
      });
      const confirmed = await getComplianceProgram(target, { fresh: true });
      if (
        confirmed.status !== "revoked" ||
        confirmed.updatedAt !== receipt.updatedAt
      ) {
        throw new Error(
          "The revocation request returned, but a fresh read did not confirm the exact revoked revision.",
        );
      }
      await refreshAfterMutation(target, confirmed);
      setRevokeOpen(false);
      toast.success(`${meta?.short ?? target} attestation revoked.`);
    } catch (caught) {
      const message = apiErrorMessage(
        caught,
        "The compliance attestation could not be revoked.",
      );
      setMutationError(message);
      void detail.refetch();
      void events.refetch();
      throw caught instanceof Error ? caught : new Error(message);
    } finally {
      setMutationBusy(false);
    }
  }

  return (
    <GovernanceSection
      icon={FileCheck2}
      title="Framework detail and evidence"
      description="Open a framework to review its exact workspace assertion and immutable event history. Only owner/admin sessions can reach this control plane."
    >
      {programs.length === 0 ? (
        <GovernanceEmpty>
          No framework detail is available because the workspace reported an
          empty programme catalogue.
        </GovernanceEmpty>
      ) : (
        <div className="space-y-4">
          <ul className="grid gap-2 sm:grid-cols-2">
            {programs.map((programme) => {
              const rowMeta = complianceFrameworkMeta(programme.framework);
              const isSelected = selected === programme.framework;
              return (
                <li key={programme.framework}>
                  <button
                    type="button"
                    className="flex min-h-16 w-full items-center justify-between gap-3 rounded-xl border bg-background p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-expanded={isSelected}
                    aria-controls={
                      isSelected ? "compliance-program-detail" : undefined
                    }
                    disabled={mutationBusy}
                    onClick={() => choose(programme.framework)}
                  >
                    <span className="min-w-0">
                      <span className="block break-words text-sm font-semibold">
                        {rowMeta.short}
                      </span>
                      <span className="mt-0.5 block break-words text-xs text-muted-foreground">
                        {rowMeta.region}
                      </span>
                    </span>
                    <Badge
                      className="shrink-0"
                      variant={statusVariant(programme.status)}
                    >
                      {statusLabel(programme.status)}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>

          {selected && meta && selectedSummary ? (
            <section
              id="compliance-program-detail"
              aria-labelledby="compliance-program-detail-title"
              className="scroll-mt-24 rounded-xl border bg-muted/10 p-4 sm:p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3
                      id="compliance-program-detail-title"
                      className="text-lg font-semibold"
                    >
                      {meta.short}
                    </h3>
                    <Badge
                      variant={statusVariant(
                        (detail.data ?? selectedSummary).status,
                      )}
                    >
                      {statusLabel((detail.data ?? selectedSummary).status)}
                    </Badge>
                  </div>
                  <p className="mt-1 break-words text-sm text-muted-foreground">
                    {meta.full} · {meta.region}
                  </p>
                  <p className="mt-2 max-w-3xl text-sm leading-6">
                    {meta.description}
                  </p>
                  <a
                    className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm text-primary underline-offset-4 hover:underline sm:min-h-0"
                    href={meta.referenceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Official reference{" "}
                    <ExternalLink aria-hidden="true" className="size-3.5" />
                  </a>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={mutationBusy}
                  aria-label={`Close ${meta.short} detail`}
                  onClick={() => choose(selected)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>

              {selected === "hipaa" ? (
                <Alert variant="destructive" className="mt-4">
                  <ShieldBan aria-hidden="true" />
                  <AlertTitle>
                    HIPAA and PHI workloads are not supported
                  </AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>{selectedSummary.notes || meta.description}</p>
                    <p>
                      Historical metadata, encryption settings, or retention
                      settings do not create a BAA and do not authorize PHI use.
                      No attestation or revocation control is offered here.
                    </p>
                  </AlertDescription>
                </Alert>
              ) : detail.isPending ? (
                <div className="mt-4">
                  <GovernanceLoading
                    label={`Loading ${meta.short} detail…`}
                    rows={4}
                  />
                </div>
              ) : detail.isError || !detail.data ? (
                <div className="mt-4">
                  <GovernanceError
                    message={apiErrorMessage(
                      detail.error,
                      `Could not verify the ${meta.short} programme. Mutations are disabled.`,
                    )}
                    retrying={detail.isFetching}
                    onRetry={() => void detail.refetch()}
                  />
                </div>
              ) : (
                <>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={mutationBusy}
                      onClick={() => {
                        setMutationError(null);
                        setAttestOpen(true);
                      }}
                    >
                      {detail.data.status === "attested" ? (
                        <RotateCcw aria-hidden="true" />
                      ) : (
                        <CheckCircle2 aria-hidden="true" />
                      )}
                      {detail.data.status === "attested"
                        ? "Record renewal"
                        : "Attest"}
                    </Button>
                    {detail.data.status === "attested" ? (
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={mutationBusy || !detail.data.updatedAt}
                        onClick={() => {
                          setMutationError(null);
                          setRevokeOpen(true);
                        }}
                      >
                        <ShieldBan aria-hidden="true" />
                        Revoke
                      </Button>
                    ) : null}
                  </div>

                  {mutationError ? (
                    <Alert variant="destructive" className="mt-4">
                      <AlertTriangle aria-hidden="true" />
                      <AlertTitle>Compliance change not confirmed</AlertTitle>
                      <AlertDescription>{mutationError}</AlertDescription>
                    </Alert>
                  ) : null}

                  <Alert
                    variant={
                      detail.data.status === "attested" ? "default" : "warning"
                    }
                    className="mt-4"
                  >
                    <AlertTitle>
                      {detail.data.status === "attested"
                        ? `${meta.short} assertion on file`
                        : `${meta.short} is ${statusLabel(detail.data.status).toLowerCase()}`}
                    </AlertTitle>
                    <AlertDescription>
                      These checklist items are signer assertions. Moosewave does
                      not verify them individually or represent them as an
                      independent certification.
                    </AlertDescription>
                  </Alert>

                  {meta.gates.length > 0 ? (
                    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                      {meta.gates.map((gate) => (
                        <li
                          key={gate}
                          className="flex items-start gap-2 rounded-lg border bg-background p-3 text-sm"
                        >
                          <span
                            aria-hidden="true"
                            className="mt-0.5 text-muted-foreground"
                          >
                            ○
                          </span>
                          <span>{gate}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <EvidenceValue label="Signer">
                      {detail.data.signedByEmail || "Not recorded"}
                    </EvidenceValue>
                    <EvidenceValue label="Counter-signer">
                      {detail.data.signerName || "Not recorded"}
                    </EvidenceValue>
                    <EvidenceValue label="Attested">
                      {displayTime(detail.data.attestedAt)}
                    </EvidenceValue>
                    <EvidenceValue label="Next review">
                      {displayTime(detail.data.renewalAt, "No date set")}
                    </EvidenceValue>
                    <EvidenceValue label="Last state change">
                      {displayTime(detail.data.updatedAt)}
                    </EvidenceValue>
                    <EvidenceValue label="Evidence reference" mono>
                      {detail.data.documentPath || "Not recorded"}
                    </EvidenceValue>
                    <div className="sm:col-span-2 lg:col-span-3">
                      <EvidenceValue label="Document SHA-256" mono>
                        {detail.data.documentSha256 || "Not recorded"}
                      </EvidenceValue>
                    </div>
                    {detail.data.notes ? (
                      <div className="sm:col-span-2 lg:col-span-3">
                        <EvidenceValue label="Current notes">
                          <span className="whitespace-pre-wrap">
                            {detail.data.notes}
                          </span>
                        </EvidenceValue>
                      </div>
                    ) : null}
                  </dl>
                </>
              )}

              {selected !== "hipaa" ? (
                <div className="mt-6 border-t pt-5">
                  <div className="flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <History aria-hidden="true" className="size-4" />
                    </div>
                    <div>
                      <h4 className="font-semibold">Event ledger</h4>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Newest first. Attestation, renewal, amendment, and
                        revocation rows are append-only evidence.
                      </p>
                    </div>
                  </div>
                  {events.isPending ? (
                    <div className="mt-4">
                      <GovernanceLoading
                        label={`Loading ${meta.short} event ledger…`}
                        rows={3}
                      />
                    </div>
                  ) : events.isError && !events.data ? (
                    <div className="mt-4">
                      <GovernanceError
                        message={apiErrorMessage(
                          events.error,
                          `Could not load the ${meta.short} event ledger.`,
                        )}
                        retrying={events.isFetching}
                        onRetry={() => void events.refetch()}
                      />
                    </div>
                  ) : eventRows.length === 0 ? (
                    <div className="mt-4">
                      <GovernanceEmpty>
                        No evidence events have been recorded for {meta.short}.
                      </GovernanceEmpty>
                    </div>
                  ) : (
                    <>
                      {events.hasNextPage ? (
                        <Alert variant="warning" className="mt-4">
                          <AlertTriangle aria-hidden="true" />
                          <AlertTitle>Older evidence is available</AlertTitle>
                          <AlertDescription>
                            Evidence is retrieved in bounded newest-first pages.
                            Load the next page to continue the ledger.
                          </AlertDescription>
                        </Alert>
                      ) : null}
                      <ul className="mt-4 space-y-3">
                        {eventRows.map((event) => (
                          <EventRow key={event.id} event={event} />
                        ))}
                      </ul>
                      {events.isFetchNextPageError ? (
                        <div className="mt-4">
                          <GovernanceError
                            message={apiErrorMessage(
                              events.error,
                              `Could not load older ${meta.short} evidence. The evidence already shown remains current.`,
                            )}
                            retrying={events.isFetchingNextPage}
                            onRetry={() =>
                              void loadNextQueryPage(events, events.isEnabled)
                            }
                          />
                        </div>
                      ) : null}
                      {events.hasNextPage ? (
                        <div className="mt-4 flex justify-center">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={events.isFetchingNextPage}
                            aria-label={`Load older ${meta.short} evidence`}
                            onClick={() =>
                              void loadNextQueryPage(events, events.isEnabled)
                            }
                          >
                            <History aria-hidden="true" className="size-4" />
                            {events.isFetchingNextPage
                              ? "Loading older evidence…"
                              : "Load older evidence"}
                          </Button>
                        </div>
                      ) : (
                        <p
                          className="mt-4 text-center text-xs text-muted-foreground"
                          role="status"
                        >
                          All available evidence is shown.
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      )}

      {attestOpen && meta && detail.data && selected && selected !== "hipaa" ? (
        <AttestationDialog
          meta={meta}
          programme={detail.data}
          identity={identity}
          busy={mutationBusy}
          onClose={() => setAttestOpen(false)}
          onSubmit={attest}
        />
      ) : null}
      {revokeOpen && meta && detail.data && selected && selected !== "hipaa" ? (
        <RevocationDialog
          meta={meta}
          programme={detail.data}
          busy={mutationBusy}
          onClose={() => setRevokeOpen(false)}
          onSubmit={revoke}
        />
      ) : null}
    </GovernanceSection>
  );
}
