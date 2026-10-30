/**
 * The stored audit-portal branding projection for this workspace.
 *
 * Lifted out of `app/(tabs)/agency.tsx`. The state it reports is never carried
 * by colour alone: the swatch is decorative (and only renders for a colour that
 * passed `normalizeHexColor`, because RN throws on a malformed colour string
 * rather than ignoring it), while "enabled" / "standard" is a labelled Pill.
 */
import { Text, View } from "react-native";

import { card, normalizeHexColor } from "@/components/agency/agencyCardStyle";
import { Pill } from "@/components/Pill";
import type { MobileAgencyBranding } from "@/api/agencyReads";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function BrandingCard({
  branding,
}: {
  branding: MobileAgencyBranding | null;
}) {
  const { t } = useTheme();
  if (branding === null) {
    return (
      <View
        accessible
        accessibilityLabel="Branding unavailable. No branding settings were loaded."
        style={card(t)}
      >
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontFamily: FONT.semibold,
          }}
        >
          Branding unavailable
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
          No branding settings were loaded, so the platform default is not being
          inferred.
        </Text>
      </View>
    );
  }
  const enabled = branding.whitelabel_enabled;
  const color = normalizeHexColor(branding.primary_color);

  return (
    <View style={card(t)}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {color ? (
          <View
            accessibilityLabel={`Primary brand colour ${color}`}
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              backgroundColor: color,
              borderWidth: 1,
              borderColor: t.borderSubtle,
            }}
          />
        ) : null}
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("heading")}
            style={{
              color: t.fg,
              ...typeStyle("heading"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
            numberOfLines={1}
          >
            {branding.brand_name || "No stored brand name"}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
          >
            Stored audit-portal draft
          </Text>
        </View>
        <Pill
          label={enabled ? "stored flag on" : "stored flag off"}
          tone="neutral"
        />
      </View>
      <View style={{ marginTop: 10, gap: 5 }}>
        <BrandingRow
          label="Primary colour"
          value={branding.primary_color || "Not set"}
        />
        <BrandingRow
          label="Logo source"
          value={branding.logo_url || "Not set"}
          lines={2}
        />
        <BrandingRow
          label="Support email"
          value={branding.support_email || "Not set"}
        />
        <BrandingRow
          label="Custom host"
          value={
            branding.custom_domain
              ? `${branding.custom_domain} · unpublished`
              : "Not set"
          }
        />
        <BrandingRow
          label="Legal entity"
          value={
            branding.legal_entity
              ? `${branding.legal_entity} · unpublished`
              : "Not set"
          }
          lines={2}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 10,
        }}
      >
        Stored values only. Audit-portal publication and custom-host routing are
        release-held; workspace, preference-center, archive, and subscriber
        surfaces are separate and are not described by this card.
      </Text>
      <Pill label="Publishing held" tone="neutral" />
    </View>
  );
}

function BrandingRow({
  label,
  value,
  lines = 1,
}: {
  label: string;
  value: string;
  lines?: number;
}) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          width: 92,
          fontFamily: FONT.regular,
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
          fontFamily: FONT.regular,
        }}
        numberOfLines={lines}
      >
        {value}
      </Text>
    </View>
  );
}
