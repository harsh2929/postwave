// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { listAuditLog, type AuditRow } from "@/lib/audit-api";
import { STALE } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import { Button } from "@/components/ui/button";
import { useSettingsQueryKey } from "./settings-query-key";

// Actions we consider security-relevant. The audit log is one stream; we
// inline the security slice here (SETC-055) rather than send users to the
// full Audit Log tab to correlate.
const SECURITY_KEYWORDS = [
  "login",
  "logout",
  "session",
  "totp",
  "2fa",
  "mfa",
  "password",
  "oauth",
  "sso",
  "scim",
  "security",
  "token",
  "role",
  "device",
];

function isSecurityAction(action: string): boolean {
  const a = action.toLowerCase();
  return SECURITY_KEYWORDS.some((kw) => a.includes(kw));
}

function humanizeAction(action: string): string {
  const cleaned = action.replace(/[._:]+/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function SecurityActivityCard() {
  const {
    queryKey,
    enabled,
    identityLoading,
    identityError,
    retryIdentity,
    retryingIdentity,
  } = useSettingsQueryKey("security-activity");
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => listAuditLog({ limit: 50 }, { signal }),
    enabled,
    retry: false,
    staleTime: STALE.list,
  });

  const rows: AuditRow[] = (
    Array.isArray(query.data?.rows) ? query.data?.rows : []
  )
    .filter((r) => isSecurityAction(r.action))
    .slice(0, 10);
  const loading = identityLoading || (query.isPending && !query.data);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent security activity</CardTitle>
        <CardDescription>
          Sign-ins, 2FA/token changes, and other security-relevant events from
          the audit log.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {identityError ? (
          <SecurityActivityError
            message="Account identity could not be verified. No security activity was requested."
            retrying={retryingIdentity}
            onRetry={retryIdentity}
          />
        ) : loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.error ? (
          <SecurityActivityError
            message={
              query.error instanceof ApiError && query.error.status === 403
                ? "Security activity access was refused. Your workspace role may have changed."
                : "Could not load security activity. This is a failed audit read, not an empty event history."
            }
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No recent security events"
            description="Sign-ins and 2FA/token changes will show up here as they happen."
          />
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-start justify-between gap-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {humanizeAction(row.action)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.actorLabel || row.actorType}
                    {row.ip ? ` · ${row.ip}` : ""}
                  </p>
                </div>
                <span
                  className="shrink-0 text-xs text-muted-foreground"
                  title={absoluteTime(row.at) || undefined}
                >
                  {timeAgo(row.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SecurityActivityError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        loading={retrying}
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}
