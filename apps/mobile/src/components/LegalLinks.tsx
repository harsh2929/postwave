import * as Linking from "expo-linking";
import { View } from "react-native";

import { TextLink } from "@/components/TextLink";
import { LEGAL_URLS } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";

type LegalLinkKey = keyof typeof LEGAL_URLS;

const DEFAULT_LINKS: readonly { key: LegalLinkKey; label: string }[] = [
  { key: "privacy", label: "Privacy" },
  { key: "terms", label: "Terms" },
  { key: "support", label: "Support" },
];

export function LegalLinks({
  links = DEFAULT_LINKS,
  align = "center",
}: {
  links?: readonly { key: LegalLinkKey; label: string }[];
  align?: "center" | "left";
}) {
  const { t } = useTheme();

  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 14,
        justifyContent: align === "center" ? "center" : "flex-start",
      }}
    >
      {links.map((link) => (
        <TextLink
          key={link.key}
          onPress={() => void Linking.openURL(LEGAL_URLS[link.key])}
          textStyle={{
            color: t.accent,
            fontSize: 12,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {link.label}
        </TextLink>
      ))}
    </View>
  );
}
