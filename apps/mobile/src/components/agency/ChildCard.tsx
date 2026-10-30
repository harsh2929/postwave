/** One read-only child-workspace projection. */
import { memo } from "react";
import { Pressable, Share, Text, View } from "react-native";

import type { MobileAgencyChild } from "@/api/agencyReads";
import {
  card,
  formatDate,
  formatMarkup,
} from "@/components/agency/agencyCardStyle";
import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ChildCardProps {
  child: MobileAgencyChild;
  expanded: boolean;
  /**
   * Takes the id rather than closing over the row, so the roster can hand
   * every card ONE stable callback and the memo below can hold (the
   * DmarcReportRow rationale): expanding one card must not re-render the rest.
   */
  onToggle: (id: string) => void;
}

function ChildCardImpl({ child, expanded, onToggle }: ChildCardProps) {
  const { t } = useTheme();
  const created = formatDate(child.created_at);
  const payerSetting =
    child.billing_mode === "parent" ? "Agency (stored)" : "Workspace (stored)";

  function onShare() {
    void Share.share(
      {
        message: `${child.name} (${child.slug})`,
        title: child.name,
      },
      { dialogTitle: `Child workspace ${child.slug}` },
    ).catch(() => {
      // Dismissing the native sheet is not an actionable failure.
    });
  }

  return (
    <View style={card(t)}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${expanded ? "Hide" : "Show"} stored details for ${child.name}`}
        onPress={() => onToggle(child.id)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
              numberOfLines={1}
            >
              {child.name}
            </Text>
            <Text
              {...typeCap("mono")}
              style={{
                color: t.fgMuted,
                ...typeStyle("mono"),
                marginTop: 2,
                fontFamily: "Menlo",
              }}
              numberOfLines={1}
            >
              {child.slug}
            </Text>
          </View>
          <Pill label={child.tier} tone="info" />
        </View>
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            marginTop: 10,
            flexWrap: "wrap",
          }}
        >
          <Pill label={payerSetting} tone="neutral" />
          <Pill
            label={`${formatMarkup(child.reseller_markup_bps)} stored markup`}
            tone="neutral"
          />
          <Pill
            label={`audit-branding draft ${child.whitelabel_enabled ? "on" : "off"}`}
            tone="neutral"
          />
        </View>
      </Pressable>

      {expanded ? (
        <View
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            marginTop: 10,
            paddingTop: 10,
          }}
        >
          <DetailRow label="Stored billing owner" value={payerSetting} />
          <DetailRow
            label="Stored markup"
            value={formatMarkup(child.reseller_markup_bps)}
          />
          <DetailRow
            label="Audit branding draft"
            value={child.whitelabel_enabled ? "Flag on" : "Flag off"}
          />
          {created ? <DetailRow label="Linked" value={created} /> : null}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 8,
            }}
          >
            Stored configuration only. No payer transfer, invoice estimate,
            branding publication, or lifecycle control is available here.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Share the identifier for ${child.name}`}
            onPress={onShare}
            style={{
              marginTop: 10,
              alignSelf: "flex-start",
              minHeight: 44,
              justifyContent: "center",
              paddingHorizontal: 14,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface,
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
              Share slug
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export const ChildCard = memo(ChildCardImpl);

function DetailRow({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{ flexDirection: "row", gap: 10, marginBottom: 5 }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          width: 124,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          flex: 1,
          fontFamily: FONT.medium,
        }}
      >
        {value}
      </Text>
    </View>
  );
}
