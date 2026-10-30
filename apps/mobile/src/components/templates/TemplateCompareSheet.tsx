/**
 * TemplateCompareSheet — 2..4 designs' stats, stacked for a phone (desktop
 * parity: TemplateComparePanel's side-by-side grid).
 *
 * STACKED, NOT SIDE-BY-SIDE, ON PURPOSE. Four columns of numbers on a phone
 * width is a squint; the comparison a phone can actually support is "read one
 * card, flick to the next" with the SAME row order on every card so a thumb
 * can hold position while the eye compares.
 *
 * `unavailable_identifiers` IS SAID, NEVER DROPPED: a compare that silently
 * omits one of the designs the operator picked would let a two-way tie
 * masquerade as the whole answer.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { FONT } from "@/lib/fonts";
import { EMDASH, date, num, percent } from "@/lib/format";
import {
  templateGoalLabel,
  templateOrigin,
  type MobileTemplate,
} from "@/lib/templateCatalog";
import type { TemplateCompareResult } from "@/lib/templateDiscovery";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface TemplateCompareSheetProps {
  visible: boolean;
  onClose: () => void;
  result: TemplateCompareResult | null;
  loading: boolean;
  failed: boolean;
}

function StatRow({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          width: 92,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          flex: 1,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function CompareCard({ template }: { template: MobileTemplate }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: t.border,
        borderRadius: 14,
        padding: 14,
        gap: 8,
        backgroundColor: t.surface,
      }}
    >
      <Text
        numberOfLines={2}
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
      >
        {template.name}
      </Text>
      <StatRow
        label="Goal"
        value={template.goal ? templateGoalLabel(template.goal) : EMDASH}
      />
      <StatRow label="Origin" value={templateOrigin(template)} />
      <StatRow
        label="Used"
        value={
          template.usageCount === 0
            ? "Never"
            : `${num(template.usageCount)}× · last ${date(template.lastUsedAt)}`
        }
      />
      <StatRow
        label="Quality"
        value={
          template.qualityScore === null
            ? EMDASH
            : percent(template.qualityScore, { digits: 0 })
        }
      />
      <StatRow
        label="Favourite"
        value={template.isFavorited ? "Yes" : "No"}
      />
    </View>
  );
}

export function TemplateCompareSheet(props: TemplateCompareSheetProps) {
  const { t } = useTheme();
  const items = props.result?.items ?? [];
  const unavailable = props.result?.unavailable ?? [];

  return (
    <ReducedMotionModal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingVertical: 10,
          }}
        >
          <Text
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.semibold,
            }}
          >
            Compare designs
          </Text>
          <Pressable
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close the comparison"
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: 24,
            gap: 12,
          }}
        >
          {props.loading ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              Comparing…
            </Text>
          ) : props.failed ? (
            <Text
              accessibilityRole="alert"
              {...typeCap("bodySmall")}
              style={{
                color: t.danger,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              Couldn&apos;t load the comparison. Close this sheet and try
              again.
            </Text>
          ) : (
            <>
              {unavailable.length > 0 ? (
                <Text
                  accessibilityRole="alert"
                  {...typeCap("caption")}
                  style={{
                    color: t.warning,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {unavailable.length === 1
                    ? "One selected design couldn't be resolved and is missing from this comparison."
                    : `${unavailable.length} selected designs couldn't be resolved and are missing from this comparison.`}
                </Text>
              ) : null}
              {items.map((template) => (
                <CompareCard key={template.id} template={template} />
              ))}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
