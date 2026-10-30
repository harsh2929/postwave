/**
 * DomainRowCard — one sending domain with its real health signals.
 *
 * Mobile used to render a single boolean pill ("verified" / "pending"), which
 * cannot distinguish "DKIM published, DMARC missing" from "nothing published"
 * — the difference between five more minutes and a registrar edit. Desktop
 * fetches DNS health AND sender reputation as parallel side-signals and
 * decorates every row; this does the same.
 *
 * Desktop's D10 lesson is honoured by the caller: when a side fetch FAILS the
 * row shows "—" and the screen shows a notice, never an implied "not
 * configured".
 */
import { Pressable, Text, View, type TextStyle } from "react-native";

import { Pill } from "@/components/Pill";
import { DnsRecordCard } from "@/components/deliverability/DnsRecordCard";
import { isDkimRecord } from "@/lib/contextualHints";
import { DomainReputationTrend } from "@/components/deliverability/DomainReputationTrend";
import type { CustomDomain } from "@/hooks/useDomainOps";
import { FONT } from "@/lib/fonts";
import {
  dnsMechanisms,
  gradeTone,
  type DnsHealthRow,
} from "@/lib/deliverabilitySignals";
import { date, num, plural, relativeTime } from "@/lib/format";
import type { DomainReputation } from "@/lib/suppressionContracts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DomainRowCardProps {
  row: CustomDomain;
  health: DnsHealthRow | undefined;
  /** True when the DNS-health side fetch failed — render "—", not "missing". */
  healthUnknown: boolean;
  reputation: DomainReputation | undefined;
  expanded: boolean;
  onToggleRecords: () => void;
  onVerify: () => void;
  verifying: boolean;
  onShareRecord: (record: {
    type: string;
    name: string;
    value: string;
  }) => void;
  now: number;
}

export function DomainRowCard({
  row,
  health,
  healthUnknown,
  reputation,
  expanded,
  onToggleRecords,
  onVerify,
  verifying,
  onShareRecord,
  now,
}: DomainRowCardProps) {
  const { t } = useTheme();
  const mechanisms = dnsMechanisms(health);
  const recordCount = row.dnsRecords.length;
  const purposeLabel = row.purpose
    ? row.purpose.charAt(0).toUpperCase() + row.purpose.slice(1)
    : "—";
  const when = row.verifiedAt
    ? `Verified ${relativeTime(row.verifiedAt, { now })}`
    : row.createdAt
      ? `Added ${relativeTime(row.createdAt, { now })}`
      : null;
  const whenExact = row.verifiedAt
    ? `Verified ${date(row.verifiedAt)}`
    : row.createdAt
      ? `Added ${date(row.createdAt)}`
      : "";

  // Annotated as TextStyle so `fontVariant` narrows to FontVariant[]. Without
  // the annotation TS widens it to string[]; with `as const` it becomes a
  // readonly tuple. Both are rejected by RN's mutable FontVariant[].
  const meta: TextStyle = {
    color: t.fgSubtle,
    ...typeStyle("caption"),
    fontFamily: FONT.regular,
    fontVariant: ["tabular-nums"],
  };

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
      }}
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
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flex: 1,
          }}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {row.domain}
        </Text>
        <Pill
          label={row.verified ? "verified" : "pending"}
          tone={row.verified ? "success" : "warning"}
        />
      </View>

      {/* Per-mechanism DNS state. The pills lean on a glyph plus colour, so
          the row is grouped and given ONE spoken sentence with real words. */}
      <View
        accessible
        accessibilityLabel={
          healthUnknown
            ? `DNS health for ${row.domain} could not be loaded`
            : `${mechanisms.map((m) => m.accessibilityLabel).join(", ")}` +
              (reputation
                ? `. Reputation ${reputation.grade || "score"} ${reputation.score}`
                : "")
        }
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        {healthUnknown
          ? (["SPF", "DKIM", "DMARC"] as const).map((key) => (
              <Pill key={key} label={`${key} —`} tone="neutral" />
            ))
          : mechanisms.map((mechanism) => (
              <Pill
                key={mechanism.key}
                label={`${mechanism.key} ${mechanism.ok ? "✓" : "✗"}`}
                tone={mechanism.tone === "success" ? "success" : "danger"}
              />
            ))}
        {reputation ? (
          <Pill
            label={`${reputation.grade || "Score"} ${num(reputation.score)}`}
            tone={gradeTone(reputation.grade)}
          />
        ) : null}
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        <Pill label={purposeLabel} tone="neutral" />
        {recordCount > 0 ? (
          <Text {...typeCap("caption")} style={meta}>
            {plural(recordCount, "record")}
          </Text>
        ) : null}
        {when ? (
          <Text
            {...typeCap("caption")}
            accessibilityLabel={whenExact}
            style={meta}
          >
            {when}
          </Text>
        ) : null}
        {health?.is_stale ? (
          <Text {...typeCap("caption")} style={meta}>
            {health.last_attempt_at
              ? `checked ${relativeTime(health.last_attempt_at, { now })} · stale`
              : "check overdue"}
          </Text>
        ) : null}
      </View>

      <View
        style={{
          flexDirection: "row",
          gap: 8,
          marginTop: 12,
          flexWrap: "wrap",
        }}
      >
        <Pressable
          onPress={onVerify}
          disabled={verifying}
          accessibilityRole="button"
          accessibilityLabel={`Re-verify ${row.domain}`}
          accessibilityState={{ disabled: verifying, busy: verifying }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 10,
            backgroundColor: t.accent,
            opacity: verifying ? 0.85 : 1,
          }}
        >
          <Text
            {...typeCap("control")}
            importantForAccessibility="no"
            style={{
              color: t.accentFg,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {verifying ? "Checking…" : "Re-verify"}
          </Text>
        </Pressable>
        {recordCount > 0 ? (
          <Pressable
            onPress={onToggleRecords}
            accessibilityRole="button"
            accessibilityLabel={
              expanded
                ? `Hide DNS records for ${row.domain}`
                : `Show ${recordCount} DNS records for ${row.domain}`
            }
            accessibilityState={{ expanded }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
            }}
          >
            <Text
              {...typeCap("control")}
              importantForAccessibility="no"
              style={{
                color: t.fg,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {expanded ? "Hide DNS" : "DNS records"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {expanded ? (
        <View style={{ marginTop: 10, gap: 10 }}>
          {/* The trend BEHIND the snapshot grade above. Armed by this
              expansion, so the list never fans out a history read per row. */}
          <DomainReputationTrend domain={row.domain} armed={expanded} />
          {row.dnsRecords.map((record, index) => (
            <DnsRecordCard
              key={`${record.type}-${record.name}-${index}`}
              record={record}
              domain={row.domain}
              onShare={onShareRecord}
              {...(isDkimRecord(record)
                ? { hintKey: "sending-identity.dkim" }
                : {})}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
