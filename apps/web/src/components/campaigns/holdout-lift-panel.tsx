// SPDX-License-Identifier: AGPL-3.0-only
//
// F02 — incremental lift from a holdout, on the campaign it belongs to.
//
// The routes, the frozen assignment ledger, the power calculation and the
// confidence intervals have all existed with nothing rendering them. This is
// the surface.
//
// Every other number on a campaign page is correlational: it tells you what
// happened after the send. A holdout deliberately does not send to a random
// slice, so the gap between the two arms is what the campaign CAUSED. That is
// the only causal figure in the product, and it is worth exactly as much as
// its power — which is why an underpowered comparison shows no number here at
// all. liftVerdict returns a union with no field to read one out of.

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiError } from "@/lib/api";
import {
  createHoldout,
  deleteHoldout,
  formatSignedPercent,
  getHoldout,
  getHoldoutLift,
  holdoutReadiness,
  liftVerdict,
  validateHoldoutInput,
  type Holdout,
  type HoldoutLift,
} from "@/lib/holdout-lift";
import { base, STALE } from "@/lib/query-keys";
import type { MeResponse } from "@/lib/auth-api";
import {
  canAdminCampaigns,
  confirmFreshCampaignAdminAuthority,
} from "@/lib/campaign-write-authority";

const rate = (value: number) => `${(value * 100).toFixed(2)}%`;
const count = (value: number) => value.toLocaleString();

function Verdict({ lift }: { lift: HoldoutLift }) {
  const verdict = liftVerdict(lift);

  if (verdict.kind === "pending") {
    return <p className="text-sm text-muted-foreground">{verdict.message}</p>;
  }

  if (verdict.kind === "underpowered") {
    // No number, on purpose. A lift figure from an underpowered test is worse
    // than no figure, because it is the one that gets quoted in a deck.
    return (
      <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
        <p className="text-sm font-medium">Not enough data to measure lift</p>
        <p className="mt-1 text-sm text-muted-foreground">{verdict.reason}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          A difference smaller than {rate(verdict.minimumDetectableEffect)}{" "}
          cannot be told apart from chance at this size. No lift number is
          shown, because one would be indistinguishable from noise.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-2xl font-semibold tabular-nums">
          {verdict.relativeLift === null
            ? rate(verdict.absoluteLift)
            : formatSignedPercent(verdict.relativeLift)}
        </p>
        <p className="text-sm text-muted-foreground">
          more conversions than not sending at all
          {verdict.incrementalConversions === null
            ? ""
            : ` — about ${count(Math.round(verdict.incrementalConversions))} extra`}
          .
        </p>
      </div>

      {verdict.interval ? (
        <p className="text-sm text-muted-foreground">
          95% confidence interval {rate(verdict.interval.low)} to{" "}
          {rate(verdict.interval.high)} (p = {verdict.pValue.toFixed(3)}).
        </p>
      ) : null}

      {/* An interval that includes zero means "possibly nothing". Saying so is
          the difference between a result and a story. */}
      {verdict.spansZero ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          The confidence interval includes zero, so this campaign may have
          caused no additional conversions at all. Treat the figure above as
          directional, not as a result.
        </p>
      ) : null}
    </div>
  );
}

function Arms({ lift }: { lift: HoldoutLift }) {
  if (lift.held_out_subs === undefined || lift.sent_subs === undefined) {
    return null;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-md border border-border p-3">
        <div className="text-sm font-medium">Sent</div>
        <div className="text-lg font-semibold tabular-nums">
          {count(lift.sent_subs)}
        </div>
        <p className="text-xs text-muted-foreground">
          {rate(lift.sent_click_rate ?? 0)} converted
        </p>
      </div>
      <div className="rounded-md border border-border p-3">
        <div className="text-sm font-medium">Held out</div>
        <div className="text-lg font-semibold tabular-nums">
          {count(lift.held_out_subs)}
        </div>
        <p className="text-xs text-muted-foreground">
          {rate(lift.held_out_click_rate ?? 0)} converted anyway
        </p>
      </div>
    </div>
  );
}

