/**
 * MoreWorkspaceCard — the identity block at the top of the More screen.
 *
 * Split out of more.tsx to keep that screen under the source budget, and fixed
 * on the way: the whole card used to be ONE `accessible` container whose label
 * interpolated workspace + connection + origin into a single string VoiceOver
 * read as an unbroken run; the workspace name was one line (so a long or CJK
 * name was unidentifiable); email and role were concatenated into one truncated
 * line, so the role — the part that decides what you can do — was the first
 * thing to disappear; and the tenant id and API origin were unselectable
 * monospace text with no copy affordance at all. Both identifiers are now
 * ordinary tap-to-copy controls; long press remains the secondary Share path.
 */
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { copyToClipboard } from "@/lib/clipboard";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { cardOuter, sectionLabel } from "@/components/more/moreStyles";

export interface MoreWorkspaceCardProps {
  workspaceLabel: string;
  tenantSubLabel: string | null;
  connectionLabel: string;
  /**
   * The full spoken form of the connection state. The visible label is a
   * one-word pill ("Cached"), which tells a screen-reader user nothing about
   * the consequence — and the dot beside it is colour-alone.
   */
  connectionSpoken: string;
  connectionColor: string;
  baseUrl: string | null;
  email: string | null;
  role: string | null;
  onShare: (label: string, value: string) => void;
}

export function MoreWorkspaceCard({
  workspaceLabel,
  tenantSubLabel,
  connectionLabel,
  connectionSpoken,
  connectionColor,
  baseUrl,
  email,
  role,
  onShare,
}: MoreWorkspaceCardProps) {
  const { t } = useTheme();
  const { toast } = useToast();

  const copyMetadata = useCallback(
    (label: "Workspace ID" | "API origin", value: string) => {
      const spokenLabel = label === "Workspace ID" ? "workspace ID" : "API origin";
      haptics.tap();
      void copyToClipboard(value).then((copied) => {
        if (copied) {
          haptics.success();
          toast({ kind: "success", message: `${label} copied.` });
          return;
        }
        haptics.error();
        toast({
          kind: "error",
          message: `Couldn't copy the ${spokenLabel}. Long press to share it instead.`,
        });
      });
    },
    [toast],
  );

  return (
    // NOT one `accessible` container: collapsing workspace + connection +
    // origin into a single interpolated label made VoiceOver read an unbroken
    // run with no way to navigate between the parts.
    <View style={cardOuter(t)}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text {...typeCap("caption")} style={[sectionLabel(t), typeStyle("caption")]}>
          Workspace
        </Text>
        <View
          accessible
          accessibilityLabel={`Connection: ${connectionSpoken}`}
          style={{ flexDirection: "row", alignItems: "center", marginTop: -2 }}
        >
          <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: connectionColor,
              marginEnd: 5,
            }}
          />
          <Text
            // One-word connection state sharing a row with the "Workspace"
            // heading and a 7pt dot: dense geometry, so the tight ceiling.
            {...typeCap("badgeSmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("badgeSmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {connectionLabel}
          </Text>
        </View>
      </View>
      <Text
        // Two lines: a 120-character or CJK workspace name truncated to one
        // line is unidentifiable.
        numberOfLines={2}
        ellipsizeMode="tail"
        accessibilityLabel={`Workspace ${workspaceLabel}`}
        // Card headline.
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {workspaceLabel}
      </Text>
      {tenantSubLabel ? (
        <Pressable
          onPress={() => copyMetadata("Workspace ID", tenantSubLabel)}
          onLongPress={() => onShare("workspace ID", tenantSubLabel)}
          delayLongPress={350}
          accessibilityRole="button"
          accessibilityLabel={`Copy workspace ID. ${tenantSubLabel}`}
          accessibilityHint="Copies the workspace ID to the clipboard. Use the Share action to send it elsewhere."
          accessibilityActions={[
            { name: "copy", label: "Copy workspace ID" },
            { name: "share", label: "Share workspace ID" },
          ]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "copy") {
              copyMetadata("Workspace ID", tenantSubLabel);
            } else if (event.nativeEvent.actionName === "share") {
              onShare("workspace ID", tenantSubLabel);
            }
          }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              selectable
              numberOfLines={1}
              // Footnote-weight identifier under the title. It truncates rather
              // than reflows, but the full value remains in the spoken label.
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                flex: 1,
              }}
            >
              {tenantSubLabel}
            </Text>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              {...typeCap("label")}
              style={{
                color: t.accent,
                ...typeStyle("label"),
                fontFamily: FONT.medium,
              }}
            >
              Copy
            </Text>
          </View>
        </Pressable>
      ) : null}
      {/* email and role as separate elements: concatenated into one truncated
          line, the role — the part that decides what the user can do — was the
          first thing to disappear. */}
      {email ? (
        <Text
          numberOfLines={1}
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {email}
        </Text>
      ) : null}
      {role ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {role}
        </Text>
      ) : null}
      <Pressable
        onPress={() => baseUrl && copyMetadata("API origin", baseUrl)}
        onLongPress={() => baseUrl && onShare("API origin", baseUrl)}
        delayLongPress={350}
        disabled={!baseUrl}
        accessibilityRole="button"
        accessibilityLabel={
          baseUrl ? `Copy API origin. ${baseUrl}` : "API origin not connected"
        }
        accessibilityHint={
          baseUrl
            ? "Copies the API origin to the clipboard. Use the Share action to send it elsewhere."
            : "There is no API origin available to copy."
        }
        accessibilityState={{ disabled: !baseUrl }}
        accessibilityActions={
          baseUrl
            ? [
                { name: "copy", label: "Copy API origin" },
                { name: "share", label: "Share API origin" },
              ]
            : undefined
        }
        onAccessibilityAction={(event) => {
          if (!baseUrl) return;
          if (event.nativeEvent.actionName === "copy") {
            copyMetadata("API origin", baseUrl);
          } else if (event.nativeEvent.actionName === "share") {
            onShare("API origin", baseUrl);
          }
        }}
        style={{ minHeight: 44, justifyContent: "center", marginTop: 4 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            selectable
            numberOfLines={1}
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              flex: 1,
            }}
          >
            {baseUrl || "Not connected"}
          </Text>
          {baseUrl ? (
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              {...typeCap("label")}
              style={{
                color: t.accent,
                ...typeStyle("label"),
                fontFamily: FONT.medium,
              }}
            >
              Copy
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}
