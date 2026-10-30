/**
 * McpExecutionDetailSheet — one recorded agent call, opened from its log row.
 *
 * A SHEET RATHER THAN A ROUTE: the rhythm is tap → read → close, and it keeps
 * the monitor to one route file. It renders the row the operator tapped
 * immediately (every field the log already had) and re-reads the row for the
 * two things the log dropped — the minimised query/body metadata and the API
 * key id — with their own loading / offline / failed / not-retained states,
 * so a failed re-read never blanks what was already known.
 *
 * MASKING. Every identifier goes through lib/mcpExecutionDetail, the
 * desktop's rules unchanged: a path carrying secret-shaped material or an
 * invisible character is replaced by `/[SENSITIVE_PATH_SUPPRESSED]`; a tool
 * name, error code or User-Agent outside its grammar reads "Suppressed"; the
 * remote IP is stated as removed. Query and body render as key COUNTS only.
 * The desktop's two notices are carried verbatim, because the words are the
 * policy: sensitive values stay hidden, and executable replay is
 * release-held. The ONE clipboard action (McpExecutionDetailParts) copies the
 * constant-shaped body summary — never a path, never a key, never anything
 * that reconstructs a request.
 *
 * `dryRun` is a caller assertion (apikeycalls.go:104-109). The badge says
 * "asserted" and the replay notice says what that does not prove.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { Pill, type PillTone } from "@/components/Pill";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import {
  McpFact,
  McpRequestBodyBlock,
  metadataValue,
  NOT_RETAINED,
} from "@/components/mcp/McpExecutionDetailParts";
import { useMcpExecutionDetail } from "@/hooks/useMcpExecutionDetail";
import { FONT } from "@/lib/fonts";
import { dateTime, EMDASH, money, num, relativeTime } from "@/lib/format";
import type { McpCallOutcome, McpExecution } from "@/lib/mcpActivity";
import {
  MCP_SUPPRESSED,
  mcpExecutionTitle,
  safeMcpDiagnostic,
  safeMcpMethod,
  safeMcpPath,
  safeMcpToolName,
  safeMcpUserAgent,
} from "@/lib/mcpExecutionDetail";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

const OUTCOME_TONE: Readonly<Record<McpCallOutcome, PillTone>> = {
  ok: "success",
  denied: "danger",
  throttled: "warning",
  client: "warning",
  server: "danger",
  unknown: "neutral",
};

const OUTCOME_WORD: Readonly<Record<McpCallOutcome, string>> = {
  ok: "ok",
  denied: "denied",
  throttled: "rate limited",
  client: "rejected",
  server: "server error",
  unknown: "no status",
};

export interface McpExecutionDetailSheetProps {
  call: McpExecution | null;
  allowed: boolean;
  gate: { enabled: boolean };
  onClose: () => void;
}

export function McpExecutionDetailSheet({
  call,
  allowed,
  gate,
  onClose,
}: McpExecutionDetailSheetProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const detail = useMcpExecutionDetail(call ? call.id : null, allowed);
  const row = detail.data?.row ?? null;

  return (
    <ReducedMotionModal
      visible={call !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            gap: 12,
          }}
        >
          <View style={{ flexShrink: 1 }}>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.semibold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              {call ? `Execution ${call.id}` : "Execution"}
            </Text>
            <Text
              numberOfLines={maxLinesAtScale(2, fontScale)}
              {...typeCap("title")}
              style={{
                color: t.fg,
                ...typeStyle("title"),
                fontFamily: FONT.display,
              }}
            >
              {call ? mcpExecutionTitle(call.toolName) : ""}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            style={{
              minHeight: 44,
              minWidth: 44,
              alignItems: "flex-end",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              Close
            </Text>
          </Pressable>
        </View>

        {call ? (
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 12 }}
          >
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Pill label={OUTCOME_WORD[call.outcome]} tone={OUTCOME_TONE[call.outcome]} />
              <Pill
                label={
                  call.dryRun ? "Dry-run header asserted" : "No dry-run header recorded"
                }
                tone={call.dryRun ? "warning" : "neutral"}
              />
            </View>

            <MobileScopeNotice
              title="Sensitive request values stay hidden"
              body="Query values and names, request-body values and object keys, and the remote IP were removed before this row entered retained UI state. Tool name, user agent, and dry-run status are caller-asserted metadata; they do not prove origin, authorization, or that side effects were prevented."
            />

            <View>
              <McpFact label="When" value={whenValue(call.calledAt)} />
              <McpFact label="Execution ID" value={String(call.id)} selectable />
              <McpFact label="Tool identifier" value={toolValue(call.toolName)} selectable />
              <McpFact label="Method" value={safeMcpMethod(call.method)} />
              <McpFact label="Path" value={safeMcpPath(call.path)} selectable />
              <McpFact
                label="Query metadata"
                value={metadataValue(detail, gate, row?.query ?? "")}
              />
              <McpFact
                label="Status"
                value={
                  call.statusCode > 0
                    ? `HTTP ${call.statusCode} · ${OUTCOME_WORD[call.outcome]}`
                    : "No HTTP status was recorded"
                }
              />
              <McpFact
                label="Latency"
                value={call.latencyMs > 0 ? `${num(call.latencyMs)} ms` : EMDASH}
              />
              <McpFact
                label="API key ID"
                value={metadataValue(detail, gate, row?.apiKeyId ?? "")}
                selectable
              />
              <McpFact
                label="API key prefix"
                value={call.apiKeyPrefix || NOT_RETAINED}
                selectable
              />
              <McpFact
                label="User agent"
                value={call.userAgent ? safeMcpUserAgent(call.userAgent) : NOT_RETAINED}
                selectable
              />
              <McpFact label="Remote IP" value="Removed before UI retention" />
              {call.errorCode ? (
                <McpFact
                  label="Error code"
                  value={safeMcpDiagnostic(call.errorCode)}
                  selectable
                />
              ) : null}
              <McpFact
                label="Recorded cost estimate"
                value={money(call.costMicros / 1_000_000, "USD", { cents: true })}
              />
            </View>

            <McpRequestBodyBlock detail={detail} gate={gate} row={row} />

            <MobileScopeNotice
              title="Executable replay is release-held"
              body="No command or replay clipboard action is mounted. A recorded dry-run header is only a caller assertion and does not prove that the target endpoint prevented mutations, sends, or other side effects."
            />

            {detail.data ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {`Detail policy ${detail.data.detailPolicy || "unstated"} · evidence class ${detail.data.evidenceClass || "unstated"}`}
              </Text>
            ) : null}
          </ScrollView>
        ) : null}
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function whenValue(calledAt: string): string {
  const absolute = dateTime(calledAt, "");
  if (!absolute) return "No timestamp recorded";
  const relative = relativeTime(calledAt, { fallback: "" });
  return relative ? `${relative} · ${absolute}` : absolute;
}

function toolValue(toolName: string): string {
  if (!toolName) return "Not recorded or suppressed";
  const safe = safeMcpToolName(toolName);
  return safe === MCP_SUPPRESSED ? "Not recorded or suppressed" : safe;
}
