/**
 * WebhookErrorsCard — is the bad news still arriving?
 *
 * A dead ESP event webhook silently stops bounce/complaint ingestion, and
 * every downstream rate then looks healthy precisely BECAUSE the failures
 * stopped being recorded. This card shows the last 7 days of failed webhook
 * deliveries plus failed DNS verifications — the two feeds whose silence
 * fakes good health.
 *
 * The empty state is a REAL all-clear (the endpoint answered); "couldn't
 * load" is rendered as its own sentence, never as an implied all-clear.
 */
import { Text, View } from "react-native";

import {
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import { useWebhookErrors } from "@/hooks/useDeliverabilityHubOps";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { webhookErrorsCaption } from "@/lib/deliverabilityOpsView";
import { transitionLabel } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { plural, relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const SHOWN_ROWS = 5;

export function WebhookErrorsCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const query = useWebhookErrors();
  const offline = !gate.enabled;
  const report = query.data;

  const body = offline
    ? "Webhook failures can't be checked offline."
    : query.isError
      ? "Webhook failures couldn't be loaded — ingestion may be broken without showing here."
      : !report
        ? "Checking event-webhook deliveries…"
        : webhookErrorsCaption(report);

  const rows = report ? report.items.slice(0, SHOWN_ROWS) : [];
  const broken = report ? report.failedVerifications.slice(0, SHOWN_ROWS) : [];

  return (
    <OpsCard>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <OpsCardTitle>Ingestion health</OpsCardTitle>
        {report && rows.length > 0 ? <Pill label="failing" tone="danger" /> : null}
      </View>
      <OpsCardBody {...(query.isError ? { role: "alert" as const } : {})}>
        {body}
      </OpsCardBody>
      {rows.map((row) => (
        <View
          key={row.id}
          accessible
          accessibilityLabel={`${row.event} webhook ${row.status}, ${plural(row.attemptCount, "attempt")}, last ${relativeTime(row.lastAttemptAt)}. ${row.error}`}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 8,
            gap: 2,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
            }}
            numberOfLines={1}
          >
            {row.url
              ? transitionLabel(row.event || "webhook", row.url)
              : row.event || "webhook"}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
            numberOfLines={2}
          >
            {`${row.status}${row.statusCode ? ` · HTTP ${row.statusCode}` : ""} · ${plural(row.attemptCount, "attempt")} · last ${relativeTime(row.lastAttemptAt)}${row.error ? ` · ${row.error}` : ""}`}
          </Text>
        </View>
      ))}
      {broken.length > 0 ? (
        <View style={{ gap: 6 }}>
          <OpsCardBody>
            {`${plural(broken.length, "sending identity", "sending identities")} with failing DNS verification:`}
          </OpsCardBody>
          {broken.map((row) => (
            <Text
              key={row.identityId || row.domain}
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={2}
            >
              {`${row.domain} · ${row.verifyState}${row.lastError ? ` · ${row.lastError}` : ""}`}
            </Text>
          ))}
        </View>
      ) : null}
    </OpsCard>
  );
}
