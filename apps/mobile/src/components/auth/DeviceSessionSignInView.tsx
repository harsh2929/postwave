import QRCode from "react-native-qrcode-svg";
import { ScrollView, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiBaseUrlField } from "@/components/auth/ApiBaseUrlField";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import {
  DeviceSessionErrorView,
  DeviceSessionProgressView,
} from "@/components/auth/DeviceSessionSignInStatusViews";
import { SignInHeader } from "@/components/auth/SignInHeader";
import { TextLink } from "@/components/TextLink";
import type { MobileDeviceSignInState } from "@/hooks/useDeviceSessionSignIn";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function DeviceSessionSignInView({
  state,
  baseUrl,
  apiFieldExpanded,
  remember,
  baseUrlError,
  onToggleApiField,
  onChangeBaseUrl,
  onChangeRemember,
  onStart,
  onCancel,
}: {
  state: MobileDeviceSignInState;
  baseUrl: string;
  apiFieldExpanded: boolean;
  remember: boolean;
  baseUrlError: string;
  onToggleApiField: () => void;
  onChangeBaseUrl: (next: string) => void;
  onChangeRemember: (next: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const { t } = useTheme();

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.bg }}
      edges={["top", "bottom"]}
    >
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <SignInHeader
          title="Sign in with another device"
          subtitle="Approve this phone from a phone, tablet, desktop, or browser where you are already signed in."
        />

        {state.phase === "idle" ? (
          <IdleView
            baseUrl={baseUrl}
            apiFieldExpanded={apiFieldExpanded}
            remember={remember}
            baseUrlError={baseUrlError}
            onToggleApiField={onToggleApiField}
            onChangeBaseUrl={onChangeBaseUrl}
            onChangeRemember={onChangeRemember}
            onStart={onStart}
            onCancel={onCancel}
          />
        ) : state.phase === "waiting" || state.phase === "network" ? (
          <WaitingView state={state} onCancel={onCancel} />
        ) : state.phase === "error" ? (
          <DeviceSessionErrorView
            state={state}
            onStart={onStart}
            onCancel={onCancel}
          />
        ) : (
          <DeviceSessionProgressView state={state} onCancel={onCancel} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function IdleView({
  baseUrl,
  apiFieldExpanded,
  remember,
  baseUrlError,
  onToggleApiField,
  onChangeBaseUrl,
  onChangeRemember,
  onStart,
  onCancel,
}: {
  baseUrl: string;
  apiFieldExpanded: boolean;
  remember: boolean;
  baseUrlError: string;
  onToggleApiField: () => void;
  onChangeBaseUrl: (next: string) => void;
  onChangeRemember: (next: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 16 }}>
      <ApiBaseUrlField
        value={baseUrl}
        expanded={apiFieldExpanded}
        onToggle={onToggleApiField}
        onChange={onChangeBaseUrl}
      />
      {baseUrlError ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {baseUrlError}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          borderRadius: 14,
          padding: 14,
        }}
      >
        <View style={{ flex: 1, gap: 3 }}>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.semibold,
            }}
          >
            Keep me signed in
          </Text>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {remember
              ? "Request a persistent session. You can revoke it from Active devices."
              : "Use a browser-style session that expires server-side within 12 hours."}
          </Text>
        </View>
        <Switch
          value={remember}
          onValueChange={onChangeRemember}
          accessibilityLabel="Keep me signed in on this phone"
        />
      </View>
      <AuthSubmitButton
        label="Create sign-in code"
        onPress={onStart}
        testID="device-signin-start"
      />
      <TextLink
        onPress={onCancel}
        style={{ alignSelf: "center" }}
        textStyle={{ color: t.fgMuted, fontFamily: FONT.regular }}
      >
        Use email or another sign-in method
      </TextLink>
    </View>
  );
}

function WaitingView({
  state,
  onCancel,
}: {
  state: Extract<MobileDeviceSignInState, { phase: "waiting" | "network" }>;
  onCancel: () => void;
}) {
  const { t } = useTheme();
  const networkInterrupted = state.phase === "network";
  return (
    <View style={{ gap: 18, alignItems: "center" }}>
      <View
        style={{
          backgroundColor: "white",
          borderRadius: 18,
          padding: 14,
          borderWidth: 1,
          borderColor: t.border,
        }}
        accessible
        accessibilityLabel="QR code to approve this phone sign-in"
      >
        <QRCode
          value={state.verificationUriComplete}
          size={220}
          ecl="M"
          backgroundColor="white"
          color="black"
        />
      </View>

      <View style={{ width: "100%", gap: 10 }}>
        <Instruction
          number="1"
          copy="On a signed-in device, scan this QR code."
        />
        <Instruction
          number="2"
          copy="Check that the code below matches, then approve the sign-in."
        />
      </View>

      <View
        style={{
          width: "100%",
          alignItems: "center",
          borderRadius: 14,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.bgSubtle,
          padding: 14,
          gap: 4,
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
          }}
        >
          MATCHING CODE
        </Text>
        <Text
          selectable
          accessibilityLabel={`Matching code ${state.userCode}`}
          {...typeCap("title")}
          style={{
            color: t.fg,
            ...typeStyle("title"),
            fontFamily: FONT.bold,
            letterSpacing: 2,
          }}
        >
          {state.userCode}
        </Text>
      </View>

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          textAlign: "center",
        }}
      >
        No camera? Open {state.verificationUri} on a signed-in device and enter
        the matching code.
      </Text>

      <View
        accessibilityRole="progressbar"
        accessibilityValue={{
          min: 0,
          max: 600,
          now: Math.min(600, state.remainingSeconds),
          text: `${formatRemaining(state.remainingSeconds)} remaining`,
        }}
        style={{
          width: "100%",
          borderRadius: 14,
          borderWidth: 1,
          borderColor: networkInterrupted ? t.warning : t.border,
          backgroundColor: t.surface,
          padding: 14,
          gap: 4,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          {networkInterrupted
            ? "Connection interrupted"
            : "Waiting for approval"}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {networkInterrupted
            ? "Moosewave will keep retrying while this code is valid."
            : `${formatRemaining(state.remainingSeconds)} remaining`}
        </Text>
      </View>

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          textAlign: "center",
        }}
      >
        {state.remember
          ? "Approval creates a persistent session on this phone. Your password and the other device's cookie never move between devices."
          : "Approval creates a session of up to 12 hours on this phone. Your password and the other device's cookie never move between devices."}
      </Text>
      <TextLink
        onPress={onCancel}
        textStyle={{ color: t.fgMuted, fontFamily: FONT.regular }}
      >
        Cancel sign-in
      </TextLink>
    </View>
  );
}

function Instruction({ number, copy }: { number: string; copy: string }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          backgroundColor: `${t.accent}18`,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("badge")}
          style={{ color: t.accent, fontFamily: FONT.semibold }}
        >
          {number}
        </Text>
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          flex: 1,
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {copy}
      </Text>
    </View>
  );
}

function formatRemaining(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}
