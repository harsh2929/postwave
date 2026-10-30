/**
 * HubSections — the two "what do I do about it" lists on the Deliverability
 * Hub: threshold breaches, and blocklist listings.
 *
 * Both are rendered as cards rather than rows because each one carries a
 * sentence of remediation copy; a one-line row would truncate exactly the part
 * the operator needs. Severity is a Pill (a word) plus a tone, never a tone
 * alone.
 */
import { router } from "expo-router";
import { Linking, Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { breachFixTarget } from "@/lib/deliverabilityHubView";
import {
  blocklistTierLabel,
  blocklistTone,
  severityTone,
  type SignalTone,
} from "@/lib/deliverabilitySignals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function pillTone(
  tone: SignalTone,
): "neutral" | "success" | "warning" | "danger" | "info" {
  return tone === "neutral" ? "neutral" : tone;
}

export interface BreachCardProps {
  breach: {
    code: string;
    severity: string;
    title: string;
    detail: string;
    /** Optional so hub snapshots written by an older build still render. */
    fixLabel?: string;
    fixHref?: string;
    fixSection?: string;
  };
  /** Surfaced when the server's external fix link cannot be opened. */
  onFixFailed?: ((message: string) => void) | undefined;
}

export function BreachCard({ breach, onFixFailed }: BreachCardProps) {
  const { t } = useTheme();
  const tone = severityTone(breach.severity);
  const severityWord = breach.severity.trim() || "info";
  // The server-supplied next step. Null when the server sent none, when the
  // slug has no mobile owner, or when the target is this very screen — a
  // wrong or circular CTA is worse than none (see breachFixTarget).
  const fix = breachFixTarget({
    fixLabel: breach.fixLabel ?? "",
    ...(breach.fixHref !== undefined ? { fixHref: breach.fixHref } : {}),
    ...(breach.fixSection !== undefined ? { fixSection: breach.fixSection } : {}),
  });
  return (
    <View
      accessible
      accessibilityLabel={`${severityWord}: ${breach.title}. ${breach.detail}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        gap: 6,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Pill label={severityWord} tone={pillTone(tone)} />
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {breach.title}
        </Text>
      </View>
      {breach.detail ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {breach.detail}
        </Text>
      ) : null}
      {fix ? (
        <Pressable
          onPress={() => {
            if (fix.kind === "href") {
              void Linking.openURL(fix.url).catch(() =>
                onFixFailed?.(`No app available to open ${fix.url}.`),
              );
            } else {
              router.push(fix.route as never);
            }
          }}
          accessibilityRole={fix.kind === "href" ? "link" : "button"}
          accessibilityLabel={
            fix.kind === "href"
              ? `${fix.label} in your browser`
              : fix.label
          }
          hitSlop={8}
          style={{
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 2,
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
            {fix.kind === "href" ? `${fix.label} ↗︎` : fix.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export interface BlocklistHitRow {
  id: string;
  listName: string;
  identifier: string;
  tier1: boolean;
  firstSeenAt: string;
  delistUrl: string;
  delistingStatus: string;
}

export interface BlocklistCardProps {
  hit: BlocklistHitRow;
  now?: number | undefined;
  onDelistFailed: (message: string) => void;
  /**
   * True when this row came from the hub's own copy of the listings, which
   * carries no `delist_url`. Without it an empty url is indistinguishable from
   * "this list has no removal form" — and asserting that about Spamhaus, which
   * does, is exactly the kind of confident wrong answer this cluster removed.
   */
  delistUnknown?: boolean | undefined;
}

export function BlocklistCard({
  hit,
  now,
  onDelistFailed,
  delistUnknown = false,
}: BlocklistCardProps) {
  const { t } = useTheme();
  const tone = blocklistTone(hit.tier1);
  const tier = blocklistTierLabel(hit.tier1);
  const seen = relativeTime(hit.firstSeenAt, now === undefined ? {} : { now });
  // The dedicated endpoint leaves `delisting_status` empty to mean "not
  // started"; the hub fallback simply does not carry the field, so the same
  // empty string must not be read as a statement about progress there.
  const status =
    hit.delistingStatus.trim() || (delistUnknown ? "unknown" : "Not started");
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        gap: 6,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${hit.identifier} listed on ${hit.listName}, ${tier}, first seen ${seen}. Delisting ${status}.`}
        style={{ gap: 4 }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Pill label={tier} tone={pillTone(tone)} />
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {hit.listName}
          </Text>
        </View>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={1}
        >
          {hit.identifier}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`First seen ${seen} · Delisting ${status}`}
        </Text>
      </View>
      {hit.delistUrl ? (
        <Pressable
          onPress={() => {
            void Linking.openURL(hit.delistUrl).catch(() =>
              onDelistFailed(`No app available to open ${hit.listName}.`),
            );
          }}
          accessibilityRole="link"
          accessibilityLabel={`Request delisting from ${hit.listName} in your browser`}
          hitSlop={8}
          style={{
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 2,
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
            Request delisting {"\u2197\uFE0E"}
          </Text>
        </Pressable>
      ) : (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {delistUnknown
            ? "The delisting link couldn't be loaded for this listing — open it on the web."
            : "This list has no self-service removal form — contact them directly."}
        </Text>
      )}
    </View>
  );
}
