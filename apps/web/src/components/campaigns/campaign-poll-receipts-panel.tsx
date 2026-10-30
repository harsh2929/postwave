// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listCampaignPollReceipts,
  materializeCurrentCampaignPolls,
  type CampaignPollReceipt,
} from "@/lib/campaign-polls-api";
import { apiErrorMessage } from "@/lib/api";
import { base, STALE } from "@/lib/query-keys";
import type { MeResponse } from "@/lib/auth-api";
import {
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";

export function CampaignPollReceiptsPanel({
  campaignId,
  tenantId,
  role,
  hasSemanticPoll,
  canConfigure,
  configurationBlockedReason,
  identity,
}: {
  campaignId: string;
  tenantId: string;
  role: string | null;
  hasSemanticPoll: boolean;
  canConfigure: boolean;
  configurationBlockedReason?: string | undefined;
  identity: MeResponse | null | undefined;
}) {
  const authorizedToConfigure = canConfigure && canWriteCampaigns(identity);
  const client = useQueryClient();
  const queryKey = [
    ...base("campaign-poll-receipts", tenantId, role),
    campaignId,
  ] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => listCampaignPollReceipts(campaignId),
    staleTime: STALE.dashboard,
    retry: false,
  });
  const materialize = useMutation({
    mutationFn: () =>
      materializeCurrentCampaignPolls(campaignId, {
        beforeWrite: () => confirmFreshCampaignWriteAuthority(identity),
      }),
    onSuccess: async (receipt) => {
      await client.invalidateQueries({ queryKey, exact: true });
      toast.success(
        `${receipt.definitions.length} two-step poll contract${receipt.definitions.length === 1 ? "" : "s"} materialized from frozen revision ${receipt.revision.revisionId}.`,
      );
    },
    onError: async () => {
      // A multi-poll revision can partially materialize before a later key
      // conflicts. Refresh even on failure so completed immutable receipts do
      // not stay hidden behind the operation error.
      await client.invalidateQueries({ queryKey, exact: true });
    },
  });
  const receipts = Array.isArray(query.data) ? query.data : [];

  if (
    !query.isPending &&
    !query.isError &&
    receipts.length === 0 &&
    !hasSemanticPoll
  ) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Poll confirmation receipts</CardTitle>
          <Badge variant="outline">Observed outcomes</Badge>
        </div>
        <CardDescription>
          Confirmed poll results bound to an exact immutable campaign revision.
          Each receipt states whether two-step confirmation was required. These
          are observed outcomes, not predicted engagement.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {authorizedToConfigure && hasSemanticPoll ? (
          <div className="space-y-2 rounded-md border p-3 text-sm text-muted-foreground">
            <p>
              Freeze the currently saved semantic v2 draft, then materialize
              every poll key read back from that exact immutable revision.
              Question and option content stays server-owned; every new contract
              requires scanner-safe two-step confirmation. Repeating this action
              verifies or reuses the same revision contract.
            </p>
            <Button
              type="button"
              size="sm"
              disabled={materialize.isPending}
              loading={materialize.isPending}
              onClick={() => materialize.mutate()}
            >
              {materialize.isPending
                ? "Freezing and materializing…"
                : "Freeze current revision and materialize polls"}
            </Button>
          </div>
        ) : null}
        {materialize.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {apiErrorMessage(
              materialize.error,
              "The immutable poll contract could not be materialized.",
            )}
          </p>
        ) : null}
        {query.isPending ? (
          <Skeleton className="h-24 w-full" aria-busy="true" />
        ) : query.isError ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-destructive">
              Poll receipts could not be verified. This is unknown, not zero
              responses.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void query.refetch()}
            >
              Retry receipt verification
            </Button>
          </div>
        ) : receipts.length === 0 ? (
          <div className="rounded-md border p-3 text-sm text-muted-foreground">
            <p>No immutable poll response contract has been materialized.</p>
          </div>
        ) : (
          receipts.map((receipt) => (
            <PollReceipt key={receipt.definition.id} receipt={receipt} />
          ))
        )}
        {hasSemanticPoll &&
        !authorizedToConfigure &&
        configurationBlockedReason ? (
          <p className="rounded-md border p-3 text-sm text-muted-foreground">
            {configurationBlockedReason}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PollReceipt({ receipt }: { receipt: CampaignPollReceipt }) {
  const { definition, tally } = receipt;
  const counted = tally.options.reduce(
    (total, option) => total + option.counted,
    0,
  );
  const excluded =
    tally.machineExcluded +
    tally.unclassifiedExcluded +
    tally.voidedMultiOption +
    tally.supersededChoices +
    tally.previewedOnly;

  return (
    <article className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{definition.question}</h3>
          <p className="text-xs text-muted-foreground">
            Poll <code>{definition.pollKey}</code> · created{" "}
            {new Date(definition.createdAt).toLocaleString()}
          </p>
        </div>
        <Badge variant={definition.twoStepRequired ? "secondary" : "warning"}>
          {definition.twoStepRequired
            ? "Two-step confirmation"
            : "Single-step — scanner safety not assured"}
        </Badge>
      </div>

      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        {tally.options.map((option) => (
          <div key={option.optionKey}>
            <dt className="text-muted-foreground">{option.label}</dt>
            <dd className="font-medium">{option.counted} counted human</dd>
          </div>
        ))}
        <ReceiptField
          label="Counted human confirmations"
          value={String(counted)}
        />
        <ReceiptField label="Excluded confirmations" value={String(excluded)} />
        <ReceiptField
          label="Machine excluded"
          value={String(tally.machineExcluded)}
        />
        <ReceiptField
          label="Unclassified excluded"
          value={String(tally.unclassifiedExcluded)}
        />
        <ReceiptField
          label="Multi-option voided"
          value={String(tally.voidedMultiOption)}
        />
        <ReceiptField
          label="Superseded choices"
          value={String(tally.supersededChoices)}
        />
        <ReceiptField
          label="Preview-only legacy"
          value={String(tally.previewedOnly)}
        />
        <ReceiptField
          label="Immutable submission receipts"
          value={String(tally.submissionReceipts)}
        />
      </dl>

      <p className="rounded border bg-muted/20 p-2 text-xs text-muted-foreground">
        Only explicit human classifications enter the option counts. Machine,
        unknown, multi-option, superseded, and preview-only evidence stays
        visible and excluded; a missing classifier never defaults to human.
      </p>

      <details className="text-xs">
        <summary className="cursor-pointer font-medium">
          Immutable provenance
        </summary>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          <ReceiptField
            label="Frozen revision"
            value={definition.contentRevisionId}
            mono
          />
          <ReceiptField
            label="Revision source hash"
            value={definition.contentRevisionSourceHash}
            mono
          />
          <ReceiptField
            label="Poll contract SHA-256"
            value={definition.pollContractSha256}
            mono
          />
          <ReceiptField
            label="Closes"
            value={
              definition.closesAt
                ? new Date(definition.closesAt).toLocaleString()
                : "No closing time recorded"
            }
          />
        </dl>
      </details>
    </article>
  );
}

function ReceiptField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`${mono ? "break-all font-mono text-[10px]" : ""} m-0`}>
        {value}
      </dd>
    </div>
  );
}
