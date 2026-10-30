// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { History, RotateCcw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { pluralizeCount } from "@/lib/pluralize";

import type { ConsentPageFamily } from "./use-consent-page-family";

/**
 * "Load older …" for one consent page family, and "Retry older page" when the
 * last older page could not be reached or verified. Either way the rows above
 * stay on screen: a failed continuation is never an end-of-ledger claim.
 */
export function ConsentLoadOlder<Row>({
  family,
  label,
  loadLabel,
  endLabel,
}: {
  family: ConsentPageFamily<Row>;
  /** e.g. "receipt / proof" — used in the failure title. */
  label: string;
  /** e.g. "Load older receipts". */
  loadLabel: string;
  /** e.g. "End of the loaded receipt / proof page family". */
  endLabel: string;
}) {
  const loaded = family.rows.length;
  if (family.failure) {
    return (
      <Alert variant="warning" className="mt-4">
        <AlertTitle>Could not verify the next {label} page</AlertTitle>
        <AlertDescription>
          <p>{family.failure}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            loading={family.loading}
            onClick={family.loadOlder}
          >
            {!family.loading ? <RotateCcw aria-hidden /> : null}
            Retry older page
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="mt-4 flex flex-col items-start gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground" role="status">
        {family.canLoadOlder
          ? `${pluralizeCount(loaded, "row")} loaded; older pages are available.`
          : family.cursorMissing
            ? `${pluralizeCount(loaded, "row")} loaded. The server reports older rows but returned no continuation cursor; refresh to read from a new boundary.`
            : `${endLabel} (${pluralizeCount(loaded, "row")}).`}
      </p>
      {family.canLoadOlder ? (
        <Button
          type="button"
          variant="outline"
          loading={family.loading}
          onClick={family.loadOlder}
        >
          {!family.loading ? <History aria-hidden /> : null}
          {family.loading ? "Loading older page…" : loadLabel}
        </Button>
      ) : null}
    </div>
  );
}
