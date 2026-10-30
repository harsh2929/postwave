// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// The confidential consent-event read/export routes are explicitly
// release-held by Route40. Keep this boundary static so merely mounting or
// filtering the Audience tab cannot issue a PII request.

import { ScrollText } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function SmsConsentRosterCard({
  baseKey,
  enabled,
}: {
  baseKey: readonly unknown[];
  enabled: boolean;
}) {
  void baseKey;
  void enabled;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Consent log</CardTitle>
        </div>
        <CardDescription>
          Confidential opt-in/out evidence is unavailable in this release.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          role="status"
          className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
        >
          Confidential SMS evidence reads are release-held
          (sms_evidence_read_release_held). No consent-log or export request was
          sent. Consent recording and suppression controls remain separate.
        </div>
      </CardContent>
    </Card>
  );
}
