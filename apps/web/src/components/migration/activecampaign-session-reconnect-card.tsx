// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { activeCampaignApiUrlError } from "@/lib/activecampaign-api-url";
import { customerIOWorkspaceIDError } from "@/lib/customerio-workspace-id";
import { refreshSourceSessionWithApiKey } from "@/lib/migration-api";
import type { SourceSessionStatus } from "@/lib/migration-source-session";
import { SOURCE_LABELS, type MigrationJob } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ActiveCampaignSessionReconnectCard({
  source = "activecampaign",
  jobId,
  sessionStatus,
  pending,
  onPendingChange,
  onReconnected,
  beforeWrite,
  authorityKey,
}: {
  source?:
    | "activecampaign"
    | "hubspot"
    | "beehiiv"
    | "klaviyo"
    | "customerio"
    | "brevo";
  jobId: string;
  sessionStatus: SourceSessionStatus;
  pending?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onReconnected: (job: MigrationJob) => void;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
  authorityKey: string;
}) {
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [customerIORegion, setCustomerIORegion] = useState<"" | "us" | "eu">(
    "",
  );
  const [localPending, setLocalPending] = useState(false);
  const busyRef = useRef(false);
  const operationRef = useRef<AbortController | null>(null);
  const isPending = pending ?? localPending;
  const isActiveCampaign = source === "activecampaign";
  const isBrevo = source === "brevo";
  const isBeehiiv = source === "beehiiv";
  const isKlaviyo = source === "klaviyo";
  const isCustomerIO = source === "customerio";
  const label = SOURCE_LABELS[source];
  const apiUrlError = isActiveCampaign
    ? activeCampaignApiUrlError(accountId)
    : null;
  const customerIOWorkspaceError = isCustomerIO
    ? customerIOWorkspaceIDError(accountId)
    : null;
  const accountInputId = isActiveCampaign
    ? `activecampaign-refresh-api-url-${jobId}`
    : `${source}-refresh-account-id-${jobId}`;
  const accountHelpId = isActiveCampaign
    ? `activecampaign-refresh-api-url-help-${jobId}`
    : `${source}-refresh-account-id-help-${jobId}`;
  const tokenInputId = isActiveCampaign
    ? `activecampaign-refresh-api-token-${jobId}`
    : `${source}-refresh-api-token-${jobId}`;
  const canSubmit =
    apiKey.trim() !== "" &&
    (!isActiveCampaign || apiUrlError === null) &&
    (!isCustomerIO || customerIOWorkspaceError === null) &&
    !isPending;

  const setPending = (next: boolean) => {
    if (pending === undefined) setLocalPending(next);
    onPendingChange?.(next);
  };

  useEffect(() => {
    // Credential inputs belong to one authority scope and must never survive
    // a same-route principal/tenant transition.
    setApiKey("");
    setAccountId("");
    setCustomerIORegion("");
    setLocalPending(false);
    return () => {
      operationRef.current?.abort();
      operationRef.current = null;
      busyRef.current = false;
    };
  }, [authorityKey]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || busyRef.current) return;
    const intent = {
      jobId,
      source,
      apiKey: apiKey.trim(),
      accountId: accountId.trim() || undefined,
      extra:
        isCustomerIO && customerIORegion
          ? { region: customerIORegion }
          : undefined,
    } as const;
    busyRef.current = true;
    const controller = new AbortController();
    operationRef.current = controller;
    setPending(true);
    try {
      await beforeWrite(controller.signal);
      controller.signal.throwIfAborted();
      const next = await refreshSourceSessionWithApiKey(
        intent.jobId,
        intent.source,
        intent.apiKey,
        intent.accountId,
        intent.extra,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setApiKey("");
      setAccountId("");
      setCustomerIORegion("");
      toast.success(`${label} source session refreshed`);
      onReconnected(next);
    } catch (err) {
      if (controller.signal.aborted) return;
      toast.error(`Could not refresh ${label} session`, {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      if (operationRef.current === controller) {
        operationRef.current = null;
        busyRef.current = false;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  };

  return (
    <Card>
      <form onSubmit={handleSubmit}>
        <CardHeader>
          <CardTitle className="text-base">Reconnect {label}</CardTitle>
          <CardDescription>{sessionStatus.message}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={accountInputId}>
              {isActiveCampaign
                ? "Account API URL"
                : isBeehiiv
                  ? "Publication ID (optional)"
                  : isKlaviyo
                    ? "Account ID (optional)"
                    : isCustomerIO
                      ? "Workspace ID (optional)"
                      : isBrevo
                        ? "Organization ID (optional)"
                        : "Hub ID (optional)"}
            </Label>
            <Input
              id={accountInputId}
              type="text"
              inputMode={
                isActiveCampaign ? "url" : isCustomerIO ? "numeric" : "text"
              }
              maxLength={isCustomerIO ? 64 : undefined}
              autoComplete="off"
              placeholder={
                isActiveCampaign
                  ? "https://youraccount.api-us1.com/api/3"
                  : isBeehiiv
                    ? "pub_00000000-0000-0000-0000-000000000000"
                    : isKlaviyo
                      ? "Klaviyo account ID"
                      : isCustomerIO
                        ? "Customer.io workspace ID"
                        : isBrevo
                          ? "Brevo organization ID"
                          : "12345678"
              }
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              aria-invalid={Boolean(
                accountId.trim() &&
                (isActiveCampaign ? apiUrlError : customerIOWorkspaceError),
              )}
              aria-describedby={accountHelpId}
              required={isActiveCampaign}
            />
            <p
              id={accountHelpId}
              className={
                accountId.trim() && (apiUrlError || customerIOWorkspaceError)
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {accountId.trim() && (apiUrlError || customerIOWorkspaceError)
                ? apiUrlError || customerIOWorkspaceError
                : isActiveCampaign
                  ? "Use the exact HTTPS account URL shown in Settings - Developer. A custom provider-issued host must be authorized by this Moosewave deployment, and reconnect must authenticate the same ActiveCampaign account already bound to this job."
                  : isBeehiiv
                    ? "Optional on reconnect because the server reuses the publication already bound to this job. If supplied, it must be that exact publication; reconnect never auto-selects another workspace publication."
                    : isKlaviyo
                      ? "Optional because the server reuses the Klaviyo account already bound to this job. If supplied, it must match the authenticated account; reconnect never switches the job to another account."
                      : isCustomerIO
                        ? "Optional because the server reuses the Customer.io workspace already bound to this job. If supplied, it must be that exact workspace; reconnect never switches workspace or region."
                        : isBrevo
                          ? "The API key must belong to the original Brevo organization. A new key cannot switch this migration to another account."
                          : "If supplied, the Hub ID must match the original portal. Your Service Key or existing private app token is checked against HubSpot account details."}
            </p>
            {isCustomerIO ? (
              <div className="space-y-2 pt-1">
                <Label htmlFor={`customerio-refresh-region-${jobId}`}>
                  App API region
                </Label>
                <select
                  id={`customerio-refresh-region-${jobId}`}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={customerIORegion}
                  onChange={(event) =>
                    setCustomerIORegion(event.target.value as "" | "us" | "eu")
                  }
                >
                  <option value="">Reuse the job&apos;s bound region</option>
                  <option value="us">United States</option>
                  <option value="eu">European Union</option>
                </select>
              </div>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor={tokenInputId}>
              {isKlaviyo
                ? "Private API key"
                : isCustomerIO
                  ? "App API key"
                  : isBeehiiv
                    ? "API key"
                    : "API token"}
            </Label>
            <Input
              id={tokenInputId}
              type="password"
              autoComplete="off"
              placeholder={
                isActiveCampaign
                  ? "ActiveCampaign API token"
                  : isBeehiiv
                    ? "Beehiiv API key"
                    : isKlaviyo
                      ? "Klaviyo private API key"
                      : isCustomerIO
                        ? "Customer.io App API key"
                        : isBrevo
                          ? "Brevo API key"
                          : "HubSpot Service Key or existing token"
              }
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              The token is validated and stored only as the encrypted source
              session for this migration job.
            </p>
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={!canSubmit}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Refresh source session
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
