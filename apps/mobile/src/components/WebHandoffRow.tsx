/**
 * WebHandoffRow — "finish this on the web".
 *
 * Mobile is read-mostly by design, so the moment an operator needs the full
 * editor is frequent and predictable; until now a detail screen was a
 * dead end and the only way across was to retype a URL from memory.
 *
 * COPY IS THE PRIMARY ACTION, and that is a deliberate inversion of the
 * obvious design. The in-app browser does not carry this app's session —
 * mobile authenticates with headers read out of SecureStore, not with the
 * dashboard's cookies — so "Open" can legitimately land on the web sign-in.
 * Copying the link, to paste where the user is already signed in, is the
 * action that always works. The note says so rather than letting the user
 * discover it after a tap.
 *
 * The link's ORIGIN is PUBLIC_APP_BASE_URL, not the hardcoded
 * app.moosewave.com that @postwave/route-map's buildUniversalLink emits, so a
 * self-hosted deployment hands off to its own dashboard instead of to a host
 * its operators have never heard of.
 *
 * ── WHY IT LIVES IN components/ AND NOT components/subscriber/ ─────────────
 * It shipped on the subscriber detail first and was filed under that folder,
 * which read as "a subscriber thing". It is not: it is the app's answer to
 * "mobile is read-mostly", and every entity with a detail screen has the same
 * dead end. It now renders on all three route-map entities that HAVE a web
 * detail route — subscriber, campaign, sequence — verified against
 * apps/web/src/app/(dashboard)/app/{subscribers,campaigns,sequences}/[id].
 *
 * The `entity` union is deliberately narrower than route-map's registry.
 * `approval` is in the registry too, but `webPath("approval", id)` emits
 * /app/approvals/<id>, and apps/web has no such route — the handoff would be a
 * confident link to a 404. Widening this union is a two-surface change, not a
 * mobile one.
 */
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";

import { useToast } from "@/components/Toast";
import { PUBLIC_APP_BASE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { webHandoffUrl, WEB_HANDOFF_NOTE } from "@/lib/webHandoff";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function WebHandoffRow({
  entity,
  id,
  label,
}: {
  /**
   * A @postwave/route-map entity key. Only entities in that shared registry
   * are accepted: inventing a web path for one that is not there (lists,
   * segments) would put a second, drifting copy of the URL grammar in the
   * mobile app.
   */
  entity: "subscriber" | "campaign" | "sequence";
  id: string | null | undefined;
  /** What the link points at, for the spoken labels. */
  label: string;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const url = webHandoffUrl(PUBLIC_APP_BASE_URL, entity, id);

  const onCopy = useCallback(() => {
    if (!url) return;
    haptics.tap();
    void Clipboard.setStringAsync(url)
      .then(() => toast({ kind: "success", message: "Link copied" }))
      .catch(() =>
        toast({ kind: "error", message: "Couldn't copy the link." }),
      );
  }, [toast, url]);

  const onOpen = useCallback(() => {
    if (!url) return;
    haptics.tap();
    void WebBrowser.openBrowserAsync(url).catch(() =>
      toast({ kind: "error", message: "Couldn't open the browser." }),
    );
  }, [toast, url]);

  // No link, no row. A disabled handoff explains nothing useful.
  if (!url) return null;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginTop: 12,
        gap: 10,
      }}
    >
      <Text
        {...typeCap("caption")}
        accessibilityRole="header"
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.6,
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
        }}
      >
        Continue on the web
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <HandoffButton
          label="Copy link"
          accessibilityLabel={`Copy the dashboard link for ${label}`}
          primary
          onPress={onCopy}
        />
        <HandoffButton
          label="Open"
          accessibilityLabel={`Open ${label} in the Moosewave dashboard`}
          onPress={onOpen}
        />
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {WEB_HANDOFF_NOTE}
      </Text>
    </View>
  );
}

function HandoffButton({
  label,
  accessibilityLabel,
  onPress,
  primary = false,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      // Static style object: a function-style `style` on a Pressable silently
      // drops layout under NativeWind v4.
      style={{
        minHeight: 44,
        flex: 1,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: primary ? t.accent : t.border,
        backgroundColor: primary ? t.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 12,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: primary ? t.accentFg : t.fg,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
