/**
 * McpExecutionRow — one recorded agent call.
 *
 * WHAT LEADS. The tool name and the OUTCOME, in that order: an operator
 * scanning this log is looking for the one red word, and everything else on the
 * row exists to say whether it is worth opening the desktop.
 *
 * TWO ABSENCES THAT ARE NOT ZEROS.
 *  - `toolName` is written from the optional `X-Postwave-MCP-Tool` header
 *    (apikeycalls.go:48-51), so an untagged call has "" — which is "this call
 *    did not name a tool", not "the tool called ''". The row falls back to the
 *    method and path, which are always recorded.
 *  - `statusCode` of 0 means the recorder never wrote one. Rendering it as
 *    "0" would invent an HTTP status that does not exist; the row says
 *    "no status" and the outcome pill reads "unknown", which is not counted as
 *    a failure by `isMcpFailure`.
 *
 * State is never colour alone: the outcome is a labelled Pill AND the row's
 * spoken label opens with the same word.
 */
import { Pressable, Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { EMDASH, dateTime, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import type { McpCallOutcome, McpExecution } from "@/lib/mcpActivity";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const OUTCOME_TONE: Readonly<Record<McpCallOutcome, PillTone>> = {
  ok: "success",
  denied: "danger",
  throttled: "warning",
  client: "warning",
  server: "danger",
  unknown: "neutral",
};

/** Plain words rather than status classes — "4xx" is not a diagnosis. */
const OUTCOME_WORD: Readonly<Record<McpCallOutcome, string>> = {
  ok: "ok",
  denied: "denied",
  throttled: "rate limited",
  client: "rejected",
  server: "server error",
  unknown: "no status",
};

/**
 * `onPress` opens the call's detail sheet. Optional so the row stays a plain
 * readout where no sheet is mounted; when present the whole card is the
 * button (44pt minimum is already met) and its spoken label ends with the
 * hint, so an assistive-tech user learns there is somewhere to go.
 */
export function McpExecutionRow({
  call,
  onPress,
}: {
  call: McpExecution;
  onPress?: ((call: McpExecution) => void) | undefined;
}) {
  const { t } = useTheme();
  const title = call.toolName || [call.method, call.path].filter(Boolean).join(" ") || "Unnamed call";
  const when = relativeTime(call.calledAt, { fallback: "" });
  const absolute = dateTime(call.calledAt, "");
  const status = call.statusCode > 0 ? String(call.statusCode) : EMDASH;
  const latency = call.latencyMs > 0 ? `${num(call.latencyMs)} ms` : EMDASH;

  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress ? () => onPress(call) : undefined}
      accessible
      {...(onPress
        ? {
            accessibilityRole: "button" as const,
            accessibilityHint: "Opens the call's masked request metadata",
          }
        : {})}
      accessibilityLabel={[
        `${OUTCOME_WORD[call.outcome]}.`,
        `${title}.`,
        call.toolName ? `${call.method} ${call.path}.` : "",
        call.statusCode > 0
          ? `HTTP ${call.statusCode}.`
          : "No HTTP status was recorded.",
        call.errorCode ? `Error code ${call.errorCode}.` : "",
        call.latencyMs > 0 ? `Took ${num(call.latencyMs)} milliseconds.` : "",
        absolute ? `At ${absolute}.` : "No timestamp recorded.",
        call.apiKeyPrefix ? `Key ${call.apiKeyPrefix}.` : "",
        call.dryRun ? "Dry run — it changed nothing." : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        minHeight: 44,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
            numberOfLines={1}
          >
            {title}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
          >
            {[
              call.toolName ? `${call.method} ${call.path}` : "",
              when ? when : "no timestamp",
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        <Pill label={OUTCOME_WORD[call.outcome]} tone={OUTCOME_TONE[call.outcome]} />
      </View>

      <View
        // Hidden from assistive tech: the row's own label already speaks every
        // figure below in full, and a second stop would repeat them compacted.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginTop: 10,
          flexWrap: "wrap",
        }}
      >
        <Meta text={`HTTP ${status}`} />
        <Meta text={latency} />
        {call.errorCode ? <Meta text={call.errorCode} emphasis /> : null}
        {call.apiKeyPrefix ? <Meta text={call.apiKeyPrefix} /> : null}
        {call.dryRun ? <Pill label="dry run" tone="warning" /> : null}
      </View>
    </Pressable>
  );
}

function Meta({ text, emphasis = false }: { text: string; emphasis?: boolean }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: emphasis ? t.danger : t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: emphasis ? FONT.semibold : FONT.regular,
      }}
      numberOfLines={1}
    >
      {text}
    </Text>
  );
}
