// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AuthCheck, AuthRecord } from "@/lib/inbox-reality-types";

import {
  authRecordBadgeVariant,
  authRecordLabel,
} from "./sender-settings-helpers";

function StatusBadge({ record }: { record: AuthRecord }) {
  return (
    <Badge variant={authRecordBadgeVariant(record)}>
      {authRecordLabel(record)}
    </Badge>
  );
}

export function AuthenticationHealthCard({
  checks,
  loading,
  loadError,
  notDeployed = false,
  onRetry,
  retrying = false,
}: {
  checks: AuthCheck[];
  loading: boolean;
  loadError: string | null;
  /** The deliverability service is not deployed in this environment. */
  notDeployed?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const primaryCheck = checks[0] ?? null;

  return (
    <Card
      id="auth-health"
      tabIndex={-1}
      className="scroll-mt-24 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-busy={loading || undefined}
    >
      <CardHeader>
        <CardTitle>Authentication health</CardTitle>
        <CardDescription>
          Live SPF, DKIM, and DMARC results from the deliverability service.{" "}
          {/* Cross-link to the custom-domain DNS surface (SETC-031). */}
          Review the separate, release-held legacy custom-host registry on the{" "}
          <Link
            href="/app/settings/domain"
            className="font-medium text-foreground underline underline-offset-2"
          >
            Domain &amp; DNS
          </Link>{" "}
          tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div role="status" className="text-sm text-muted-foreground">
            Loading auth checks...
          </div>
        ) : notDeployed ? (
          <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
            Authentication checks aren&apos;t available in this environment:
            it doesn&apos;t run the deliverability service. Your sender
            settings above still apply.
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="space-y-3 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive-emphasis"
          >
            <p className="break-words [overflow-wrap:anywhere]">
              Could not load authentication health. {loadError}
            </p>
            {onRetry ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={retrying}
                onClick={onRetry}
              >
                Retry authentication checks
              </Button>
            ) : null}
          </div>
        ) : !primaryCheck ? (
          <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
            No sending domain auth checks are available yet. Add and verify a
            domain before sending production campaigns.
          </div>
        ) : (
          <>
            <div className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
              Domain: <code className="text-xs">{primaryCheck.domain}</code>
            </div>
            {(
              [
                { key: "spf", label: "SPF" },
                { key: "dkim", label: "DKIM" },
                { key: "dmarc", label: "DMARC" },
              ] as const
            ).map((row) => (
              <div
                key={row.key}
                className="flex min-w-0 flex-col items-start gap-3 rounded-md border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{row.label}</div>
                  <div className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {primaryCheck[row.key].detail}
                  </div>
                </div>
                <StatusBadge record={primaryCheck[row.key]} />
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
