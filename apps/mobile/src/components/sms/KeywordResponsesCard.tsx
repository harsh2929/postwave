/**
 * KeywordResponsesCard — inbound keyword state rules and stored reply text.
 *
 * Opt-out matching remains an inbound state effect. Custom/HELP outbound
 * confirmations are independently release-held. Reply-only rows are
 * therefore display-only here; legacy custom opt-in rows are rejected by the
 * current server projection.
 *
 * The carrier-mandated keywords (STOP, HELP, START, …) are handled by a
 * hardcoded switch server-side and cannot be tenant rows at all.
 */
import { Text, View, Switch } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import {
  canToggleSmsKeywordResponse,
  keywordActionLabel,
  RESERVED_SMS_KEYWORDS,
  type SmsKeywordResponse,
} from "@/lib/smsPolicies";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface KeywordResponsesCardProps {
  rows: readonly SmsKeywordResponse[];
  unavailableReason: string | null;
  loading: boolean;
  canEdit: boolean;
  pendingId: string | null;
  onToggle: (row: SmsKeywordResponse, enabled: boolean) => void;
}

function actionTone(
  action: SmsKeywordResponse["action"],
): "danger" | "neutral" {
  if (action === "opt_out") return "danger";
  return "neutral";
}

export function KeywordResponsesCard({
  rows,
  unavailableReason,
  loading,
  canEdit,
  pendingId,
  onToggle,
}: KeywordResponsesCardProps) {
  const { t } = useTheme();
  const enabledOptOut = rows.filter(
    (row) => row.action === "opt_out" && row.enabled,
  ).length;

  const caption = unavailableReason
    ? unavailableReason
    : loading
      ? "Reading keyword state rules…"
      : rows.length === 0
        ? "No custom keyword state rules are configured."
        : `${plural(rows.length, "stored custom keyword")} · ${enabledOptOut} opt-out ${enabledOptOut === 1 ? "rule" : "rules"} on`;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 10,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.bold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Keyword state rules
      </Text>
      <Text
        accessibilityRole="summary"
        {...typeCap("bodySmall")}
        style={{
          color: unavailableReason ? t.fgMuted : t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {caption}
      </Text>

      {unavailableReason || loading
        ? null
        : rows.map((row) => (
            <KeywordRow
              key={row.id}
              row={row}
              canEdit={canEdit}
              busy={pendingId === row.id}
              onToggle={onToggle}
            />
          ))}

      {unavailableReason ? null : (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
          }}
        >
          {`STOP/START/UNSTOP consent state is provider-authoritative. HELP confirmation and tenant auto-replies are release-held (sms_auto_reply_dispatch_release_held). Reserved words (${RESERVED_SMS_KEYWORDS.join(", ")}) can't be overridden here.`}
        </Text>
      )}
    </View>
  );
}

function KeywordRow({
  row,
  canEdit,
  busy,
  onToggle,
}: {
  row: SmsKeywordResponse;
  canEdit: boolean;
  busy: boolean;
  onToggle: (row: SmsKeywordResponse, enabled: boolean) => void;
}) {
  const { t } = useTheme();
  const body = row.responseBody.trim();
  const mutableOptOut = canToggleSmsKeywordResponse(row);

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <View
          accessible
          accessibilityLabel={`${row.keyword}. ${keywordActionLabel(row.action)}. ${
            mutableOptOut
              ? row.enabled
                ? "Opt-out matching on"
                : "Opt-out matching off"
              : "Stored configuration is held and cannot be enabled"
          }.`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
            numberOfLines={1}
          >
            {row.keyword}
          </Text>
          <Pill
            label={keywordActionLabel(row.action)}
            tone={actionTone(row.action)}
          />
          {mutableOptOut && row.enabled ? (
            <Pill label="Opt-out matching on" tone="danger" />
          ) : (
            <Pill label="Held / off" tone="neutral" />
          )}
        </View>
        <Text
          {...typeCap("caption")}
          style={{
            color: body ? t.fgMuted : t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={3}
        >
          {body || "— no stored response text"}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {row.action === "opt_out"
            ? `The stored match rule is ${row.enabled ? "enabled" : "disabled"}. Verified provider callback ingestion and automatic confirmation dispatch remain release-held.`
            : "Stored reply-only configuration has no outbound effect while sms_auto_reply_dispatch_release_held is active."}
        </Text>
      </View>
      {canEdit && mutableOptOut ? (
        <Switch
          value={row.enabled}
          disabled={busy}
          onValueChange={(next) => void onToggle(row, next)}
          accessibilityRole="switch"
          accessibilityLabel={`${row.keyword} opt-out state rule`}
          accessibilityHint={
            row.enabled
              ? "Stops this custom keyword from applying an opt-out state change"
              : "Allows this custom keyword to apply an opt-out state change"
          }
          accessibilityState={{ checked: row.enabled, disabled: busy }}
          trackColor={{ false: t.border, true: t.accent }}
        />
      ) : null}
    </View>
  );
}
