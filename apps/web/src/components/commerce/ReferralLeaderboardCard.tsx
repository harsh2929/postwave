// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Referral leaderboard with creation-time window chips and Retry. Desktop
 * parity: components/referrals/LeaderboardCard.tsx (chips 137-150, the
 * `referralsLeaderboardApi.get({window, limit})` read at 47, Retry 159-165).
 *
 *   GET /api/v1/referrals/leaderboard?window=<30d|90d|365d>&limit=20
 *
 * Each window is its own query entry under the host's key base, so switching
 * windows never shows the previous window's ranking under the new label, and
 * a failed window is an error for that window only (with its own Retry) —
 * never an empty leaderboard. The heading uses the server's `window_days`,
 * not the chip, so a server-side clamp is reported as what was ranked.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Trophy } from "lucide-react";

import { TableSkeleton } from "@/components/dashboard/skeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiErrorMessage } from "@/lib/api";
import { STALE } from "@/lib/query-keys";
import {
  getReferralLeaderboardForWindow,
  REFERRAL_LEADERBOARD_DEFAULT_WINDOW,
  REFERRAL_LEADERBOARD_LIMIT,
  REFERRAL_LEADERBOARD_WINDOWS,
  type ReferralLeaderboardWindow,
} from "@/lib/referrals-api";
import { cn } from "@/lib/utils";

export function ReferralLeaderboardCard({
  keyBase,
  enabled,
}: {
  /** The host page's tenant/role/principal-scoped referrals key base. */
  keyBase: readonly unknown[];
  /** False until identity is verified (and while the tab is hidden). */
  enabled: boolean;
}) {
  const [selectedWindow, setSelectedWindow] =
    useState<ReferralLeaderboardWindow>(REFERRAL_LEADERBOARD_DEFAULT_WINDOW);
  const leaderboard = useQuery({
    queryKey: [
      ...keyBase,
      "leaderboard",
      selectedWindow,
      REFERRAL_LEADERBOARD_LIMIT,
    ],
    queryFn: ({ signal }) =>
      getReferralLeaderboardForWindow({
        window: selectedWindow,
        limit: REFERRAL_LEADERBOARD_LIMIT,
        signal,
      }),
    enabled,
    staleTime: STALE.list,
  });
  const selected = REFERRAL_LEADERBOARD_WINDOWS.find(
    (option) => option.value === selectedWindow,
  );
  const windowDays = leaderboard.data?.window_days ?? selected?.days ?? 90;
  const rows = Array.isArray(leaderboard.data?.items)
    ? leaderboard.data.items
    : [];

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0">
          <CardTitle as="h2">Leaderboard</CardTitle>
          <CardDescription>
            Credited conversions ranked over the last {windowDays} days of
            referral creation time. Referrer addresses are masked by the server.
          </CardDescription>
        </div>
        <div
          role="group"
          aria-label="Leaderboard window"
          className="flex shrink-0 gap-1.5"
        >
          {REFERRAL_LEADERBOARD_WINDOWS.map((option) => {
            const active = option.value === selectedWindow;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                aria-label={`Show conversions from the last ${option.days} days`}
                onClick={() => setSelectedWindow(option.value)}
                className={cn(
                  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border px-3 text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent>
        {leaderboard.isPending ? (
          <div role="status" aria-label="Loading the referral leaderboard">
            <TableSkeleton
              rows={5}
              columns={["w-12", "w-40", "w-20", "w-20"]}
            />
          </div>
        ) : leaderboard.isError ? (
          <Alert variant="destructive">
            <AlertTitle>
              Leaderboard could not be loaded for the last{" "}
              {selected?.days ?? 90} days
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {apiErrorMessage(
                  leaderboard.error,
                  "The request failed; this is not an empty leaderboard.",
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={leaderboard.isFetching}
                onClick={() => void leaderboard.refetch()}
              >
                <RefreshCw aria-hidden />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title={`No referrers in the last ${windowDays} days`}
            description="Credited conversions will rank here once referral activity is recorded in this window."
          />
        ) : (
          <TableContainer aria-label="Referral leaderboard">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Rank</TableHead>
                  <TableHead>Referrer</TableHead>
                  <TableHead className="text-right">Conversions</TableHead>
                  <TableHead className="text-right">
                    Highest milestone
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow
                    key={`${row.rank}-${row.referrer_email_masked}-${index}`}
                  >
                    <TableCell className="font-medium tabular-nums">
                      #{row.rank}
                    </TableCell>
                    <TableCell className="break-all font-mono text-xs">
                      {row.referrer_email_masked}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.conversions.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.milestone > 0
                        ? `${row.milestone.toLocaleString()} referrals`
                        : "None"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </CardContent>
    </Card>
  );
}
