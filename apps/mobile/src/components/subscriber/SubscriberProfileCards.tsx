/**
 * Profile cards that render fields the detail GET already returns and the
 * mobile type boundary was throwing away.
 *
 *   - Details: name is promoted into the header elsewhere; this card
 *     carries country / language / locale / signup source.
 *   - Consent: the per-purpose consent vector, the consent source, the
 *     unsubscribe REASON (the single most common support question), and
 *     the detected jurisdiction.
 *
 * Everything here is presentational — no hook, no request. `useSubscriber`
 * already returns the whole object.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { FONT } from "@/lib/fonts";
import { date as fmtDate } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SubscriberProfileFields {
  locale?: string | null;
  language?: string | null;
  country?: string | null;
  region?: string | null;
  source_platform?: string | null;
  signup_ip?: string | null;
  consent_source?: string | null;
  consent_timestamp?: string | null;
  consent_email_marketing_at?: string | null;
  consent_sms_marketing_at?: string | null;
  consent_profiling_at?: string | null;
  consent_targeted_ads_at?: string | null;
  consent_ai_processing_at?: string | null;
  unsubscribe_reason?: string | null;
  detected_jurisdiction?: string | null;
  jurisdiction_reconfirm_required?: boolean | null;
}

const CONSENT_PURPOSES: readonly {
  key: keyof SubscriberProfileFields;
  label: string;
}[] = [
  { key: "consent_email_marketing_at", label: "Email marketing" },
  { key: "consent_sms_marketing_at", label: "SMS marketing" },
  { key: "consent_profiling_at", label: "Profiling" },
  { key: "consent_targeted_ads_at", label: "Targeted ads" },
  { key: "consent_ai_processing_at", label: "AI processing" },
];

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "flex-start",
        paddingVertical: 4,
        gap: 12,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      {/* No literal textAlign:'right' — React Native flips flexDirection
          under I18nManager.isRTL but never flips a hardcoded alignment. */}
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          flex: 1,
          fontFamily: FONT.regular,
        }}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

export function SubscriberDetailsCard({
  subscriber,
}: {
  subscriber: SubscriberProfileFields;
}) {
  const rows: { label: string; value: string }[] = [];
  const country = text(subscriber.country);
  const language = text(subscriber.language);
  const locale = text(subscriber.locale);
  const region = text(subscriber.region);
  const source = text(subscriber.source_platform);
  if (country) rows.push({ label: "Country", value: country });
  if (region) rows.push({ label: "Region", value: region });
  if (language) rows.push({ label: "Language", value: language });
  if (locale && locale !== language) {
    rows.push({ label: "Locale", value: locale });
  }
  if (source) rows.push({ label: "Signed up via", value: source });

  if (rows.length === 0) return null;
  return (
    <Card style={{ marginTop: 12 }}>
      <Label>Details</Label>
      <View style={{ marginTop: 4 }}>
        {rows.map((row) => (
          <DetailRow key={row.label} label={row.label} value={row.value} />
        ))}
      </View>
    </Card>
  );
}

export function SubscriberConsentCard({
  subscriber,
}: {
  subscriber: SubscriberProfileFields;
}) {
  const { t } = useTheme();
  const granted = CONSENT_PURPOSES.map((purpose) => ({
    ...purpose,
    at: text(subscriber[purpose.key]),
  }));
  const anyGrant = granted.some((g) => g.at);
  const consentSource = text(subscriber.consent_source);
  const consentAt = text(subscriber.consent_timestamp);
  const reason = text(subscriber.unsubscribe_reason);
  const jurisdiction = text(subscriber.detected_jurisdiction);

  if (!anyGrant && !consentSource && !consentAt && !reason && !jurisdiction) {
    return null;
  }

  return (
    <Card style={{ marginTop: 12 }}>
      <Label>Consent</Label>
      {anyGrant ? (
        <View style={{ marginTop: 8, gap: 6 }}>
          {granted.map((g) => (
            <View
              key={String(g.key)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              {/* Tone is never the only carrier: the pill's own text says
                  Granted or Not granted. */}
              <Pill
                label={g.at ? `${g.label} · Granted` : `${g.label} · Not granted`}
                tone={g.at ? "success" : "neutral"}
              />
              {g.at ? (
                <Text
                  {...typeCap("badgeSmall")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("badgeSmall"),
                    fontFamily: FONT.regular,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {fmtDate(g.at)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ marginTop: anyGrant ? 10 : 4 }}>
        {consentSource ? (
          <DetailRow label="Source" value={consentSource} />
        ) : null}
        {consentAt ? (
          <DetailRow label="Consented" value={fmtDate(consentAt)} />
        ) : null}
        {reason ? (
          <DetailRow label="Unsubscribe reason" value={reason} />
        ) : null}
        {jurisdiction ? (
          <DetailRow label="Detected jurisdiction" value={jurisdiction} />
        ) : null}
      </View>
      {subscriber.jurisdiction_reconfirm_required ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("label")}
          style={{
            color: t.warning,
            ...typeStyle("label"),
            marginTop: 8,
            fontFamily: FONT.semibold,
          }}
        >
          Jurisdiction changed — consent needs re-confirmation.
        </Text>
      ) : null}
    </Card>
  );
}
