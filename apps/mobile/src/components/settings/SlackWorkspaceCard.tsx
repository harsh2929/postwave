/**
 * SlackWorkspaceCard — "is the Slack approval bot connected, and to what?"
 *
 * SHELL#24. Desktop has had `<SlackIntegrationSection />` in Settings since the
 * approval bot shipped; mobile had nothing, and the Integrations tab's empty
 * state told you to go to the web admin. This is the monitor half of that
 * section, plus the one verb a phone should genuinely own.
 *
 * WHAT SHIPS
 *   read     GET /api/v1/integrations/slack-workspace   → team, channel, since
 *   revoke   DELETE /api/v1/integrations/slack-workspace
 *   probe    GET /api/v1/integrations/slack/availability → is Slack configured
 *
 * WHAT DOES NOT, AND WHY IT IS A LINK RATHER THAN A BUTTON. Connecting a
 * workspace is an OAuth INSTALL GRANT: `GET /api/v1/slack/oauth/start`
 * (collaboration_integrations.go:44) is admin-scoped and answers 302 to
 * slack.com, and the callback's success redirect is a deployment-level env
 * value that `safeOAuthSuccessRedirect` (slackint/oauth.go:299) restricts to
 * https — a `moosewave://` return is rejected, so `openAuthSessionAsync` could
 * never regain control. Mobile's credentials do not travel either: the client
 * uses an apiKey header or `credentials: "include"` on RN's fetch
 * (sdkClient.ts:206-216), neither of which reaches the system browser's cookie
 * jar. The API says so itself in AvailabilityHandler's comment, and describes
 * desktop's answer — hand the operator to the dashboard in a browser. A
 * "Connect Slack" button here would open a sheet that 401s, so this card says
 * what has to happen instead and links out.
 *
 * DISCONNECT IS OFFERED BECAUSE IT WORKS. Revoking a workspace grant from a
 * phone is a real security action; it is a plain DELETE against a route mobile
 * can authenticate, and it is confirmed with the workspace name so it cannot be
 * a mis-tap.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Linking, Text, View } from "react-native";

import {
  disconnectSlackWorkspace,
  getSlackAvailability,
  getSlackWorkspaceConnection,
} from "@/api/workspaceSetup";
import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { Card, Row } from "@/components/settings/SettingsScreenPrimitives";
import { SetupActionButton } from "@/components/settings/SetupActionButton";
import { SkeletonList } from "@/components/Skeleton";
import { TextLink } from "@/components/TextLink";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { PUBLIC_APP_BASE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  NO_VALUE,
  slackConnectAvailability,
  slackConnectMessage,
  slackConnectionSummary,
} from "@/lib/workspaceSetup";

// PUBLIC_APP_BASE_URL is normalised where it is defined (https-or-dev-http, no
// credentials, no trailing slash), so appending a fixed path is safe to open.
const WEB_INTEGRATIONS_URL = `${PUBLIC_APP_BASE_URL}/app/settings/integrations`;

export function SlackWorkspaceCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [disconnecting, setDisconnecting] = useState(false);

  const connection = useQuery({
    queryKey: ["slack-workspace-connection", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async () => {
      const res = await getSlackWorkspaceConnection();
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return slackConnectionSummary(res.data);
    },
    staleTime: 60_000,
  });

  const availability = useQuery({
    queryKey: ["slack-availability", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async () => {
      const res = await getSlackAvailability();
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return res.data;
    },
    staleTime: 300_000,
  });

  const summary = connection.data;
  const connectState = slackConnectAvailability({
    connected: Boolean(summary?.connected),
    availability: availability.data,
    availabilityFailed: availability.isError,
  });

  async function onDisconnect(): Promise<void> {
    const name = summary?.workspace ?? "this Slack workspace";
    const ok = await confirm({
      title: "Disconnect Slack?",
      message: `Moosewave will stop posting approval requests to ${name}. Reconnecting needs a browser session on the web admin.`,
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    setDisconnecting(true);
    const res = await disconnectSlackWorkspace();
    setDisconnecting(false);
    if (res.error) {
      haptics.error();
      toast({ message: res.error.message, kind: "error" });
      return;
    }
    haptics.success();
    toast({ message: "Slack workspace disconnected.", kind: "success" });
    await queryClient.invalidateQueries({
      queryKey: ["slack-workspace-connection"],
    });
  }

  return (
    <Card>
      <QueryStates
        query={connection}
        gate={gate}
        isEmpty={!summary}
        skeleton={<SkeletonList rows={2} />}
        offlineMessage="You're offline, so the Slack connection hasn't been read yet."
      >
        {summary ? (
          <View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <Pill
                label={summary.connected ? "Connected" : "Not connected"}
                tone={summary.connected ? "success" : "neutral"}
              />
            </View>

            {summary.connected ? (
              <>
                <Row label="Workspace" value={summary.workspace ?? NO_VALUE} />
                {/* No default channel is a real state — the bot posts wherever
                    it is invited. An em-dash, never "#". */}
                <Row label="Default channel" value={summary.channel ?? NO_VALUE} />
                <Row
                  label="Connected"
                  value={
                    summary.connectedAt
                      ? relativeTime(summary.connectedAt)
                      : NO_VALUE
                  }
                />
              </>
            ) : null}

            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 10,
              }}
            >
              {slackConnectMessage(connectState)}
            </Text>

            {summary.connected ? (
              <View style={{ marginTop: 12 }}>
                <SetupActionButton
                  label="Disconnect workspace"
                  busyLabel="Disconnecting…"
                  busy={disconnecting}
                  disabled={!gate.enabled}
                  tone="danger"
                  accessibilityHint="Revokes the Slack grant. Approval requests stop posting to Slack."
                  onPress={() => void onDisconnect()}
                  testID="slack-workspace-disconnect"
                />
              </View>
            ) : (
              <TextLink
                onPress={() => void Linking.openURL(WEB_INTEGRATIONS_URL)}
                accessibilityLabel="Connect Slack on the web admin"
                textStyle={{
                  color: t.accent,
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                Open the web admin
              </TextLink>
            )}
          </View>
        ) : null}
      </QueryStates>
    </Card>
  );
}
