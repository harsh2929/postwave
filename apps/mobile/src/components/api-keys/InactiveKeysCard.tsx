/**
 * InactiveKeysCard — dormant credentials, on the screen that can kill them.
 *
 * Sits at the top of the API-keys roster and follows the GpcSignalsCard
 * philosophy: render only when there is something to say. Zero inactive
 * keys renders NOTHING — not an empty box, not an all-clear line — because
 * an all-clear card trains people to skip the region where the real
 * warning will eventually appear. What it must never do is let a failed
 * read look like that silence, so a query error renders its own line with
 * a Retry — and a 403 reads as the permission rule it is.
 *
 * Every word the server authored is rendered verbatim: `severity` is the
 * badge text, `days_since_last_use` and `never_used` become the per-key
 * line, and the headline carries the server's threshold. The decision of
 * WHAT to render lives in lib/inactiveKeyAlerts (node-tested); this file
 * only paints it.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { useInactiveKeys } from "@/hooks/useInactiveKeys";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import {
  INACTIVE_KEYS_DESCRIPTION,
  INACTIVE_KEYS_TITLE,
  inactiveKeyCopy,
  inactiveKeySeverityTone,
  inactiveKeysCardView,
  type InactiveKeyAlert,
} from "@/lib/inactiveKeyAlerts";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function InactiveKeysCard() {
  const { t } = useTheme();
  const { mayRead, online, query } = useInactiveKeys();
  const view = inactiveKeysCardView({
    mayRead,
    online,
    isError: query.isError,
    error: query.error,
    data: query.data,
  });

  // Below admin, loading, offline, a clean report, or a payload never proven
  // to be the server's object: nothing to say, so nothing is drawn.
  if (view.kind === "hidden") return null;

  if (view.kind === "error") {
    return (
      <Shell t={t}>
        <Text
          {...typeCap("caption")}
          style={{
            color: view.denied ? t.fgMuted : t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          {view.message}
        </Text>
        {view.denied ? null : (
          // A role refusal will not change on a second attempt; a transport
          // failure might. Only the second earns a Retry, and it refetches
          // THIS query — the roster's pull-to-refresh does not reach it.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry checking key activity"
            onPress={() => void query.refetch()}
            hitSlop={8}
            style={{
              alignSelf: "flex-start",
              justifyContent: "center",
              minHeight: 44,
            }}
          >
            <Text
              {...typeCap("label")}
              style={{
                color: t.accent,
                ...typeStyle("label"),
                fontFamily: FONT.semibold,
              }}
            >
              Retry
            </Text>
          </Pressable>
        )}
      </Shell>
    );
  }

  return (
    <Shell t={t}>
      <Text
        // The count is the fact this card exists to surface — announced on
        // arrival, so a screen-reader user hears it before the roster.
        accessibilityRole="alert"
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.semibold,
          marginTop: 6,
        }}
      >
        {view.headline}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 4,
        }}
      >
        {INACTIVE_KEYS_DESCRIPTION}
      </Text>
      {view.keys.map((alert) => (
        <AlertRow key={alert.id} alert={alert} t={t} />
      ))}
    </Shell>
  );
}

function AlertRow({ alert, t }: { alert: InactiveKeyAlert; t: ThemeTokens }) {
  const label = alert.label || "(unlabeled)";
  const copy = inactiveKeyCopy(alert);
  const created = alert.createdAt ? `created ${date(alert.createdAt)}` : "";
  const detail = created ? `${copy} · ${created}` : copy;
  const spoken = `${label}, ${alert.severity}. ${copy}. Prefix ${
    alert.prefix || "unknown"
  }.${created ? ` ${created}.` : ""}`;
  return (
    <View
      accessible
      accessibilityLabel={spoken}
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        marginTop: 10,
        paddingTop: 10,
      }}
    >
      <View
        style={{
          alignItems: "center",
          flexDirection: "row",
          gap: 8,
          justifyContent: "space-between",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            flex: 1,
            fontFamily: FONT.semibold,
          }}
          numberOfLines={1}
        >
          {label}
        </Text>
        <Pill
          label={alert.severity}
          tone={inactiveKeySeverityTone(alert.severity)}
        />
      </View>
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("numeric"),
          fontFamily: "Menlo",
          marginTop: 4,
        }}
        numberOfLines={1}
      >
        {alert.prefix ? `${alert.prefix}…` : "(no prefix)"}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          marginTop: 4,
        }}
      >
        {detail}
      </Text>
    </View>
  );
}

/** The card chrome: kicker + card, matching the compliance banners. */
function Shell({
  children,
  t,
}: {
  children: React.ReactNode;
  t: ThemeTokens;
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Card>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          {INACTIVE_KEYS_TITLE}
        </Text>
        {children}
      </Card>
    </View>
  );
}
