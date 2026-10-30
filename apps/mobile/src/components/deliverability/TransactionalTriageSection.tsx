/**
 * TransactionalTriageSection — transactional sends nobody can vouch for.
 *
 * ASSURE#7: the platform grew a Resend-parity public send surface and no client
 * renders what it sent. GET /api/v1/emails is `viewer` + reviewed and had no
 * caller anywhere.
 *
 * This shows the UNKNOWN slice only, which is the handler's own framing: it
 * documents `?attempt_state=unknown` as "the triage surface for sends whose
 * provider outcome could not be established", adding that without a way to list
 * them, "surfaced for a human rather than guessed at" is a claim about a log line.
 *
 * A full send log is a desk artefact. An unresolved outcome is a page — and it is
 * distinct from a REJECTION, which is a known bad outcome the suppression
 * machinery already acts on.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { useUnresolvedTransactionalSends } from "@/hooks/useTransactionalLog";
import { FONT } from "@/lib/fonts";
import { transactionalTriageSummary } from "@/lib/transactionalLog";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function TransactionalTriageSection() {
  const { t } = useTheme();
  const query = useUnresolvedTransactionalSends();
  const rows = Array.isArray(query.data) ? query.data : [];
  // Nothing unresolved is the common case, and a green banner for it would be
  // noise on a screen already dense with real signals.
  if (rows.length === 0) return null;

  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
          }}
        >
          Unconfirmed transactional sends
        </Text>
        <Pill label={String(rows.length)} tone="warning" />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {transactionalTriageSummary(rows)}
      </Text>
      {rows.map((send) => (
        <View
          key={send.id}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
            gap: 2,
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
            {send.subject}
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
            {send.to}
            {send.createdAt ? ` · ${send.createdAt}` : ""}
            {send.lastError ? ` · ${send.lastError}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}
