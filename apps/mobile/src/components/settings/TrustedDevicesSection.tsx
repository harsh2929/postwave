/**
 * TrustedDevicesSection — the visible, revocable half of AUTH#48.
 *
 * ── WHY THIS SCREEN IS PART OF THE FEATURE, NOT A NICETY ───────────────────
 * "Remember this device" mints a credential that lets a BRAND NEW session
 * start already MFA-satisfied, for up to 180 days, without the user touching
 * their authenticator. A credential the user cannot see or kill is not
 * acceptable, so this list is the condition on which the feature ships.
 *
 * ── IT SITS BESIDE ACTIVE DEVICES, NOT INSIDE IT ───────────────────────────
 * A trusted device is NOT a session. It outlives logout, it outlives session
 * expiry, and "sign out all other devices" does NOT revoke it. Rendering the
 * two in one list would teach exactly that false equivalence; rendering them
 * adjacent, with distinct verbs ("Sign out" vs "Forget"), teaches the real
 * difference on the only screen where it matters.
 *
 * ── NOTHING IS CACHED ──────────────────────────────────────────────────────
 * Same rule as ActiveDevicesSection: a stale list of what can currently skip
 * your second factor is worse than no list. Gate closed → reconnect notice.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { CachedSessionNotice, cachedSessionNotice } from "@/components/CachedSessionNotice";
import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { Card, SectionHeader } from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useRevokeAllTrustedDevices,
  useRevokeTrustedDevice,
  useTrustedDevices,
  type TrustedDeviceInfo,
} from "@/hooks/useTrustedDevices";
import { announce } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { deviceLabel } from "@/lib/sessionDevice";
import { useTheme } from "@/lib/theme";
import {
  trustCeilingDays,
  trustedDeviceLines,
} from "@/lib/trustedDeviceContract";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function TrustedDevicesSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const trusted = useTrustedDevices();
  const forget = useRevokeTrustedDevice();
  const forgetAll = useRevokeAllTrustedDevices();
  const [pendingId, setPendingId] = useState<string | null>(null);

  // `devices` is a nested wire field, so the nullish guard on it admits any
  // truthy non-array into `.map`. This is the screen used to revoke a device
  // after a suspected compromise.
  const rows = Array.isArray(trusted.data?.devices)
    ? trusted.data.devices
    : [];
  const notice = cachedSessionNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    surface: "sessions",
  });

  async function onForget(row: TrustedDeviceInfo): Promise<void> {
    const label = row.label || deviceLabel(row.user_agent);
    const ok = await confirm({
      title: `Forget ${label}?`,
      message:
        "It will ask for a two-factor code again the next time it signs in.",
      confirmLabel: "Forget",
      destructive: true,
      consequence: trustedDeviceLines(row, Date.now()).expiry,
    });
    if (!ok) return;
    setPendingId(row.id);
    try {
      await forget.mutateAsync(row.id);
      haptics.success();
      toast({ kind: "success", message: `${label} will ask for a code again.` });
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Couldn't forget that device.",
      });
    } finally {
      setPendingId(null);
    }
  }

  async function onForgetAll(): Promise<void> {
    const ok = await confirm({
      title: "Ask for a code everywhere?",
      message:
        "Every remembered device, including this phone, will need a two-factor code at its next sign-in.",
      confirmLabel: "Forget all",
      destructive: true,
      consequence: `${rows.length} remembered ${
        rows.length === 1 ? "device" : "devices"
      } will be forgotten immediately.`,
    });
    if (!ok) return;
    try {
      const count = await forgetAll.mutateAsync();
      haptics.success();
      const message = `Forgot ${count} ${count === 1 ? "device" : "devices"}.`;
      toast({ kind: "success", message });
      announce(message);
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Couldn't forget your trusted devices.",
      });
    }
  }

  return (
    <>
      <SectionHeader
        title="Remembered devices"
        subtitle="Devices that can sign in without a two-factor code."
      />
      {notice ? (
        <CachedSessionNotice notice={notice} style={{ marginBottom: 10 }} />
      ) : null}
      <Card>
        <QueryStates
          query={trusted}
          isEmpty={rows.length === 0}
          gate={gate}
          skeleton={<SkeletonList rows={2} />}
          empty={{
            title: "No remembered devices",
            description:
              "Every sign-in asks for a two-factor code. That is the safest setting.",
          }}
          offlineMessage="Reconnect to review which devices can skip your two-factor code. This list is never cached."
        >
          {rows.map((row, index) => (
            <TrustedDeviceRow
              key={row.id}
              row={row}
              first={index === 0}
              busy={pendingId === row.id}
              onForget={() => void onForget(row)}
            />
          ))}
        </QueryStates>

        {rows.length > 0 ? (
          <Pressable
            onPress={() => void onForgetAll()}
            disabled={forgetAll.isPending}
            accessibilityRole="button"
            accessibilityLabel={`Forget all ${rows.length} remembered devices`}
            accessibilityState={{
              disabled: forgetAll.isPending,
              busy: forgetAll.isPending,
            }}
            style={{
              marginTop: 12,
              paddingVertical: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.danger,
              backgroundColor: `${t.danger}1a`,
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              opacity: forgetAll.isPending ? 0.6 : 1,
            }}
          >
            {forgetAll.isPending ? (
              <ActivityIndicator color={t.danger} />
            ) : (
              <Text
                {...typeCap("body")}
                style={{
                  color: t.danger,
                  ...typeStyle("body"),
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                Forget all remembered devices
              </Text>
            )}
          </Pressable>
        ) : null}
      </Card>
      {trusted.data ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          {/* The ceiling is stated, not implied. It comes off the wire and is
              narrowed against this build's known set, so it can never read
              longer than the app is willing to ask for. */}
          {trusted.data.allowed
            ? `A device can be remembered for at most ${trustCeilingDays(
                trusted.data.allowedDurations,
              )} days, and never longer.`
            : "This workspace has turned off remembering devices, so every sign-in asks for a code."}
        </Text>
      ) : null}
    </>
  );
}

function TrustedDeviceRow({
  row,
  first,
  busy,
  onForget,
}: {
  row: TrustedDeviceInfo;
  first: boolean;
  busy: boolean;
  onForget: () => void;
}) {
  const { t } = useTheme();
  const title = row.label || deviceLabel(row.user_agent);
  const lines = trustedDeviceLines(row, Date.now());

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.borderSubtle,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {title}
          </Text>
          {/* Text, not a colour — "this device" has to survive colour
              blindness and a screen reader, because forgetting THIS one is
              the row that changes what happens the next time you sign in
              here. Unlike sessions, it IS revocable from this screen. */}
          {row.current ? <Pill label="This device" tone="accent" /> : null}
        </View>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={1}
        >
          {`${lines.duration} · ${lines.expiry}`}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={1}
        >
          {lines.lastUsed}
        </Text>
      </View>
      <Pressable
        onPress={onForget}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Forget ${title}. ${lines.expiry}. ${lines.lastUsed}.`}
        accessibilityState={{ disabled: busy, busy }}
        hitSlop={6}
        style={{
          minHeight: 44,
          minWidth: 44,
          paddingHorizontal: 10,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          opacity: busy ? 0.5 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator color={t.danger} />
        ) : (
          <Text
            {...typeCap("control")}
            style={{
              color: t.danger,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Forget
          </Text>
        )}
      </Pressable>
    </View>
  );
}
