/**
 * Approval surface for cross-device sessions and legacy CLI API-key grants.
 * The controller keeps the inspect proof in mounted memory; this route only
 * renders the server disclosure and explicit approve/deny actions.
 */
import { router, useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CliApprovedView } from "@/components/auth/CliApprovedView";
import { CliDeviceCodeField } from "@/components/auth/CliDeviceCodeField";
import { DeviceGrantReview } from "@/components/auth/DeviceGrantReview";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useCliDeviceApproval } from "@/hooks/useCliDeviceApproval";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { liveRegionProps } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { goBackOr } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/** cliDeviceTTL in apps/api/internal/auth/cli_device_auth.go. */
const GRANT_TTL_MINUTES = 10;

type ApprovalController = ReturnType<typeof useCliDeviceApproval>;

export default function CliApproveScreen() {
  useScreenViewed("cli-approve");
  const params = useLocalSearchParams<{ user_code?: string }>();
  const scannedCode =
    typeof params.user_code === "string" ? params.user_code : "";
  const baseUrl = useAuthStore((state) => state.baseUrl);
  const approval = useCliDeviceApproval({ baseUrl, scannedCode });

  function goBack(): void {
    goBackOr("/(tabs)/dashboard");
  }

  function stepUp(): void {
    router.push({
      pathname: "/(auth)/totp",
      params: { purpose: "security_settings" },
    });
  }

  if (approval.approved?.ok) {
    const approvedKind =
      approval.approved.grantKind ?? approval.preview?.grantKind;
    const approvedDevice = approval.approved.device ?? approval.preview?.device;
    return (
      <CliApprovedView
        scopes={approval.approved.scopes ?? []}
        {...(approvedKind ? { grantKind: approvedKind } : {})}
        {...(approvedDevice ? { device: approvedDevice } : {})}
        onDone={goBack}
      />
    );
  }

  return (
    <ApprovalForm
      approval={approval}
      scanned={Boolean(scannedCode)}
      onBack={goBack}
      onStepUp={stepUp}
    />
  );
}

function ApprovalForm({
  approval,
  scanned,
  onBack,
  onStepUp,
}: {
  approval: ApprovalController;
  scanned: boolean;
  onBack: () => void;
  onStepUp: () => void;
}) {
  const { t } = useTheme();
  const {
    changeTypedCode,
    code,
    inspecting,
    needsStepUp,
    preview,
    typedCode,
    valid,
  } = approval;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={
          preview?.grantKind === "session"
            ? "Approve sign-in"
            : "Approve device"
        }
        onBack={onBack}
      />
      <ScrollView
        contentContainerStyle={{ padding: 20, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("body"),
          }}
        >
          {approvalIntro(preview)}
        </Text>

        <CliDeviceCodeField
          scanned={scanned}
          code={code}
          valid={valid}
          typedCode={typedCode}
          onChangeTypedCode={changeTypedCode}
        />

        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {`Codes expire within ${GRANT_TTL_MINUTES} minutes. If this one is stale, restart sign-in on the other device.`}
        </Text>

        <DeviceGrantReview loading={inspecting} preview={preview} />
        {needsStepUp ? <MfaStepUp onPress={onStepUp} /> : null}
        <ApprovalMessages approval={approval} />
        <ApprovalActions approval={approval} onDone={onBack} />
      </ScrollView>
    </SafeAreaView>
  );
}

function approvalIntro(preview: ApprovalController["preview"]): string {
  switch (preview?.grantKind) {
    case "session":
      return "Another device is asking to sign in to your Moosewave account. Compare the code, review the device, then approve only if you started this request.";
    case "api_key":
      return "A device is asking for a Moosewave API key for your workspace. Only approve it if you started this request yourself.";
    default:
      return "Compare the code and wait while Moosewave verifies what the other device is requesting.";
  }
}

function MfaStepUp({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: t.warning,
        backgroundColor: `${t.warning}14`,
        borderRadius: 12,
        padding: 12,
        gap: 8,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        This request needs two-factor verification before it can be approved.
      </Text>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Verify with two-factor now"
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Verify now
        </Text>
      </Pressable>
    </View>
  );
}

function ApprovalMessages({ approval }: { approval: ApprovalController }) {
  const { t } = useTheme();
  const { denied, error, scannedInvalid } = approval;
  return (
    <>
      {error ? (
        <Text
          {...liveRegionProps()}
          testID="cli-approve-error"
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {error}
        </Text>
      ) : null}
      {scannedInvalid ? (
        <Text
          {...liveRegionProps()}
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          That code isn&apos;t in the right format. Run the command again and
          scan the new code.
        </Text>
      ) : null}
      {denied ? (
        <Text
          {...liveRegionProps()}
          testID="device-request-denied"
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
          }}
        >
          Request denied. The other device cannot use this code.
        </Text>
      ) : null}
    </>
  );
}

function ApprovalActions({
  approval,
  onDone,
}: {
  approval: ApprovalController;
  onDone: () => void;
}) {
  const { t } = useTheme();
  const {
    approve,
    busy,
    denied,
    deny,
    inspecting,
    needsStepUp,
    preview,
    requestReady,
    roleCanGrant,
    valid,
  } = approval;
  const approveEnabled =
    valid &&
    !busy &&
    !inspecting &&
    requestReady &&
    roleCanGrant &&
    !needsStepUp &&
    !denied;
  const denyAvailable = requestReady && !denied;
  const sessionGrant = preview?.grantKind === "session";
  return (
    <>
      <Pressable
        onPress={() => void approve()}
        disabled={!approveEnabled}
        accessibilityRole="button"
        accessibilityLabel={
          sessionGrant ? "Approve sign-in" : "Authorize this device"
        }
        accessibilityHint={
          sessionGrant
            ? "Signs your account in on the requesting device."
            : "Grants the permissions listed above."
        }
        accessibilityState={{ disabled: !approveEnabled, busy }}
        testID="cli-approve-submit"
        style={{
          backgroundColor: approveEnabled ? t.accent : t.border,
          borderRadius: 12,
          paddingVertical: 16,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator color={t.accentFg} />
        ) : (
          <Text
            {...typeCap("body")}
            style={{
              color: approveEnabled ? t.accentFg : t.fgMuted,
              fontFamily: FONT.semibold,
              ...typeStyle("body"),
            }}
          >
            {sessionGrant ? "Approve sign-in" : "Authorize device"}
          </Text>
        )}
      </Pressable>
      <Pressable
        onPress={denyAvailable ? () => void deny() : onDone}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={denyAvailable ? "Deny request" : "Done"}
        style={{
          paddingVertical: 12,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.medium,
            ...typeStyle("body"),
          }}
        >
          {denyAvailable ? "Deny request" : "Done"}
        </Text>
      </Pressable>
    </>
  );
}
