/**
 * VoiceFingerprint — the measured half of the Voice tab.
 *
 * The server computes eight sections (stylistic, vocabulary, structural,
 * tonal, persona, representative samples, per-source stats, semantic
 * signature). Mobile rendered two of them, collapsed into at most three
 * adjectives, and discarded the rest on arrival. This card draws the parts a
 * writer can actually act on.
 *
 * Accessibility rules applied throughout:
 *   - a bar's WIDTH is invisible to VoiceOver, so every axis carries an exact
 *     spoken value AND a word for which end of the axis it sits at;
 *   - colour is never the only signal — every coloured element is labelled;
 *   - the sample passages are `selectable` so the text can be copied without a
 *     bespoke clipboard affordance.
 */
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import type {
  VoiceAxis,
  VoiceSample,
  VoiceSourceLine,
  VoiceStatLine,
} from "@/lib/voiceProfile";

export interface VoiceFingerprintProps {
  axes: VoiceAxis[];
  stats: VoiceStatLine[];
  terms: string[];
  samples: VoiceSample[];
  sources: VoiceSourceLine[];
  onRebuild?: (() => void) | undefined;
  rebuilding?: boolean;
  /** True once a rebuild has been accepted this session. */
  rebuildQueued?: boolean;
}

export function VoiceFingerprint({
  axes,
  stats,
  terms,
  samples,
  sources,
  onRebuild,
  rebuilding = false,
  rebuildQueued = false,
}: VoiceFingerprintProps) {
  const { t } = useTheme();
  const empty =
    axes.length === 0 &&
    stats.length === 0 &&
    terms.length === 0 &&
    samples.length === 0 &&
    sources.length === 0;
  if (empty && !onRebuild) return null;

  return (
    <Card style={{ gap: 14 }}>
      <SectionTitle>Measured fingerprint</SectionTitle>

      {axes.length > 0 ? (
        <View style={{ gap: 8 }}>
          {axes.map((axis) => (
            <AxisBar key={axis.key} axis={axis} />
          ))}
        </View>
      ) : null}

      {stats.length > 0 ? (
        <View style={{ gap: 6 }}>
          <SubLabel>How you write</SubLabel>
          {stats.map((stat) => (
            <View
              key={stat.key}
              accessible
              accessibilityLabel={`${stat.label}: ${stat.value}`}
              style={{ flexDirection: "row", gap: 12 }}
            >
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                  flex: 1,
                }}
              >
                {stat.label}
              </Text>
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fg,
                  ...typeStyle("label"),
                  fontFamily: FONT.semibold,
                  fontWeight: "600",
                }}
              >
                {stat.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {terms.length > 0 ? (
        <View style={{ gap: 6 }}>
          <SubLabel>Words that are distinctly yours</SubLabel>
          <View
            accessible
            accessibilityLabel={`Distinctive terms: ${terms.join(", ")}`}
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
          >
            {terms.map((term) => (
              <View
                key={term}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: t.borderSubtle,
                  backgroundColor: t.bgSubtle,
                }}
              >
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.fg,
                    ...typeStyle("label"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {term}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {samples.length > 0 ? (
        <View style={{ gap: 8 }}>
          <SubLabel>Passages that sound most like you</SubLabel>
          {samples.map((sample) => (
            <View
              key={sample.key}
              style={{
                borderStartWidth: 3,
                borderStartColor: t.accent,
                paddingStart: 10,
                gap: 4,
              }}
            >
              <Text
                {...typeCap("bodySmall")}
                selectable
                numberOfLines={6}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {sample.text}
              </Text>
              {sample.sourceType ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  from {sample.sourceType}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {sources.length > 0 ? (
        <View style={{ gap: 6 }}>
          <SubLabel>Measured from</SubLabel>
          {sources.map((source) => (
            <Text
              {...typeCap("label")}
              key={source.key}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {source.label} · {source.detail}
            </Text>
          ))}
        </View>
      ) : null}

      {onRebuild ? (
        <Pressable
          onPress={onRebuild}
          disabled={rebuilding}
          accessibilityRole="button"
          accessibilityLabel="Rebuild voice profile from your latest sends and sources"
          accessibilityState={{ disabled: rebuilding, busy: rebuilding }}
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.bgSubtle,
            opacity: rebuilding ? 0.6 : 1,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {rebuilding
              ? "Starting rebuild…"
              : rebuildQueued
                ? "Rebuild again"
                : "Rebuild profile"}
          </Text>
        </Pressable>
      ) : null}
      {rebuildQueued && !rebuilding ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            textAlign: "center",
            fontFamily: FONT.regular,
          }}
        >
          A rebuild runs on the server. Pull down to refresh once it finishes.
        </Text>
      ) : null}
    </Card>
  );
}

function AxisBar({ axis }: { axis: VoiceAxis }) {
  const { t } = useTheme();
  const pct = `${Math.round(axis.value * 100)}%` as `${number}%`;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${axis.label}: ${axis.spoken}, reads as ${axis.reading}`}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: Math.round(axis.value * 100),
      }}
      style={{ gap: 4 }}
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            flex: 1,
          }}
        >
          {axis.label}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
            fontWeight: "600",
          }}
        >
          {axis.reading}
        </Text>
      </View>
      <View
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: t.bgSubtle,
          overflow: "hidden",
        }}
      >
        <View style={{ width: pct, height: 6, backgroundColor: t.accent }} />
      </View>
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("heading")}
      accessibilityRole="header"
      style={{
        color: t.fg,
        ...typeStyle("heading"),
        fontWeight: "500",
        fontFamily: FONT.medium,
      }}
    >
      {children}
    </Text>
  );
}

function SubLabel({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        letterSpacing: 0.4,
        textTransform: "uppercase",
        fontFamily: FONT.semibold,
        fontWeight: "600",
      }}
    >
      {children}
    </Text>
  );
}
