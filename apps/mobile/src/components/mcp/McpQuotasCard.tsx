/**
 * McpQuotasCard — per-tool daily quota utilisation, read-only.
 *
 * THE QUESTION IT ANSWERS: "is an agent about to hit its daily cap?" — one
 * bar per configured tool, today's recorder count against the configured
 * threshold, and the UTC time the count resets.
 *
 * WHAT IT REFUSES TO CLAIM. The server labels this payload
 * `enforcementMode: advisory_unverified`, `authoritative: false`, and carries
 * a `releaseHold` code (quotas.go:201-207); the quota middleware is
 * observation-only (apikeycalls.go:743). So a full bar is a full bar, not a
 * blocked agent, and the card prints the server's three words verbatim rather
 * than a green "enforced" badge. A row with no threshold renders an empty
 * track and "no configured threshold row" — never "unlimited", because no row
 * can prove that policy (desktop QuotasCard, MCP.tsx:1690-1700).
 *
 * READ-ONLY ON PURPOSE. PUT/DELETE answer 503 on this server, and the desktop
 * has no edit UI either; view parity is the whole gap. A 503 on the READ —
 * should the hold ever widen — is rendered in the server's own sentence, with
 * no Retry button, because a hold is a product boundary rather than a fault.
 *
 * Every figure is spoken once, in full, on the bar's own progressbar label.
 */
import { Text, View } from "react-native";

import { mcpReleaseHold } from "@/api/mcpQuotas";
import { Card } from "@/components/Card";
import { QueryStates } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { useMcpQuotas } from "@/hooks/useMcpQuotas";
import { FONT } from "@/lib/fonts";
import { dateTime, money } from "@/lib/format";
import {
  mcpQuotaCostUnits,
  mcpQuotaReading,
  mcpQuotaResetAt,
  mcpQuotaServerStance,
  mcpQuotaSummary,
  type McpToolQuota,
} from "@/lib/mcpQuotas";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TRACK_HEIGHT = 8;

export interface McpQuotasCardProps {
  allowed: boolean;
  gate: { enabled: boolean };
  /** Injectable clock so the reset time is deterministic under test. */
  now?: number;
}

export function McpQuotasCard({ allowed, gate, now }: McpQuotasCardProps) {
  const { t } = useTheme();
  const quotas = useMcpQuotas(allowed);
  const held = mcpReleaseHold(quotas.error);
  // `?? []` would let a truthy non-array from the wire reach `.map` below.
  const quotaRows = quotas.data?.quotas;
  const rows = Array.isArray(quotaRows) ? quotaRows : [];
  const resetAt = dateTime(mcpQuotaResetAt(now ?? Date.now()), "");

  return (
    <>
      <SectionLabel subtitle="Configured observations and recorded usage — not authoritative enforcement, billing, or proof that excess calls were blocked.">
        Provisional quota signals
      </SectionLabel>
      {held ? (
        <Card accessible accessibilityLabel={`Release-held on this server. ${held.message}`}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
          >
            Release-held on this server
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginTop: 4,
            }}
          >
            {held.message}
          </Text>
          {held.code ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 6,
              }}
            >
              {held.code}
            </Text>
          ) : null}
        </Card>
      ) : (
        <QueryStates
          query={quotas}
          gate={gate}
          isEmpty={rows.length === 0}
          offlineMessage="Quota observations need a connection. Reconnect and pull to refresh — this is not the same as no quota being configured."
          skeleton={<SkeletonCard lines={3} />}
          empty={{
            title: "No configured per-tool quota observations",
            description:
              "The response contains no configured per-tool quota observations. Absence does not establish an enforced unlimited policy.",
          }}
        >
          <Card>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
            >
              Observed quota configuration · UTC day
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                marginTop: 4,
              }}
            >
              {`Usage resets at ${resetAt}. These counters and tool labels are caller-influenced, asynchronous observations. They do not prove that a threshold was enforced, that an excess call was blocked, or that every call was counted.`}
            </Text>
            {rows.map((quota) => (
              <QuotaBar key={quota.toolName} quota={quota} />
            ))}
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 12,
              }}
            >
              {mcpQuotaSummary(rows.length)}
            </Text>
            {quotas.data ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                  marginTop: 4,
                }}
              >
                {`Server stance: ${mcpQuotaServerStance(quotas.data)}`}
              </Text>
            ) : null}
          </Card>
        </QueryStates>
      )}
    </>
  );
}

function QuotaBar({ quota }: { quota: McpToolQuota }) {
  const { t } = useTheme();
  const reading = mcpQuotaReading(quota);
  const fill =
    reading.tone === "danger"
      ? t.danger
      : reading.tone === "warning"
        ? t.warning
        : reading.tone === "success"
          ? t.success
          : t.fgMuted;
  const percent =
    reading.fraction === null ? null : Math.round(reading.fraction * 100);
  const estimate = `configured estimate ${money(
    mcpQuotaCostUnits(quota.estimatedCostMicros),
    "USD",
    { cents: true },
  )} per call`;
  const figure =
    reading.utilization === null
      ? "no threshold"
      : `${reading.utilization.toFixed(1)}%`;

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={quota.toolName}
      {...(percent === null
        ? {}
        : { accessibilityValue: { min: 0, max: 100, now: percent } })}
      accessibilityHint={[reading.headline, reading.standing, reading.distance, estimate]
        .filter(Boolean)
        .join(". ")}
      style={{ marginTop: 14, gap: 6 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("label")}
          selectable
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontFamily: FONT.medium,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {quota.toolName}
        </Text>
        <Text
          {...typeCap("numeric")}
          style={{
            color: reading.tone === "neutral" ? t.fgMuted : t.fg,
            ...typeStyle("numeric"),
            fontFamily: FONT.semibold,
            fontVariant: ["tabular-nums"],
          }}
        >
          {figure}
        </Text>
      </View>
      <View
        style={{
          height: TRACK_HEIGHT,
          borderRadius: TRACK_HEIGHT / 2,
          backgroundColor: t.bgSubtle,
          overflow: "hidden",
        }}
      >
        {percent === null ? null : (
          <View
            style={{
              width: `${Math.max(percent, 2)}%`,
              height: "100%",
              backgroundColor: fill,
              borderRadius: TRACK_HEIGHT / 2,
            }}
          />
        )}
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {reading.standing
          ? `${reading.headline} · ${reading.standing}`
          : reading.headline}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {`${reading.distance} · ${estimate}`}
      </Text>
    </View>
  );
}
