// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Data operations makes preview-only tools visually distinct from billable
 * verification and release-held taxonomy writes. Every available mutation is
 * admin gated, and every result is retained in an in-session live log.
 */
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRightLeft,
  FlaskConical,
  Link2,
  MailCheck,
  Route,
  ShieldAlert,
  Tags,
  Trash2,
} from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AUDIT_SINK_KINDS,
  createVerificationJob,
  MAX_SYNCHRONOUS_VERIFICATION_BATCH,
  noRoutesToEvaluate,
  previewInboundRoute,
  previewUtm,
  retainVerificationAttemptKey,
  TAG_TAXONOMY_MUTATION_RELEASE_HOLD,
  testAuditSink,
  utmLeftUnchanged,
  verifyBatch,
} from "@/lib/data-operations-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import { useAdminGate } from "@/lib/use-admin-gate";
import { AdminGateNotice } from "@/components/admin-gate-notice";

/**
 * Mirrors `MaxJobAddresses` in apps/api/internal/verification/jobs.go. Held
 * here as a pre-flight so an oversized paste is named in plain language
 * instead of coming back as a 400 after the operator has already committed.
 */
const MAX_VERIFICATION_BATCH_ADDRESSES = 250000;

/**
 * Above this many unique addresses a mis-paste is expensive: every address is
 * billed to the verification provider and there is no preview mode. Below it
 * the live count under the textarea is proportionate warning on its own, so
 * the small day-to-day batch keeps its single click.
 */
const VERIFICATION_CONFIRM_THRESHOLD = 100;

type Operation = "rewrite" | "route" | "verify" | "sink";
type LogTone = "success" | "info" | "error";

interface LogEntry {
  id: number;
  message: string;
  tone: LogTone;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function parseEmailBatch(value: string): {
  emails: string[];
  invalid: string[];
  duplicates: number;
} {
  const tokens = value
    .split(/[\s,;]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  const byCanonical = new Map<string, string>();
  for (const token of tokens) {
    const canonical = token.toLowerCase();
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, token);
  }
  const emails = [...byCanonical.values()];
  return {
    emails,
    invalid: emails.filter((email) => !isEmail(email)),
    duplicates: tokens.length - emails.length,
  };
}

type EmailBatch = ReturnType<typeof parseEmailBatch>;

function addressCount(count: number): string {
  return `${count.toLocaleString()} unique address${count === 1 ? "" : "es"}`;
}

export default function DataOperationsPage() {
  const adminGate = useAdminGate();
  const { canWrite } = adminGate;
  const nextLogId = useRef(0);
  const verificationAttempt = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);

  const [log, setLog] = useState<LogEntry[]>([]);
  const [activeOperation, setActiveOperation] = useState<Operation | null>(
    null,
  );
  const [url, setUrl] = useState("https://example.com/pricing");
  const [recipient, setRecipient] = useState("support@example.com");
  const [batch, setBatch] = useState("");
  const [sinkKind, setSinkKind] = useState<string>(AUDIT_SINK_KINDS[0]);

  const [urlError, setUrlError] = useState("");
  const [recipientError, setRecipientError] = useState("");
  const [batchError, setBatchError] = useState("");
  const [verifyConfirmOpen, setVerifyConfirmOpen] = useState(false);
  const verifyButtonRef = useRef<HTMLButtonElement | null>(null);

  const busy = activeOperation !== null;
  // The count the operator is about to pay for, kept in sync with the paste so
  // it can be shown before the spend rather than reported after it.
  const parsedBatch = useMemo(() => parseEmailBatch(batch), [batch]);
  const batchSummary =
    parsedBatch.emails.length > 0
      ? `${addressCount(parsedBatch.emails.length)} will be verified${
          parsedBatch.duplicates > 0
            ? `, after removing ${parsedBatch.duplicates.toLocaleString()} duplicate${parsedBatch.duplicates === 1 ? "" : "s"}`
            : ""
        }.`
      : "";

  function say(message: string, tone: LogTone = "info") {
    nextLogId.current += 1;
    const entry = { id: nextLogId.current, message, tone };
    setLog((previous) => [entry, ...previous].slice(0, 15));
  }

  async function run(
    operation: Operation,
    action: () => Promise<void>,
  ): Promise<boolean> {
    setActiveOperation(operation);
    try {
      await action();
      return true;
    } catch (error) {
      say(
        error instanceof Error && error.message
          ? error.message
          : "That operation did not complete.",
        "error",
      );
      return false;
    } finally {
      setActiveOperation(null);
    }
  }

