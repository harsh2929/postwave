// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import { SearchX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  consentReceiptIdentity,
  getConsentLedgerPage,
  olderReceiptPageFailure,
  type ConsentLedger,
  type ConsentReceipt,
} from "@/lib/consent-receipts-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";

import { ConsentEvidenceFilters } from "./ConsentEvidenceFilters";
import { ConsentEvidenceSearch } from "./ConsentEvidenceSearch";
import { ConsentLoadOlder } from "./ConsentLoadOlder";
import { ConsentReceiptDrawer } from "./ConsentReceiptDrawer";
import {
  consentOutcomeGroup,
  consentOutcomeLabel,
  consentSourceCounts,
  DEFAULT_CONSENT_VIEW,
  evidenceKindLabel,
  filterConsentReceipts,
  type ConsentEvidenceView,
} from "./consent-evidence-view";
import { useConsentPageFamily } from "./use-consent-page-family";

const receiptsOf = (page: ConsentLedger) => page.receipts;

/**
 * The loaded consent receipt/proof register: search, filters, per-row Review
 * drawer, and cursor paging into older pages (desktop Consent.tsx:1251-1393).
 *
 * `ledger` is page one exactly as the owning page's admin-gated query read it.
 * This component only reads further along that page family — it never
 * mutates, and a continuation denial renders the server's own sentence.
 */
export function ConsentEvidenceRegister({ ledger }: { ledger: ConsentLedger }) {
  const family = useConsentPageFamily<ConsentLedger, ConsentReceipt>({
    base: ledger,
    rowsOf: receiptsOf,
    fetchPage: getConsentLedgerPage,
    pageFailure: olderReceiptPageFailure,
    noun: "receipt/proof",
    keptNoun: "evidence",
  });
  const [view, setView] = useState<ConsentEvidenceView>(DEFAULT_CONSENT_VIEW);
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(
    null,
  );
  const rows = family.rows;
  const filtered = useMemo(
    () => filterConsentReceipts(rows, view),
    [rows, view],
  );
  const sourceCounts = useMemo(() => consentSourceCounts(rows), [rows]);
  const selected =
    selectedIdentity === null
      ? null
      : (rows.find((row) => consentReceiptIdentity(row) === selectedIdentity) ??
        null);
  const reset = () => setView(DEFAULT_CONSENT_VIEW);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
        No consent receipts or proofs were returned on this page. This does not
        establish consent, suppression, or delivery eligibility for any
        subscriber.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
          Search and filters apply only to receipt/proof rows loaded from
          consent_receipts and consent_records. Consent events, SMS consent,
          suppressions, and channel eligibility are separate evidence planes.
        </p>
        <p className="text-sm tabular-nums" role="status" aria-live="polite">
          <strong>{filtered.length.toLocaleString()}</strong>{" "}
          <span className="text-muted-foreground">
            of {rows.length.toLocaleString()} loaded
          </span>
        </p>
      </div>

      <ConsentEvidenceSearch
        value={view.query}
        onChange={(query) => setView((current) => ({ ...current, query }))}
      />
      <ConsentEvidenceFilters
        view={view}
        sourceCounts={sourceCounts}
        onChange={(patch) => setView((current) => ({ ...current, ...patch }))}
        onReset={reset}
      />

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-6 text-center">
          <SearchX className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">
            No loaded evidence matches this view.
          </p>
          <p className="max-w-md text-xs leading-5 text-muted-foreground">
            Broaden the source, state, evidence type, or occurrence window.
            Rows on pages that have not been loaded cannot match.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={reset}>
            Reset view
          </Button>
        </div>
      ) : (
        <ul
          className="divide-y rounded-xl border"
          aria-label="Loaded receipt and proof evidence"
        >
          {filtered.map((receipt) => {
            const identity = consentReceiptIdentity(receipt);
            const group = consentOutcomeGroup(receipt.new_state);
            return (
              <li key={identity} className="min-w-0 p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium">
                      <bdi dir="auto">
                        {receipt.subscriber_email || "Subscriber not reported"}
                      </bdi>
                    </p>
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {evidenceKindLabel(receipt.kind)} · via{" "}
                      {receipt.source.replace(/_/gu, " ") || "source unstated"}
                      {receipt.privacy_policy_version
                        ? ` · policy ${receipt.privacy_policy_version}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        group === "opt-in"
                          ? "success"
                          : group === "opt-out"
                            ? "destructive"
                            : "outline"
                      }
                    >
                      {consentOutcomeLabel(receipt)}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Review ${evidenceKindLabel(receipt.kind).toLowerCase()} for ${receipt.subscriber_email || identity}`}
                      onClick={() => setSelectedIdentity(identity)}
                    >
                      Review
                    </Button>
                  </div>
                </div>
                <p className="mt-3 break-words text-sm leading-6 text-muted-foreground">
                  Given {formatWireTimestamp(receipt.at, "at an unknown time")};
                  recorded{" "}
                  {formatWireTimestamp(
                    receipt.recorded_at,
                    "at an unknown time",
                  )}
                  .
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <ConsentLoadOlder
        family={family}
        label="receipt / proof"
        loadLabel="Load older receipts"
        endLabel="End of the loaded receipt / proof page family"
      />

      <ConsentReceiptDrawer
        receipt={selected}
        onClose={() => setSelectedIdentity(null)}
      />
    </div>
  );
}
