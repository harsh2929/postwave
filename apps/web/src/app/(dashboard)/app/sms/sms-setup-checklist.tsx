// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { ArrowRight, ListChecks } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { asRoute } from "@/lib/typed-routes";
import type { SmsComplianceStatus, SmsPilotReadiness } from "@/lib/sms-api";
import {
  buildSetupChecklist,
  checklistBadge,
  smsChecklistIdentity,
  type SmsRemediation,
} from "./page-helpers";
import { CardLoadError } from "./sms-card-states";

export type SmsSetupTab = "overview" | "audience" | "registration";

const TAB_FOR: Record<
  Exclude<SmsRemediation, null | "settings">,
  { tab: SmsSetupTab; cta: string }
> = {
  registration: { tab: "registration", cta: "Go to registration" },
  audience: { tab: "audience", cta: "Go to audience" },
  overview: { tab: "overview", cta: "Review senders" },
};

interface SmsSetupChecklistProps {
  compliance: SmsComplianceStatus | null;
  pilotReadiness: SmsPilotReadiness | null;
  loading: boolean;
  loadError?: string | null;
  onGoToTab: (tab: SmsSetupTab) => void;
  onRetry?: () => void;
}

export function SmsSetupChecklist({
  compliance,
  pilotReadiness,
  loading,
  loadError,
  onGoToTab,
  onRetry,
}: SmsSetupChecklistProps) {
  const items = buildSetupChecklist(compliance, pilotReadiness);
  const done = items.filter((item) => item.state === "done").length;
  const total = items.length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const canPilot = pilotReadiness?.can_pilot ?? false;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Setup &amp; compliance</CardTitle>
            <CardDescription>
              Complete these gates in order to move a list and flow into live
              pilot.
            </CardDescription>
          </div>
          <Badge variant={canPilot ? "success" : "secondary"}>
            {canPilot ? "Pilot-ready" : "Pilot blocked"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError && total === 0 ? (
          <CardLoadError
            message="Setup status could not be loaded."
            onRetry={onRetry}
          />
        ) : loading && total === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  {done} of {total} complete
                </span>
                <span className="text-muted-foreground">
                  {pilotReadiness
                    ? `${pilotReadiness.counts.opted_in_subscriptions ?? 0} opted-in · ${
                        pilotReadiness.counts.approved_senders ?? 0
                      } approved sender${
                        (pilotReadiness.counts.approved_senders ?? 0) === 1
                          ? ""
                          : "s"
                      }`
                    : null}
                </span>
              </div>
              <Progress
                value={percent}
                aria-label="SMS setup completion"
                aria-valuetext={`${done} of ${total} complete`}
              />
            </div>
            <ol className="space-y-2">
              {items.map((item) => {
                const badge = checklistBadge(item.state);
                const tabTarget =
                  item.remediation && item.remediation !== "settings"
                    ? TAB_FOR[item.remediation]
                    : null;
                return (
                  <li
                    key={smsChecklistIdentity(item)}
                    className="rounded-md border p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium">{item.label}</div>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    {item.detail ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {item.detail}
                      </div>
                    ) : null}
                    {item.state !== "done" ? (
                      item.remediation === "settings" ? (
                        <Button
                          asChild
                          size="sm"
                          variant="ghost"
                          className="mt-2 min-h-11 px-2 text-xs"
                        >
                          <Link href={asRoute("/app/settings")}>
                            Open Settings
                            <ArrowRight className="ml-1 h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      ) : tabTarget ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="mt-2 min-h-11 px-2 text-xs"
                          onClick={() => onGoToTab(tabTarget.tab)}
                        >
                          {tabTarget.cta}
                          <ArrowRight className="ml-1 h-3.5 w-3.5" />
                        </Button>
                      ) : null
                    ) : null}
                  </li>
                );
              })}
              {!loading && total === 0 ? (
                <li className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
                  <ListChecks className="h-5 w-5" aria-hidden />
                  No setup status yet.
                </li>
              ) : null}
            </ol>
          </>
        )}
      </CardContent>
    </Card>
  );
}
