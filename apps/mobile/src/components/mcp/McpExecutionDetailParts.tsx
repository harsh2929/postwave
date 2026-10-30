/**
 * McpExecutionDetailParts — the fact row and the request-metadata block of
 * the execution detail sheet. Split from the sheet by responsibility: the
 * sheet decides WHAT is shown; these decide how one fact and one metadata
 * block read, including every "why is this missing" sentence.
 *
 * The metadata block owns the sheet's ONE clipboard action. It copies the
 * constant-shaped body summary (`_summary/type/key_count/_truncated`) and
 * nothing else — never a path, a key name or a value — and reports a
 * clipboard that refused rather than saying "copied".
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { copyToClipboard } from "@/lib/clipboard";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { MCP_DETAIL_NOT_RETAINED, mcpRedactionSentence } from "@/lib/mcpExecutionDetail";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export const NOT_RETAINED = "Not retained";

/** The slice of a TanStack result these parts branch on. */
export interface DetailQueryLike {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  data: { row: unknown } | undefined;
}

/**
 * A fact that only the re-read can supply. States WHY it is missing rather
 * than showing a blank: loading, offline, failed, or not retained.
 */
export function metadataValue(
  detail: DetailQueryLike,
  gate: { enabled: boolean },
  value: string,
): string {
  if (value) return value;
  if (detail.data) {
    return detail.data.row ? NOT_RETAINED : MCP_DETAIL_NOT_RETAINED;
  }
  if (!gate.enabled) return "Needs a connection";
  if (detail.isError) return "Could not be read";
  if (detail.isLoading) return "Loading…";
  return NOT_RETAINED;
}

function errorText(error: unknown): string {
  const message =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown }).message
      : null;
  return typeof message === "string" && message
    ? message
    : "The call detail could not be read.";
}

export function McpRequestBodyBlock({
  detail,
  gate,
  row,
}: {
  detail: DetailQueryLike;
  gate: { enabled: boolean };
  row: { bodyJson: string; redactionCount: number } | null;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const status = !detail.data
    ? !gate.enabled
      ? "Request metadata needs a connection."
      : detail.isError
        ? errorText(detail.error)
        : detail.isLoading
          ? "Loading request metadata…"
          : null
    : row === null
      ? MCP_DETAIL_NOT_RETAINED
      : row.bodyJson
        ? null
        : "No request body metadata was retained for this call.";

  const copy = () => {
    if (!row?.bodyJson) return;
    haptics.tap();
    void copyToClipboard(row.bodyJson).then((ok) => {
      if (ok) {
        haptics.success();
        toast({ kind: "success", message: "Minimized request metadata copied" });
      } else {
        haptics.error();
        toast({ kind: "error", message: "The redacted detail could not be copied." });
      }
    });
  };

  return (
    <View style={{ gap: 6 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("caption")}
          accessibilityRole="header"
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          Request body metadata
        </Text>
        {row?.bodyJson ? (
          <Pressable
            onPress={copy}
            accessibilityRole="button"
            accessibilityLabel="Copy minimized request body metadata"
            accessibilityHint="The only clipboard action here copies constant minimized metadata without captured key names or values"
            hitSlop={8}
            style={{ minHeight: 44, justifyContent: "center", paddingStart: 12 }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              Copy metadata
            </Text>
          </Pressable>
        ) : null}
      </View>
      {status ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {status}
        </Text>
      ) : row ? (
        <>
          <Text
            {...typeCap("bodySmall")}
            selectable
            accessibilityLabel="Minimized request body metadata"
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
              backgroundColor: t.bgSubtle,
              borderRadius: 10,
              padding: 10,
            }}
          >
            {row.bodyJson}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {mcpRedactionSentence(row.redactionCount)}
          </Text>
        </>
      ) : null}
    </View>
  );
}

/** One label/value fact; `selectable` on identifiers so they can be long-pressed. */
export function McpFact({
  label,
  value,
  selectable = false,
}: {
  label: string;
  value: string;
  selectable?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{ flexDirection: "row", gap: 10, paddingVertical: 5 }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          width: 112,
        }}
      >
        {label}
      </Text>
      <Text
        selectable={selectable}
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          flex: 1,
          ...typeStyle("bodySmall"),
          fontFamily: selectable ? FONT.medium : FONT.regular,
        }}
      >
        {value}
      </Text>
    </View>
  );
}
