// SPDX-License-Identifier: AGPL-3.0-only
//
// Integrations settings — the Slack workspace-OAuth connection, plus a link to
// the full integrations hub (Slack, Discord, Teams, CRM lifecycle, write-back,
// and the connector catalog) so this tab isn't a dead end (SETA-011). The Slack
// section loads the linked workspace + channel through the shared query cache,
// starts the OAuth install on Connect, and revokes via the disconnect endpoint.
// Backend: apps/api/internal/slackint/{oauth,handlers}.go.
"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import {
  SLACK_OAUTH_START_PATH,
  slackWorkspaceApi,
  type SlackWorkspaceStatus,
} from "@/lib/integrations-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

interface SlackWorkspaceSettingsData {
  configured: boolean;
  status: SlackWorkspaceStatus;
}

async function loadSlackWorkspaceSettings(): Promise<SlackWorkspaceSettingsData> {
  const [availability, status] = await Promise.all([
    slackWorkspaceApi.availability(),
    slackWorkspaceApi.status(),
  ]);
  return {
    configured: availability.configured,
    status,
  };
}

export default function IntegrationsSettingsPage() {
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState(false);
  const operationRef = useRef(false);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.viewer_mode
    ? "viewer"
    : meQuery.data
      ? effectiveAuthRole(meQuery.data)
      : null;
  const canAdmin = Boolean(
    meQuery.data && !meQuery.data.viewer_mode && roleCanWrite(role),
  );
  const slackWorkspaceKey = useMemo(
    () => qk.settings(tenantId, role, "slack-workspace"),
    [role, tenantId],
  );
  const slackWorkspaceQuery = useQuery({
    queryKey: slackWorkspaceKey,
    queryFn: loadSlackWorkspaceSettings,
    enabled: meQuery.isFetched && canAdmin,
    staleTime: STALE.detail,
  });

  const status = slackWorkspaceQuery.data?.status ?? null;
  // Unknown availability fails closed. The explicit query-error branch below
  // offers Retry instead of guessing that OAuth credentials are configured.
  const configured = slackWorkspaceQuery.data?.configured === true;
  const loading =
    meQuery.isLoading ||
    (canAdmin && slackWorkspaceQuery.isPending && !slackWorkspaceQuery.data);
  const loadError =
    canAdmin && slackWorkspaceQuery.isError
      ? errorMessage(
          slackWorkspaceQuery.error,
          "Could not load your Slack connection — this is a failed request, not a workspace without one.",
        )
      : null;

  const invalidateSlackWorkspace = (): Promise<void> =>
    queryClient
      .invalidateQueries({
        queryKey: slackWorkspaceKey,
        exact: false,
      })
      .then(() => undefined);

  const onConnect = async () => {
    if (!canAdmin || !meQuery.data || operationRef.current) return;
    // The OAuth start route is a session-cookie 302 redirect to Slack, so
    // we navigate the browser to it rather than fetching it. After the
    // install completes Slack redirects back and the next mount reflects
    // the connection.
    if (!configured) {
      toast.error(
        "Slack isn't configured for this Moosewave deployment yet (no Slack app credentials).",
      );
      return;
    }
    operationRef.current = true;
    try {
      await verifyFreshAdminAuthority(meQuery.data);
      window.location.assign(SLACK_OAUTH_START_PATH);
    } catch (error) {
      toast.error(errorMessage(error, "Could not start the Slack connection."));
      operationRef.current = false;
    }
  };

  const onDisconnect = async () => {
    if (!canAdmin || !meQuery.data || operationRef.current) return;
    operationRef.current = true;
    setDisconnecting(true);
    try {
      await verifyFreshAdminAuthority(meQuery.data);
      await slackWorkspaceApi.disconnect();
      queryClient.setQueryData<SlackWorkspaceSettingsData>(
        slackWorkspaceKey,
        (cur) => ({
          configured: cur?.configured ?? configured,
          status: { connected: false },
        }),
      );
      toast.success("Disconnected from Slack.");
      void invalidateSlackWorkspace();
    } catch (e) {
      toast.error(errorMessage(e, "Could not disconnect from Slack."));
      throw e;
    } finally {
      operationRef.current = false;
      setDisconnecting(false);
    }
  };

  const connected = status?.connected === true;
  // Prefer the real linked channel name from the server; fall back to the
  // workspace name (some installs grant chat:write without a default
  // channel) and finally a neutral label.
  const channelLabel = status?.default_channel_name
    ? `#${status.default_channel_name.replace(/^#/, "")}`
    : status?.slack_team_name
      ? status.slack_team_name
      : "your workspace";

  return (
    <div className="space-y-6 max-w-3xl">
      <header>
        {/* h2 (not h1): SettingsLayout already renders the page's single h1. */}
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Integrations
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect Moosewave to the tools your team already uses — Slack, Discord,
          Teams, and dozens more in the catalog.
        </p>
      </header>

      <Card data-testid="slack-section">
        <CardHeader>
          <CardTitle>Slack</CardTitle>
          <CardDescription>
            Get notified in Slack when a campaign sends, a webhook delivery
            fails, or a tenant-wide bounce spike happens.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            // Loading state: skeleton placeholder while we fetch the
            // connection so the control doesn't flash the wrong state.
            <div
              className="h-9 w-40 animate-pulse rounded-md bg-muted"
              aria-hidden="true"
            />
          ) : meQuery.isError || (meQuery.isFetched && !meQuery.data) ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
            >
              <span>
                {errorMessage(
                  meQuery.error,
                  "Could not verify your Slack administration access.",
                )}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => void meQuery.refetch()}
              >
                Retry access check
              </Button>
            </div>
          ) : meQuery.data && !canAdmin ? (
            <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              Slack workspace connections are read-only for this session. An
              owner or admin outside viewer mode must connect or disconnect
              Slack.
            </p>
          ) : loadError ? (
            // Load failed: surface the error inline with a retry rather than
            // silently rendering a (possibly wrong) Connect button.
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
            >
              <span>{loadError}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => void slackWorkspaceQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : connected ? (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                Connected to <strong>{channelLabel}</strong>
              </span>
              <ConfirmDialog
                title="Disconnect Slack?"
                description="Moosewave will stop posting to this workspace. You can reconnect at any time by re-authorizing."
                confirmLabel="Disconnect"
                confirmVariant="destructive"
                onConfirm={onDisconnect}
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disconnecting}
                  >
                    {disconnecting ? "Disconnecting…" : "Disconnect"}
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Button
                type="button"
                onClick={() => void onConnect()}
                disabled={!configured}
                title={
                  configured
                    ? undefined
                    : "Slack is not configured for this Moosewave deployment yet."
                }
              >
                Connect
              </Button>
              {!configured ? (
                <p className="text-xs text-muted-foreground">
                  Slack isn&apos;t available on this Moosewave deployment yet —
                  no Slack app credentials are configured.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>More integrations</CardTitle>
          <CardDescription>
            Discord, Microsoft Teams, CRM lifecycle sync, reverse-ETL
            write-back, and the full connector catalog live in the integrations
            hub.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild type="button" variant="outline">
            <Link href="/app/integrations">
              Browse all integrations
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: { message?: string } } | undefined;
    return body?.error?.message ?? e.message ?? fallback;
  }
  return e instanceof Error ? e.message : fallback;
}
