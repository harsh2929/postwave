/**
 * ConnectionProfilesSheet — the list, the add form and the two refusals.
 *
 * Split from ConnectionProfilesCard so the trigger stays a trigger and this
 * file carries the whole transaction. Mirrors desktop's Add-workspace dialog
 * (WorkspaceMenu.tsx:392-513) minus its API-key field, which mobile
 * deliberately does not store per profile — see lib/connectionProfiles.ts.
 *
 * Three things the UI refuses, each with a reason rather than a disabled
 * control the user has to guess about:
 *   - the CURRENT connection is listed and marked, but is not a button;
 *   - removing the current connection is refused (sign in elsewhere first);
 *   - an offline switch is refused, because signing out of this server when we
 *     cannot sign in to the other one strands the operator on the sign-in
 *     screen of a server they cannot reach.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { AddConnectionForm } from "@/components/workspace/ConnectionProfilesForm";
import type { ConnectionProfilesController } from "@/hooks/useConnectionProfiles";
import { announce } from "@/lib/a11y";
import {
  connectionHostLabel,
  connectionSwitchConsequence,
  connectionSwitchDecision,
  sortConnectionProfiles,
  type ConnectionProfile,
} from "@/lib/connectionProfiles";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { queryClient } from "@/lib/queryClient";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Writes still waiting to reach the current server, or 0 if unknowable. */
function pendingMutationCount(): number {
  try {
    return queryClient.getMutationCache().getAll().length;
  } catch {
    return 0;
  }
}

export function ConnectionProfilesSheet({
  visible,
  onClose,
  returnFocusRef,
  controller,
}: {
  visible: boolean;
  onClose: () => void;
  returnFocusRef: ReturnFocusRef;
  controller: ConnectionProfilesController;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const rows = sortConnectionProfiles(controller.state);

  async function onPick(
    profile: ConnectionProfile,
    rowRef: { current: unknown },
  ): Promise<void> {
    const decision = connectionSwitchDecision({
      profile,
      activeId: controller.state.activeId,
      online: controller.online,
    });
    if (decision.kind === "current") return;
    if (decision.kind === "offline") {
      haptics.error();
      toast({ kind: "error", message: decision.message });
      return;
    }
    const ok = await confirm({
      title: decision.title,
      message: decision.message,
      confirmLabel: decision.confirmLabel,
      destructive: true,
      consequence: connectionSwitchConsequence(pendingMutationCount()),
      restoreFocusTo: rowRef,
    });
    if (!ok) return;
    setSwitchingId(profile.id);
    try {
      // Never resolves into this screen: the sign-out it runs navigates to the
      // sign-in route, already pointed at this profile's server.
      await controller.commitSwitch(profile);
      announce(`Signed out. Sign in to ${profile.name}.`);
    } finally {
      setSwitchingId(null);
    }
  }

  async function onRemove(profile: ConnectionProfile): Promise<void> {
    const ok = await confirm({
      title: `Remove ${profile.name}?`,
      message: `${connectionHostLabel(
        profile.baseUrl,
      )} is removed from this device. Nothing on the server changes.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    const refusal = await controller.remove(profile.id);
    if (refusal) {
      haptics.error();
      toast({ kind: "error", message: refusal });
      return;
    }
    haptics.success();
    toast({ kind: "success", message: `Removed “${profile.name}”.` });
    announce(`Removed ${profile.name}`);
  }

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      accessibilityLabel="Server connections"
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          fontFamily: FONT.display,
          ...typeStyle("title"),
          marginBottom: 4,
        }}
      >
        Server connections
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("bodySmall"),
          marginBottom: 16,
        }}
      >
        Keep a staging and a production server — or two customers&apos; installs
        — on one device. A connection stores a name and an address, never an API
        key, so switching signs out of this server and opens sign-in for the
        other one.
      </Text>

      {!controller.ready ? (
        <SkeletonList rows={2} label="Loading saved connections" />
      ) : (
        <View style={{ gap: 10 }}>
          {rows.map((profile) => (
            <ConnectionRow
              key={profile.id}
              profile={profile}
              active={profile.id === controller.state.activeId}
              busy={switchingId === profile.id}
              disabled={switchingId !== null}
              onPick={onPick}
              onRemove={onRemove}
            />
          ))}
        </View>
      )}

      <AddConnectionForm controller={controller} />

      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={{
          marginTop: 20,
          minHeight: 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontFamily: FONT.semibold,
            ...typeStyle("body"),
          }}
        >
          Close
        </Text>
      </Pressable>
    </KeyboardFormSheet>
  );
}

function ConnectionRow({
  profile,
  active,
  busy,
  disabled,
  onPick,
  onRemove,
}: {
  profile: ConnectionProfile;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  onPick: (
    profile: ConnectionProfile,
    rowRef: { current: unknown },
  ) => Promise<void>;
  onRemove: (profile: ConnectionProfile) => Promise<void>;
}) {
  const { t } = useTheme();
  // One ref per row: VoiceOver focus has to be handed back to the row that
  // opened the confirm, and a shared ref would send every dismissal to the
  // same place (the same reason WorkspaceSwitcher keeps one per row).
  const rowRef = useRef<View>(null);
  const host = connectionHostLabel(profile.baseUrl);

  const body = (
    <View style={{ flex: 1 }}>
      <Text
        numberOfLines={2}
        {...typeCap("body")}
        style={{ color: t.fg, fontFamily: FONT.semibold, ...typeStyle("body") }}
      >
        {profile.name}
      </Text>
      <Text
        numberOfLines={1}
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("label"),
          marginTop: 2,
        }}
      >
        {host}
      </Text>
    </View>
  );

  const frame = {
    minHeight: 56,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: active ? t.accent : t.borderSubtle,
    backgroundColor: t.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
  };

  if (active) {
    return (
      <View
        ref={rowRef}
        accessible
        accessibilityLabel={`${profile.name}, ${host}. Current connection.`}
        style={frame}
      >
        {body}
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: t.accent,
            fontFamily: FONT.semibold,
            ...typeStyle("badgeSmall"),
          }}
        >
          Current
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "stretch", gap: 8 }}>
      <Pressable
        ref={rowRef}
        onPress={() => {
          void onPick(profile, rowRef);
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Switch to ${profile.name}, ${host}`}
        accessibilityHint="Signs this device out and opens sign-in for that server"
        accessibilityState={{ disabled, busy }}
        style={{ ...frame, flex: 1, opacity: disabled && !busy ? 0.5 : 1 }}
      >
        {body}
        {busy ? <ActivityIndicator color={t.accent} /> : null}
      </Pressable>
      <Pressable
        onPress={() => {
          void onRemove(profile);
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${profile.name}`}
        accessibilityState={{ disabled }}
        style={{
          width: 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          backgroundColor: t.surface,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text
          allowFontScaling={false}
          style={{ color: t.fgSubtle, fontSize: 18, fontFamily: FONT.regular }}
        >
          ×
        </Text>
      </Pressable>
    </View>
  );
}