function Setup({ holdout }: { holdout: Holdout }) {
  const readiness = holdoutReadiness(holdout);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">{holdout.percent}% held out</Badge>
        <Badge variant="secondary">outcome: {holdout.outcome_metric}</Badge>
        <Badge variant="secondary">
          {holdout.conversion_window_days}-day window
        </Badge>
        {holdout.assignment_ledger_sha256 ? (
          <Badge variant="outline">
            ledger {holdout.assignment_ledger_sha256.slice(0, 8)}
          </Badge>
        ) : null}
      </div>
      {readiness.notes.map((note) => (
        <p key={note} className="text-sm text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

// The setup form. Only reachable before the campaign is sent: once the
// audience is decided the assignment ledger is frozen, and changing the split
// afterwards would silently invalidate the comparison it exists to support.
function CreateHoldoutForm({
  campaignId,
  identity,
  onCreated,
}: {
  campaignId: string;
  identity: MeResponse | null | undefined;
  onCreated: () => void;
}) {
  const [percent, setPercent] = useState("10");
  const [windowDays, setWindowDays] = useState("7");
  const [effect, setEffect] = useState("5");

  const input = {
    percent: Number(percent),
    conversionWindowDays: Number(windowDays),
    // Entered as a percentage, sent as a fraction.
    minimumRelativeEffect: Number(effect) / 100,
  };
  const problems = validateHoldoutInput(input);

  const create = useMutation({
    mutationFn: async () => {
      await confirmFreshCampaignAdminAuthority(identity);
      return createHoldout(campaignId, input);
    },
    onSuccess: () => {
      toast.success("Holdout set up. It freezes when the campaign is sent.");
      onCreated();
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "The holdout could not be created.",
      );
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (problems.length === 0) create.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="holdout-percent">Hold back</Label>
          <div className="flex items-center gap-2">
            <Input
              id="holdout-percent"
              inputMode="decimal"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
          <p className="text-xs text-muted-foreground">
            These recipients get nothing, so the rest can be compared to them.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="holdout-window">Conversion window</Label>
          <div className="flex items-center gap-2">
            <Input
              id="holdout-window"
              inputMode="numeric"
              value={windowDays}
              onChange={(e) => setWindowDays(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
          <p className="text-xs text-muted-foreground">
            How long after the send a conversion still counts as caused by it.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="holdout-effect">
            Smallest effect worth detecting
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="holdout-effect"
              inputMode="decimal"
              value={effect}
              onChange={(e) => setEffect(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Anything smaller will be reported as underpowered rather than as a
            number.
          </p>
        </div>
      </div>

      {problems.map((problem) => (
        <p key={problem} role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ))}

      <Button type="submit" disabled={problems.length > 0 || create.isPending}>
        {create.isPending ? "Setting up…" : "Set up holdout"}
      </Button>
    </form>
  );
}

export function HoldoutLiftPanel({
  campaignId,
  tenantId,
  role,
  canConfigure = false,
  identity,
}: {
  campaignId: string;
  tenantId: string;
  role: string | null;
  canConfigure?: boolean;
  identity: MeResponse | null | undefined;
}) {
  const authorizedToConfigure = canConfigure && canAdminCampaigns(identity);
  const holdout = useQuery({
    queryKey: [...base("holdout", tenantId, role), campaignId],
    queryFn: () => getHoldout(campaignId),
    staleTime: STALE.dashboard,
    // A campaign without a holdout is the normal case, not an error.
    retry: false,
  });

  const lift = useQuery({
    queryKey: [...base("holdout-lift", tenantId, role), campaignId],
    queryFn: () => getHoldoutLift(campaignId),
    enabled: holdout.isSuccess,
    staleTime: STALE.dashboard,
    retry: false,
  });

  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      await confirmFreshCampaignAdminAuthority(identity);
      return deleteHoldout(campaignId);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: base("holdout", tenantId, role),
        }),
        queryClient.invalidateQueries({
          queryKey: base("holdout-lift", tenantId, role),
        }),
      ]);
      toast.success("Unsent holdout removed.");
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "The holdout could not be removed.",
      );
    },
  });
  const noHoldout =
    (holdout.isError &&
      isApiError(holdout.error) &&
      holdout.error.status === 404) ||
    (holdout.isSuccess && !holdout.data);

  // No holdout configured. Workspace admins get the setup form; everyone else sees
  // nothing rather than an empty measurement card, which would imply a result
  // exists and is zero.
  if (noHoldout) {
    if (!authorizedToConfigure) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Measure what this campaign causes</CardTitle>
          <CardDescription>
            Hold a random slice of the audience back and send them nothing. The
            difference between the two groups is the campaign&apos;s real effect
            — every other number here only shows what happened after it. Set
            this up before sending; once the audience is decided the split is
            frozen.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateHoldoutForm
            campaignId={campaignId}
            identity={identity}
            onCreated={() => {
              void queryClient.invalidateQueries({
                queryKey: base("holdout", tenantId, role),
              });
            }}
          />
        </CardContent>
      </Card>
    );
  }

  if (holdout.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Incremental lift</CardTitle>
          <CardDescription>
            The campaign&apos;s holdout configuration could not be loaded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p role="alert" className="text-sm text-destructive">
            No comparison was made. This is not a result of zero. Try again when
            the measurement service is available.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Incremental lift</CardTitle>
        <CardDescription>
          A random slice of the audience was deliberately not sent this
          campaign. The difference between the two groups is what the campaign
          caused — every other figure on this page only shows what happened
          after it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {holdout.isPending ? (
          <Skeleton className="h-24 w-full" aria-busy="true" />
        ) : holdout.data ? (
          <div className="space-y-4">
            <Setup holdout={holdout.data} />
            {authorizedToConfigure && !holdout.data.decided_at ? (
              <ConfirmDialog
                title="Remove this unsent holdout?"
                description="This removes the draft experiment settings before any audience is assigned. It cannot be used after a send: decided holdouts and their assignment evidence are permanently locked."
                confirmLabel="Remove holdout"
                onConfirm={() => remove.mutateAsync()}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    className="text-destructive hover:text-destructive"
                  >
                    Remove unsent holdout
                  </Button>
                }
              />
            ) : null}
          </div>
        ) : null}

        {lift.isPending && holdout.isSuccess ? (
          <Skeleton className="h-20 w-full" aria-busy="true" />
        ) : lift.isError ? (
          <p role="alert" className="text-sm text-destructive">
            The lift comparison could not be loaded. This is not a result of
            zero — no comparison was made.
          </p>
        ) : lift.data ? (
          <>
            <Verdict lift={lift.data} />
            <Arms lift={lift.data} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
