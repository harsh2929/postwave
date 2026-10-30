/**
 * LandingPageAdminActions — the status verb and the soft archive for one
 * landing page. (The 2-field create sheet lives in its sibling,
 * LandingPageCreateSheet — split at this file's source budget.)
 *
 * Rendered inside LandingPageDetailSheet for admin sessions only (every
 * landing write is ScopeAdmin server-side). The verb table lives in
 * lib/landingLifecycle, read off desktop's statusAction — one status verb per
 * state, so "Publish" never sits beside a live page.
 *
 * All writes are ONLINE-ONLY (they change what the public internet is
 * served); the runner refuses offline taps with a toast instead of queueing.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useIsOnline } from "@/hooks/useIsOnline";
import {
  useArchiveLandingPage,
  useUpdateLandingPageStatus,
} from "@/hooks/useLandingPages";
import {
  archiveLandingCopy,
  landingStatusVerb,
} from "@/lib/landingLifecycle";
import type { MobileLandingPage } from "@/lib/landingPages";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export const LANDING_OFFLINE_MESSAGE =
  "Changing what the public is served needs a connection — it is never queued.";
const OFFLINE_MESSAGE = LANDING_OFFLINE_MESSAGE;

export function LandingPageAdminActions({
  page,
}: {
  page: MobileLandingPage;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const online = useIsOnline();
  const setStatus = useUpdateLandingPageStatus();
  const archive = useArchiveLandingPage();
  const busy = setStatus.isPending || archive.isPending;

  const verb = landingStatusVerb(page.status, page.name);
  const isArchived = page.status.trim().toLowerCase() === "archived";

  const refuseOffline = useCallback(() => {
    haptics.error();
    toast({ kind: "error", message: OFFLINE_MESSAGE });
  }, [toast]);

  const onStatus = useCallback(async () => {
    if (!verb || busy) return;
    if (!online) {
      refuseOffline();
      return;
    }
    const ok = await confirm({
      title: verb.confirmTitle,
      message: verb.confirmMessage,
      confirmLabel: verb.label,
      destructive: verb.destructive,
    });
    if (!ok) return;
    haptics.impact();
    try {
      await setStatus.mutateAsync({ id: page.id, status: verb.target });
      haptics.success();
      toast({ kind: "success", message: verb.successMessage });
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : `${verb.label} failed. Please try again.`,
      });
    }
  }, [busy, confirm, online, page.id, refuseOffline, setStatus, toast, verb]);

  const onArchive = useCallback(async () => {
    if (busy) return;
    if (!online) {
      refuseOffline();
      return;
    }
    const copy = archiveLandingCopy(page.name);
    const ok = await confirm({
      title: copy.confirmTitle,
      message: copy.confirmMessage,
      confirmLabel: "Archive",
      destructive: true,
    });
    if (!ok) return;
    haptics.impact();
    try {
      await archive.mutateAsync(page.id);
      haptics.success();
      toast({ kind: "success", message: copy.successMessage });
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Archive failed. Please try again.",
      });
    }
  }, [archive, busy, confirm, online, page.id, page.name, refuseOffline, toast]);

  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {verb ? (
        <ActionButton
          label={setStatus.isPending ? "Saving…" : verb.label}
          destructive={verb.destructive}
          disabled={busy}
          onPress={() => void onStatus()}
        />
      ) : null}
      {!isArchived ? (
        <ActionButton
          label={archive.isPending ? "Archiving…" : "Archive"}
          destructive
          disabled={busy}
          onPress={() => void onArchive()}
        />
      ) : null}
    </View>
  );
}

function ActionButton({
  label,
  destructive,
  disabled,
  onPress,
}: {
  label: string;
  destructive: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        minHeight: 44,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: destructive ? t.danger : t.border,
        backgroundColor: t.surface,
        opacity: disabled ? 0.45 : 1,
        paddingHorizontal: 12,
      }}
    >
      <Text
        {...typeCap("control")}
        numberOfLines={1}
        style={{
          color: destructive ? t.danger : t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
