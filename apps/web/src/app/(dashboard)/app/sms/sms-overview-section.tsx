// SPDX-License-Identifier: AGPL-3.0-only

import { useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  SmsComplianceStatus,
  SmsPilotReadiness,
  SmsSenderPilotCertification,
  SmsSenderProfile,
  SmsSetupStatus,
} from "@/lib/sms-api";
import { senderPaused } from "./page-helpers";
import { CardLoadError } from "./sms-card-states";
import { SmsSetupChecklist, type SmsSetupTab } from "./sms-setup-checklist";

interface SmsOverviewSectionProps {
  loading: boolean;
  loadError?: string | null;
  pending: string | null;
  setup: SmsSetupStatus | null;
  compliance: SmsComplianceStatus | null;
  pilotReadiness: SmsPilotReadiness | null;
  senderCertifications: Record<string, SmsSenderPilotCertification>;
  onSenderPauseChange: (
    sender: SmsSenderProfile,
    paused: boolean,
  ) => void | Promise<void>;
  onGoToTab: (tab: SmsSetupTab) => void;
  onRetry?: () => void;
}

export function SmsOverviewSection({
  loading,
  loadError,
  pending,
  setup,
  compliance,
  pilotReadiness,
  senderCertifications,
  onSenderPauseChange,
  onGoToTab,
  onRetry,
}: SmsOverviewSectionProps) {
  const [pauseTarget, setPauseTarget] = useState<SmsSenderProfile | null>(null);
  const pauseTriggerRef = useRef<HTMLButtonElement | null>(null);
  const blockingReasons = setup?.blocking_reasons ?? [];

  return (
    <>
      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Setup</CardTitle>
            <CardDescription>
              {setup?.can_send
                ? "Ready for approved sends"
                : "Registration required"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadError && !setup ? (
              <CardLoadError
                message="Setup status unavailable."
                onRetry={onRetry}
              />
            ) : loading && !setup ? (
              <div className="space-y-2">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-32" />
              </div>
            ) : (
              <>
                <Badge variant={setup?.can_send ? "default" : "secondary"}>
                  {setup?.can_send ? "Send-ready" : "Blocked"}
                </Badge>
                <div className="space-y-1 text-sm">
                  {blockingReasons.length > 0 ? (
                    blockingReasons.map((reason) => (
                      <div key={reason} className="text-muted-foreground">
                        {reason.replaceAll("_", " ")}
                      </div>
                    ))
                  ) : (
                    <div className="text-muted-foreground">
                      No blocking reasons.
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Sender Profiles</CardTitle>
            <CardDescription>
              {setup?.senders?.length ?? 0} configured
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {(setup?.senders ?? []).map((item) => {
              const certification = senderCertifications[item.id];
              const paused = senderPaused(item);
              const blockers =
                certification?.items?.filter(
                  (check) => check.status === "blocker",
                ) ?? [];
              return (
                <div key={item.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">
                      {item.phone_number ||
                        item.messaging_service_sid ||
                        item.id}
                    </div>
                    <Badge
                      variant={
                        paused
                          ? "destructive"
                          : item.registration_status === "approved"
                            ? "default"
                            : "secondary"
                      }
                    >
                      {paused ? "paused" : item.registration_status}
                    </Badge>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {item.provider} · {item.country} · {item.sender_type}
                  </div>
                  {paused ? (
                    <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive-emphasis">
                      Sender kill switch is active. Queued recipients will not
                      be claimed, and new test/campaign sends are blocked.
                    </div>
                  ) : null}
                  {certification ? (
                    <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">
                          Live callback certification
                        </span>
                        <Badge
                          variant={
                            certification.can_pilot ? "default" : "secondary"
                          }
                        >
                          {certification.can_pilot
                            ? "Certified"
                            : "Needs proof"}
                        </Badge>
                      </div>
                      {blockers.length > 0 ? (
                        <div className="space-y-1 text-xs text-muted-foreground">
                          {blockers.slice(0, 3).map((check) => (
                            <div key={check.key}>
                              {check.label}: {check.detail}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          Inbound, delivery, consent, and provider checks have
                          usable evidence.
                        </div>
                      )}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {paused ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void onSenderPauseChange(item, false)}
                        disabled={pending === `resume-sender:${item.id}`}
                      >
                        Resume sender
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={(event) => {
                          pauseTriggerRef.current = event.currentTarget;
                          setPauseTarget(item);
                        }}
                        disabled={pending === `pause-sender:${item.id}`}
                      >
                        Pause sender
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {loadError && !setup?.senders?.length ? (
              <div className="sm:col-span-2">
                <CardLoadError
                  message="Sender profiles could not be loaded."
                  onRetry={onRetry}
                />
              </div>
            ) : loading && !setup?.senders?.length ? (
              <>
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </>
            ) : !loading && !setup?.senders?.length ? (
              <div className="sm:col-span-2">
                <EmptyState
                  icon={MessageSquareText}
                  title="No sender profiles yet"
                  description="Register a 10DLC, toll-free, or short-code sender to start sending. Head to the Registration tab to add one."
                />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <SmsSetupChecklist
        compliance={compliance}
        pilotReadiness={pilotReadiness}
        loading={loading}
        loadError={loadError}
        onGoToTab={onGoToTab}
        onRetry={onRetry}
      />

      {pauseTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setPauseTarget(null);
          }}
          title="Pause this sender?"
          description={`Pausing ${
            pauseTarget.phone_number ||
            pauseTarget.messaging_service_sid ||
            "this sender"
          } activates its kill switch — every queued recipient is halted and new test/campaign sends are blocked until you resume it.`}
          confirmLabel="Pause sender"
          fallbackFocusRef={pauseTriggerRef}
          onConfirm={async () => {
            const target = pauseTarget;
            setPauseTarget(null);
            await onSenderPauseChange(target, true);
          }}
        />
      ) : null}
    </>
  );
}
