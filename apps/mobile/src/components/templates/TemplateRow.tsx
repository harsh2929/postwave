/**
 * TemplateRow — one design in the campaign-template library.
 *
 * A library row has to answer, before any tap: what is this design called, what
 * would land in the inbox, where did it come from, whether anyone here has
 * actually used it — and, decisively, whether it can be used AT ALL.
 *
 * THE BLOCKED BADGE IS THE POINT. This catalogue mixes three populations: the
 * shared Moosewave gallery, the workspace's own approved designs, and the
 * reference library of competitor emails captured for inspiration (migration
 * 1748). Only the first two can produce anything; a reference row is refused by
 * the server with a 422 for both verbs. Rendering all three identically would
 * make a third of the list a set of buttons whose only outcome is an error, so
 * the refusal is stated on the row, in words, with the badge as reinforcement
 * rather than as the only signal (state is never colour-alone).
 *
 * USAGE COUNT IS ZERO, NOT MISSING. `usage_count` carries `omitempty`, so the
 * server drops it at zero — absence here genuinely means "nobody has used it",
 * which is a fact worth showing. `last_used_at` is the opposite: absent means
 * never, and never is rendered as words, not as a date.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { num, relativeTime } from "@/lib/format";
import {
  templateGoalLabel,
  templateOrigin,
  templatePreviewLine,
  type MobileTemplate,
} from "@/lib/templateCatalog";
import { templateActionGate } from "@/lib/templatePolicy";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface TemplateRowProps {
  template: MobileTemplate;
  onPress: (template: MobileTemplate) => void;
  /** Dims the row while one of its verbs is in flight. */
  busy?: boolean | undefined;
  /** `Date.now()` from the screen's ticker, so "used 3d ago" stays honest. */
  now?: number | undefined;
  /**
   * Toggles the per-user favourite. Omitted when the session can't write it
   * (offline), in which case the star is not rendered at all rather than
   * rendered as a control that silently does nothing.
   *
   * NOTE the two-endpoint shape: /favorite and /unfavorite are separate POST
   * routes, so the DIRECTION is part of the call — see api/campaignTemplates.
   */
  onToggleFavorite?: ((template: MobileTemplate) => void) | undefined;
  /**
   * Long-press adds/removes the row from the side-by-side compare shortlist
   * (the CampaignCompareSheet pattern). Omitted → no long-press behaviour.
   */
  onLongPress?: ((template: MobileTemplate) => void) | undefined;
  /** True while the row is in the compare shortlist — drawn as accent chrome. */
  compareSelected?: boolean | undefined;
}

function usagePhrase(template: MobileTemplate, now: number | undefined): string {
  if (template.usageCount === 0) return "Never used";
  const times = template.usageCount === 1 ? "Used once" : `Used ${num(template.usageCount)} times`;
  if (!template.lastUsedAt) return times;
  return `${times} · last ${relativeTime(template.lastUsedAt, now === undefined ? {} : { now })}`;
}

function TemplateRowImpl({
  template,
  onPress,
  busy,
  now,
  onToggleFavorite,
  onLongPress,
  compareSelected,
}: TemplateRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const gate = templateActionGate(template);
  const preview = templatePreviewLine(template);
  const origin = templateOrigin(template);
  const usage = usagePhrase(template, now);
  const goal = template.goal ? templateGoalLabel(template.goal) : "";

  // The card chrome sits on a plain View, and the star is a SIBLING of the
  // tappable body rather than a child of it. Nesting one Pressable inside
  // another gives VoiceOver two overlapping targets for the same rectangle and
  // makes the outer label unreachable — src/lib/noNestedInteractiveControls
  // fails the build on it.
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor:
          compareSelected === true
            ? t.accent
            : gate.allowed
              ? t.borderSubtle
              : t.border,
        borderWidth: compareSelected === true ? 2 : 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        opacity: busy === true ? 0.55 : 1,
      }}
    >
      <Pressable
        onPress={() => onPress(template)}
        {...(onLongPress ? { onLongPress: () => onLongPress(template) } : {})}
        disabled={busy === true}
        accessibilityRole="button"
        accessibilityState={{
          disabled: busy === true,
          busy: busy === true,
          ...(compareSelected === undefined
            ? {}
            : { selected: compareSelected }),
        }}
        accessibilityLabel={[
          template.name,
          goal ? `${goal} template` : "No goal set",
          preview,
          origin,
          usage,
          gate.allowed ? "Ready to use" : gate.message,
        ].join(". ")}
        accessibilityHint={
          onLongPress
            ? "Opens the design to read its details and start a campaign from it. Long-press to add it to a side-by-side compare."
            : "Opens the design to read its details and start a campaign from it"
        }
        style={{ flex: 1, gap: 6, minHeight: 44 }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text
            numberOfLines={maxLinesAtScale(2, fontScale)}
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
              flexShrink: 1,
            }}
          >
            {template.name}
          </Text>
          {template.isFeatured ? <Pill label="Featured" tone="accent" /> : null}
        </View>

      <Text
        numberOfLines={maxLinesAtScale(2, fontScale)}
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {preview}
      </Text>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        {goal ? <Pill label={goal} tone="info" /> : null}
        {gate.allowed ? null : (
          <Pill
            label={gate.badge}
            tone="warning"
            accessibilityLabel={gate.message}
          />
        )}
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            flexShrink: 1,
          }}
        >
          {origin} · {usage}
        </Text>
        </View>
      </Pressable>

      {onToggleFavorite ? (
        <Pressable
          onPress={() => onToggleFavorite(template)}
          accessibilityRole="button"
          // Announced as WORDS in both states: a filled-vs-outline glyph is
          // the definition of state-by-appearance-alone, and this control's
          // whole meaning is its state.
          accessibilityLabel={
            template.isFavorited
              ? `Remove ${template.name} from your favourites`
              : `Add ${template.name} to your favourites`
          }
          accessibilityState={{ selected: template.isFavorited }}
          hitSlop={8}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            marginTop: -8,
            marginEnd: -8,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: template.isFavorited ? t.accent : t.fgSubtle,
              ...typeStyle("body"),
              fontFamily: FONT.regular,
            }}
          >
            {template.isFavorited ? "★" : "☆"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const TemplateRow = memo(TemplateRowImpl);
