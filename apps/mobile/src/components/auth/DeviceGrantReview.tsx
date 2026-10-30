/**
 * Authoritative disclosure for a device-authorization request.
 *
 * Every value comes from the server lookup keyed by the short user code. QR
 * query parameters are intentionally ignored: they are attacker-editable and
 * must never decide whether the user thinks they are approving a session or a
 * durable API key.
 */
import { ActivityIndicator, Text, View } from "react-native";

import type { DeviceApproveResult } from "@/api/deviceApprove";
import { CliScopeList } from "@/components/auth/CliScopeList";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function DeviceGrantReview({
  loading,
  preview,
}: {
  loading: boolean;
  preview: DeviceApproveResult | null;
}) {
  const { t } = useTheme();
  const disclosedEmail = preview?.account?.email;
  const disclosedWorkspace = preview?.account?.workspace_name;

  if (loading) {
    return (
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Checking device request"
        style={{
          minHeight: 88,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }
  if (!preview?.ok || !preview.grantKind) return null;

  if (preview.grantKind === "api_key") {
    return (
      <>
        <DeviceIdentityCard preview={preview} />
        <AccountContext
          accountEmail={disclosedEmail}
          workspaceName={disclosedWorkspace}
        />
        <CliScopeList
          scopes={preview.scopes ?? []}
          title="This will grant"
          emptyCopy="Your workspace role cannot authorize a CLI device. Ask an admin to approve it instead."
        />
      </>
    );
  }

  return (
    <>
      <DeviceIdentityCard preview={preview} />
      <AccountContext
        accountEmail={disclosedEmail}
        workspaceName={disclosedWorkspace}
      />
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          gap: 7,
        }}
        accessible
        accessibilityLabel="This approves a Moosewave sign-in on the other device. No password or existing session cookie is shared."
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          This will allow
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Sign in to your current Moosewave account and workspace on that device.
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {preview.remember
            ? "The device requested a persistent session. You can revoke it later from Active devices."
            : "The new session ends when its app or browser session closes and expires server-side within 12 hours."}
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Your password and this phone&apos;s session cookie are never
          transferred. Workspace policy may still require two-factor
          verification there.
        </Text>
      </View>
    </>
  );
}

function AccountContext({
  accountEmail,
  workspaceName,
}: {
  accountEmail?: string | undefined;
  workspaceName?: string | undefined;
}) {
  const { t } = useTheme();
  if (!accountEmail && !workspaceName) return null;

  return (
    <View
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 4,
      }}
      accessible
      accessibilityLabel={`Approving as ${accountEmail ?? "your current account"}${workspaceName ? ` in ${workspaceName}` : ""}`}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.medium,
        }}
      >
        APPROVING AS
      </Text>
      {accountEmail ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          {accountEmail}
        </Text>
      ) : null}
      {workspaceName ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {workspaceName}
        </Text>
      ) : null}
    </View>
  );
}

function DeviceIdentityCard({ preview }: { preview: DeviceApproveResult }) {
  const { t } = useTheme();
  const label = preview.device?.device_label ?? "Unknown device";
  const remaining = Math.max(0, Math.ceil((preview.expiresIn ?? 0) / 60));
  return (
    <View
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 4,
      }}
      accessible
      accessibilityLabel={`Reported requesting device: ${label}. Device details are self-reported; approve only if you started the matching code.`}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.medium,
        }}
      >
        REPORTED REQUESTING DEVICE
      </Text>
      <Text
        {...typeCap("body")}
        style={{ color: t.fg, ...typeStyle("body"), fontFamily: FONT.semibold }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Device details are self-reported. Trust the matching code and approve
        only if you started this request.
      </Text>
      {remaining > 0 ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {`Request expires in about ${remaining} minute${remaining === 1 ? "" : "s"}.`}
        </Text>
      ) : null}
    </View>
  );
}