  /** True when the batch is safe to submit exactly as typed. */
  function acceptBatch(parsed: EmailBatch): boolean {
    if (parsed.emails.length === 0) {
      setBatchError("Enter at least one email address.");
      return false;
    }
    if (parsed.invalid.length > 0) {
      setBatchError(
        `${parsed.invalid.length.toLocaleString()} address${parsed.invalid.length === 1 ? " is" : "es are"} incomplete: ${parsed.invalid.slice(0, 3).join(", ")}${parsed.invalid.length > 3 ? "…" : ""}`,
      );
      return false;
    }
    if (parsed.emails.length > MAX_VERIFICATION_BATCH_ADDRESSES) {
      setBatchError(
        `${addressCount(parsed.emails.length)} exceeds the ${MAX_VERIFICATION_BATCH_ADDRESSES.toLocaleString()}-address limit for one job. Split the list and submit it in parts.`,
      );
      return false;
    }
    setBatchError("");
    return true;
  }

  async function verifyParsedBatch(parsed: EmailBatch): Promise<void> {
    const fingerprint = JSON.stringify(parsed.emails);
    let attempt = verificationAttempt.current;
    if (!attempt || attempt.fingerprint !== fingerprint) {
      attempt = { fingerprint, key: newUUIDv7() };
      verificationAttempt.current = attempt;
    }
    let durableStatus = "";
    try {
      if (parsed.emails.length > MAX_SYNCHRONOUS_VERIFICATION_BATCH) {
        const receipt = await createVerificationJob(parsed.emails, attempt.key);
        durableStatus = receipt.status;
      } else {
        await verifyBatch(parsed.emails, attempt.key);
      }
      verificationAttempt.current = null;
    } catch (error) {
      if (!retainVerificationAttemptKey(error)) {
        verificationAttempt.current = null;
      }
      throw error;
    }
    const duplicateNote =
      parsed.duplicates > 0
        ? `; ${parsed.duplicates.toLocaleString()} duplicate${parsed.duplicates === 1 ? " was" : "s were"} removed`
        : "";
    say(
      parsed.emails.length > MAX_SYNCHRONOUS_VERIFICATION_BATCH
        ? `${parsed.emails.length.toLocaleString()} unique addresses accepted as a durable verification job${duplicateNote}. Current status: ${durableStatus}. Monitor it on Email verification.`
        : `${addressCount(parsed.emails.length)} accepted for synchronous verification${duplicateNote}.`,
      durableStatus === "failed" || durableStatus === "canceled"
        ? "error"
        : "success",
    );
  }

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={FlaskConical}
        eyebrow="Operator workbench"
        title="Data operations"
        description="Preview rewrites and routing safely or verify a bounded email batch. Destructive taxonomy rewrites remain release-held."
      />

