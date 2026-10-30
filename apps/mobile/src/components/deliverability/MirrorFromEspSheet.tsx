/**
 * MirrorFromEspSheet — "pull my ESP's suppression list", from the phone.
 *
 * Mobile parity for desktop's MirrorFromEspModal (Suppressions.tsx:1609). One
 * provider picker, one Run button, and the run's three outcomes rendered as
 * three different sentences:
 *
 *  - a finished run shows the imported/skipped/failed summary;
 *  - an UNCONFIGURED provider is an informational setup pointer, never an
 *    error toast — the server's 503 `not_configured` reply is a workspace
 *    state, folded into the data channel by api/suppressionMirror.ts;
 *  - a genuine failure names itself, with a 403 reading as a permission rule.
 *
 * Only rendered for owner/admin (the mount's ScopeAdmin boundary) — the
 * caller passes the same `canWrite` every other suppression write uses.
 * NativeWind v4: static Pressable style objects only.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useMirrorSuppressions } from "@/hooks/useSuppressionWrites";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  MIRROR_PROVIDERS,
  summarizeMirrorRun,
  type MirrorProvider,
} from "@/lib/suppressionMirror";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type Notice =
  | { tone: "success" | "info" | "danger"; text: string }
  | null;

export function MirrorFromEspSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const mirror = useMirrorSuppressions();
  const [provider, setProvider] = useState<MirrorProvider>("mailchimp");
  const [notice, setNotice] = useState<Notice>(null);

  const selected = MIRROR_PROVIDERS.find((p) => p.value === provider);
  const busy = mirror.isPending;

  function close() {
    if (busy) return;
    setNotice(null);
    onClose();
  }

  const run = () => {
    if (busy) return;
    haptics.tap();
    setNotice(null);
    mirror.mutate(provider, {
      onSuccess: (outcome) => {
        if (outcome.kind === "not_configured") {
          setNotice({ tone: "info", text: outcome.reason });
          return;
        }
        haptics.success();
        setNotice({ tone: "success", text: summarizeMirrorRun(outcome.result) });
      },
      onError: (err) => {
        haptics.error();
        setNotice({
          tone: "danger",
          text:
            err instanceof Error && err.message
              ? err.message
              : "The mirror run failed.",
        });
      },
    });
  };

  const noticeColor =
    notice?.tone === "success"
      ? t.success
      : notice?.tone === "danger"
        ? t.danger
        : t.fgMuted;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={close}
      accessibilityLabel="Mirror suppressions from provider"
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.bold,
          marginBottom: 4,
        }}
      >
        Mirror from provider
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginBottom: 16,
        }}
      >
        Re-import bounces, complaints, and unsubscribes from your sending ESP.
        Idempotent — running it twice won&apos;t double-import.
      </Text>
      <SegmentedControl
        options={MIRROR_PROVIDERS.map((p) => ({
          value: p.value,
          label: p.label,
        }))}
        value={provider}
        onChange={(next) => {
          // Provider-specific output is stale once the picker moves.
          setNotice(null);
          setProvider(next as MirrorProvider);
        }}
        accessibilityLabel="Source provider"
      />
      {selected ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          {selected.hint} Existing rows are deduped by provider event.
        </Text>
      ) : null}
      {notice ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("bodySmall")}
          style={{
            color: noticeColor,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.medium,
            marginTop: 14,
          }}
        >
          {notice.text}
        </Text>
      ) : null}
      <Pressable
        onPress={run}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Mirror suppressions from ${selected?.label ?? provider}`}
        accessibilityState={{ disabled: busy, busy }}
        style={{
          marginTop: 18,
          minHeight: 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          backgroundColor: t.accent,
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? <ActivityIndicator size="small" color={t.accentFg} /> : null}
        <Text
          {...typeCap("control")}
          style={{
            color: t.accentFg,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {busy ? "Mirroring…" : "Run mirror"}
        </Text>
      </Pressable>
      <View style={{ height: 8 }} />
    </KeyboardFormSheet>
  );
}
