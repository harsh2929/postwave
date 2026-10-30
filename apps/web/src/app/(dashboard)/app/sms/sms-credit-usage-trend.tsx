// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
export function SmsCreditUsageTrend({
  availableCredits: _availableCredits,
}: {
  availableCredits?: number;
}) {
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      Usage and runway are unavailable while the authoritative SMS financial
      ledger is release-held (<code>sms_financial_ledger_release_held</code>).
    </p>
  );
}