      <AdminGateNotice
        gate={adminGate}
        readOnlyMessage="You have read-only access to this page. Only workspace admins can preview protected routing, run billable verification, or send an audit-sink test."
      />

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <GovernanceSection
          icon={Link2}
          title="Link rewriting"
          description="Preview the exact URL produced by the current UTM template. Nothing is saved."
        >
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const value = url.trim();
              if (!isHttpUrl(value)) {
                setUrlError("Enter a complete http:// or https:// URL.");
                return;
              }
              setUrlError("");
              void run("rewrite", async () => {
                const preview = await previewUtm(value);
                if (utmLeftUnchanged(preview)) {
                  say(
                    preview.templateNeverConfigured
                      ? "The link came back unchanged: no UTM template has ever been saved, so nothing is being tagged."
                      : preview.templateEnabled
                        ? "The link came back unchanged even though a template is enabled—it did not match this URL."
                        : "The link came back unchanged: a template exists but is switched off.",
                  );
                } else {
                  say(`Rewritten to ${preview.rewritten}`, "success");
                }
              });
            }}
          >
            <Label htmlFor="do-url">URL</Label>
            <Input
              id="do-url"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                if (urlError) setUrlError("");
              }}
              aria-invalid={Boolean(urlError)}
              aria-describedby={urlError ? "do-url-error" : "do-url-help"}
              className="mt-2"
            />
            <p id="do-url-help" className="mt-2 text-xs text-muted-foreground">
              Only HTTP and HTTPS destinations can be previewed.
            </p>
            {urlError ? (
              <p
                id="do-url-error"
                role="alert"
                className="mt-2 text-sm text-destructive"
              >
                {urlError}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="outline"
              className="mt-3 w-full sm:w-auto"
              disabled={!canWrite || busy || url.trim() === ""}
              loading={activeOperation === "rewrite"}
            >
              <ArrowRightLeft aria-hidden="true" />
              Preview rewrite
            </Button>
          </form>
        </GovernanceSection>

        <GovernanceSection
          icon={Route}
          title="Inbound routing"
          description="Evaluate an address without delivering a message or changing route order."
        >
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const value = recipient.trim();
              if (!isEmail(value)) {
                setRecipientError("Enter a complete recipient email address.");
                return;
              }
              setRecipientError("");
              void run("route", async () => {
                const preview = await previewInboundRoute(value);
                if (noRoutesToEvaluate(preview)) {
                  say(
                    "No inbound routes exist, so nothing was evaluated. This is not evidence that configured routes fail to match.",
                  );
                } else if (preview.matches.length === 0) {
                  say(
                    `${preview.evaluated.toLocaleString()} route(s) were evaluated and none matched ${value}.`,
                  );
                } else {
                  say(
                    `${preview.matches.length.toLocaleString()} of ${preview.evaluated.toLocaleString()} route(s) match ${value}.`,
                    "success",
                  );
                }
              });
            }}
          >
            <Label htmlFor="do-recipient">To: address</Label>
            <Input
              id="do-recipient"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              value={recipient}
              onChange={(event) => {
                setRecipient(event.target.value);
                if (recipientError) setRecipientError("");
              }}
              aria-invalid={Boolean(recipientError)}
              aria-describedby={
                recipientError ? "do-recipient-error" : undefined
              }
              className="mt-2"
            />
            {recipientError ? (
              <p
                id="do-recipient-error"
                role="alert"
                className="mt-2 text-sm text-destructive"
              >
                {recipientError}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="outline"
              className="mt-3 w-full sm:w-auto"
              disabled={!canWrite || busy || recipient.trim() === ""}
              loading={activeOperation === "route"}
            >
              <Route aria-hidden="true" />
              Preview match
            </Button>
          </form>
        </GovernanceSection>
      </div>

      <GovernanceSection
        icon={Tags}
        title="Tag taxonomy"
        description="Legacy rename and merge operations are unavailable in this deployment."
      >
        <p
          role="note"
          className="rounded-lg bg-warning-subtle px-3 py-2.5 text-sm leading-6 text-warning-emphasis"
        >
          {TAG_TAXONOMY_MUTATION_RELEASE_HOLD}
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            disabled
            title={TAG_TAXONOMY_MUTATION_RELEASE_HOLD}
          >
            Rename unavailable
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="w-full sm:w-auto"
            disabled
            title={TAG_TAXONOMY_MUTATION_RELEASE_HOLD}
          >
            Merge unavailable
          </Button>
        </div>
      </GovernanceSection>

      <GovernanceSection
        icon={MailCheck}
        title="Batch email verification"
        description="Verify a deduplicated batch through the idempotent mutation path used for billable work."
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!acceptBatch(parsedBatch)) return;
            // A large paste is paid provider work the moment it is submitted,
            // so it gets a second, counted decision instead of one click.
            if (parsedBatch.emails.length > VERIFICATION_CONFIRM_THRESHOLD) {
              setVerifyConfirmOpen(true);
              return;
            }
            void run("verify", () => verifyParsedBatch(parsedBatch));
          }}
        >
          <Label htmlFor="do-emails">Email addresses</Label>
          <Textarea
            id="do-emails"
            value={batch}
            onChange={(event) => {
              setBatch(event.target.value);
              // Editing the request is a new semantic intent. It must never
              // reuse a key bound to the previous byte-identical batch.
              verificationAttempt.current = null;
              if (batchError) setBatchError("");
            }}
            placeholder="alex@example.com&#10;sam@example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={Boolean(batchError)}
            aria-describedby={batchError ? "do-emails-error" : "do-emails-help"}
            className="mt-2 min-h-32"
          />
          <p
            id="do-emails-help"
            className="mt-2 text-xs leading-5 text-muted-foreground"
          >
            Separate addresses with a line break, comma, semicolon, or space.
            Duplicates are removed before the request. Up to{" "}
            {MAX_SYNCHRONOUS_VERIFICATION_BATCH} run synchronously; larger
            batches become durable jobs that you can monitor on{" "}
            <Link className="underline" href="/app/verification">
              Email verification
            </Link>
            . Verification is billable: one credit per unique address, and up
            to {MAX_VERIFICATION_BATCH_ADDRESSES.toLocaleString()} addresses in
            one job.
          </p>
          {/* Always mounted: an aria-live region that only appears once the
              paste exists announces nothing on its first fill. */}
          <p
            aria-live="polite"
            className="mt-2 text-xs leading-5 text-muted-foreground empty:mt-0"
          >
            {batchSummary}
          </p>
          {batchError ? (
            <p
              id="do-emails-error"
              role="alert"
              className="mt-2 break-words text-sm text-destructive"
            >
              {batchError}
            </p>
          ) : null}
          <Button
            ref={verifyButtonRef}
            type="submit"
            className="mt-3 w-full sm:w-auto"
            disabled={!canWrite || busy || batch.trim() === ""}
            loading={activeOperation === "verify"}
          >
            <MailCheck aria-hidden="true" />
            Verify batch
            {parsedBatch.emails.length > 0
              ? ` · ${parsedBatch.emails.length.toLocaleString()} address${parsedBatch.emails.length === 1 ? "" : "es"}`
              : ""}
          </Button>
        </form>
        {canWrite ? (
          <ConfirmDialog
            open={verifyConfirmOpen}
            onOpenChange={setVerifyConfirmOpen}
            returnFocusRef={verifyButtonRef}
            title={`Verify ${addressCount(parsedBatch.emails.length)}?`}
            description={
              <span className="block space-y-2">
                <span className="block">
                  All {addressCount(parsedBatch.emails.length)} are sent to the
                  verification provider and spend one credit each. There is no
                  preview and no partial run: the credits are consumed whatever
                  the addresses turn out to be.
                </span>
                <span className="block">
                  This is past the {MAX_SYNCHRONOUS_VERIFICATION_BATCH}-address
                  synchronous limit, so it is accepted as a durable job and
                  keeps running after you leave this page. Track it on Email
                  verification.
                </span>
              </span>
            }
            confirmLabel="Verify and spend credits"
            confirmVariant="default"
            onConfirm={async () => {
              await run("verify", () => verifyParsedBatch(parsedBatch));
            }}
          />
        ) : null}
      </GovernanceSection>

      <GovernanceSection
        icon={ShieldAlert}
        title="Audit sink test"
        description="Send one test event to the selected audit destination kind."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run("sink", async () => {
              await testAuditSink(sinkKind);
              say(`Audit sink test for ${sinkKind} accepted.`, "success");
            });
          }}
        >
          <Label htmlFor="do-kind">Destination kind</Label>
          <Select
            id="do-kind"
            value={sinkKind}
            onChange={(event) => setSinkKind(event.target.value)}
            disabled={!canWrite || busy}
            className="mt-2"
          >
            {AUDIT_SINK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind.replace(/_/gu, " ")}
              </option>
            ))}
          </Select>
          <Button
            type="submit"
            variant="outline"
            className="mt-3 w-full sm:w-auto"
            disabled={!canWrite || busy}
            loading={activeOperation === "sink"}
          >
            Send test event
          </Button>
        </form>
      </GovernanceSection>

      <GovernanceSection
        icon={FlaskConical}
        title="Session results"
        description="The latest 15 outcomes are kept locally until this page is closed."
      >
        <div aria-live="polite" aria-relevant="additions" aria-busy={busy}>
          {log.length === 0 ? (
            <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-sm text-muted-foreground">
              Nothing run yet in this session.
            </p>
          ) : (
            <>
              <ul className="space-y-2">
                {log.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex min-w-0 items-start gap-2 rounded-lg border bg-muted/20 p-3"
                  >
                    <Badge
                      className="mt-0.5 shrink-0 capitalize"
                      variant={
                        entry.tone === "success"
                          ? "success"
                          : entry.tone === "error"
                            ? "destructive"
                            : "info"
                      }
                    >
                      {entry.tone}
                    </Badge>
                    <p className="min-w-0 break-words text-sm leading-6 [overflow-wrap:anywhere]">
                      {entry.message}
                    </p>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="ghost"
                className="mt-3 w-full sm:w-auto"
                disabled={!canWrite || busy}
                onClick={() => setLog([])}
              >
                <Trash2 aria-hidden="true" />
                Clear results
              </Button>
            </>
          )}
        </div>
      </GovernanceSection>

    </PageShell>
  );
}
