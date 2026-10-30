// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRef, type ReactNode } from "react";
import { ArrowRight, Eye, ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  consentReceiptIdentity,
  type ConsentReceipt,
} from "@/lib/consent-receipts-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";

import {
  consentOutcomeGroup,
  consentOutcomeLabel,
  evidenceKindLabel,
} from "./consent-evidence-view";

function exactTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function Fact({
  term,
  children,
  mono = false,
}: {
  term: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd
        className={
          mono
            ? "mt-0.5 break-all font-mono text-xs"
            : "mt-0.5 break-words text-sm"
        }
        dir="auto"
      >
        {children}
      </dd>
    </div>
  );
}

function TimeFact({ term, value }: { term: string; value: string }) {
  const exact = exactTimestamp(value);
  return (
    <Fact term={term}>
      <span className="block">
        {formatWireTimestamp(value, "Timestamp not verified")}
      </span>
      {exact ? (
        <code className="block font-mono text-xs text-muted-foreground">
          {exact}
        </code>
      ) : null}
    </Fact>
  );
}

/**
 * Review one loaded consent receipt / structured proof.
 *
 * Renders the exact loaded row — there is no detail fetch. The raw payload can
 * carry an email address, IP address, browser details, and policy text, so it
 * stays collapsed behind a disclosure whose first child is the PII warning
 * (desktop ConsentReceiptDrawer.tsx:262-287).
 */
export function ConsentReceiptDrawer({
  receipt,
  gpcSignalInLoadedWindow = null,
  onClose,
}: {
  receipt: ConsentReceipt | null;
  /**
   * Whether a GPC-tagged consent event for this email is in the loaded event
   * pages; null when no event pages are loaded on this surface.
   */
  gpcSignalInLoadedWindow?: boolean | null;
  onClose: () => void;
}) {
  const rawRef = useRef<HTMLDetailsElement | null>(null);
  const rawSummaryRef = useRef<HTMLElement | null>(null);

  const contextFields = receipt
    ? [
        { label: "Source detail", recorded: Boolean(receipt.source_detail?.trim()) },
        {
          label: "Policy version",
          recorded: Boolean(receipt.privacy_policy_version?.trim()),
        },
        { label: "Captured text", recorded: Boolean(receipt.captured_text?.trim()) },
        { label: "IP address", recorded: Boolean(receipt.ip?.trim()) },
        { label: "User agent", recorded: Boolean(receipt.user_agent?.trim()) },
      ]
    : [];
  const recordedContext = contextFields.filter((f) => f.recorded).length;
  const group = receipt ? consentOutcomeGroup(receipt.new_state) : "other";

  return (
    <Dialog
      open={receipt !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {receipt ? (
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">
              {evidenceKindLabel(receipt.kind)}
            </p>
            <DialogTitle className="break-all leading-snug">
              <bdi dir="auto">
                {receipt.subscriber_email || "Subscriber not reported"}
              </bdi>
            </DialogTitle>
            <DialogDescription className="break-all">
              Recorded evidence {consentReceiptIdentity(receipt)} ·
              server-recorded{" "}
              {formatWireTimestamp(receipt.recorded_at, "at an unverified time")}
            </DialogDescription>
          </DialogHeader>

          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (rawRef.current) rawRef.current.open = true;
                rawSummaryRef.current?.focus();
              }}
            >
              <Eye aria-hidden />
              Review raw evidence
            </Button>
          </div>

          <Alert>
            <AlertTitle>Stored evidence, not an independent assurance</AlertTitle>
            <AlertDescription>
              This panel shows exact fields from one loaded list row. It does
              not independently prove complete history, append-only storage,
              retention, legal hold, policy delivery, legal sufficiency, or
              current send eligibility.
            </AlertDescription>
          </Alert>

          <section aria-label="Recorded state" className="rounded-xl border p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recorded state
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
                <bdi dir="auto">
                  {receipt.prev_state || "Prior state not recorded"}
                </bdi>
                <ArrowRight className="size-4" aria-label="changed to" />
                <bdi dir="auto">{receipt.new_state || "State not recorded"}</bdi>
              </p>
              <Badge
                variant={
                  group === "opt-in"
                    ? "success"
                    : group === "opt-out"
                      ? "destructive"
                      : group === "pending"
                        ? "warning"
                        : "outline"
                }
              >
                {consentOutcomeLabel(receipt)}
              </Badge>
            </div>
          </section>

          <section aria-labelledby="consent-receipt-identity">
            <h3 id="consent-receipt-identity" className="text-sm font-semibold">
              What the source returned
            </h3>
            <dl className="mt-2 grid gap-3 sm:grid-cols-2">
              <Fact term="Exact identity" mono>
                {consentReceiptIdentity(receipt)}
              </Fact>
              <Fact term="Evidence type">{evidenceKindLabel(receipt.kind)}</Fact>
              <Fact term="Recorded state">{receipt.new_state || "Not recorded"}</Fact>
              <Fact term="Prior state">{receipt.prev_state || "Not recorded"}</Fact>
              <TimeFact term="Evidence occurred" value={receipt.at} />
              <TimeFact term="Server recorded" value={receipt.recorded_at} />
            </dl>
          </section>

          <section aria-labelledby="consent-receipt-provenance">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3
                id="consent-receipt-provenance"
                className="text-sm font-semibold"
              >
                Recorded capture context
              </h3>
              <span className="text-xs text-muted-foreground">
                {recordedContext} of {contextFields.length} optional context
                fields recorded
              </span>
            </div>
            <dl className="mt-2 grid gap-3 sm:grid-cols-2">
              <Fact term="Source" mono>
                {receipt.source || "Not recorded"}
              </Fact>
              <Fact term="Source detail">
                {receipt.source_detail || "Not recorded"}
              </Fact>
              <Fact term="Policy version" mono>
                {receipt.privacy_policy_version || "Not recorded"}
              </Fact>
              <Fact term="Captured text">
                {receipt.captured_text || "Not recorded"}
              </Fact>
              <Fact term="IP address" mono>
                {receipt.ip || "Not recorded"}
              </Fact>
              <Fact term="User agent">{receipt.user_agent || "Not recorded"}</Fact>
            </dl>
          </section>

          <section aria-labelledby="consent-receipt-gpc">
            <h3 id="consent-receipt-gpc" className="text-sm font-semibold">
              Global Privacy Control signal
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {gpcSignalInLoadedWindow === null
                ? "No consent-event pages are loaded on this surface, so a GPC signal cannot be correlated for this subscriber here."
                : gpcSignalInLoadedWindow
                  ? "A GPC-tagged event for this email appears in the loaded event pages. This does not establish the subscriber's current preference or prove downstream enforcement."
                  : "No GPC-tagged event for this email appears in the event pages currently loaded. This is not proof that no signal exists in complete history."}
            </p>
          </section>

          <details ref={rawRef} className="rounded-xl border p-3">
            <summary
              ref={(node) => {
                rawSummaryRef.current = node;
              }}
              className="cursor-pointer text-sm font-medium"
            >
              Inspect raw list-row payload
            </summary>
            <Alert variant="warning" className="mt-3">
              <ShieldAlert aria-hidden />
              <AlertTitle>Sensitive personal data</AlertTitle>
              <AlertDescription>
                The raw payload can contain an email address, IP address,
                browser details, policy text, and source metadata. Do not paste
                it into an unapproved system.
              </AlertDescription>
            </Alert>
            <pre
              aria-label="Raw consent evidence JSON"
              tabIndex={0}
              dir="ltr"
              className="mt-3 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs"
            >
              {JSON.stringify(receipt, null, 2)}
            </pre>
          </details>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
