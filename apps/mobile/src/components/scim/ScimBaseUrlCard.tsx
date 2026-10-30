/**
 * ScimBaseUrlCard — the value an IdP setup screen asks for.
 *
 * Configuring Okta/Entra SCIM needs exactly two strings: the base URL and a
 * bearer token. The app showed neither, so the one moment the mobile SCIM
 * screen could have been useful during an integration call — reading the
 * tenant endpoint out loud — it could not do.
 *
 * The path is the server's own mount point (`/scim/v2/*`, registered in
 * apps/api/internal/scim/scim.go), joined onto the workspace's configured
 * API base URL. The text is selectable AND shareable, because this app has
 * no clipboard dependency and a share sheet that claims to "copy" would be
 * lying to VoiceOver.
 */
import { Pressable, Share, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Join the API base URL onto the server's SCIM mount point. */
export function scimBaseUrl(baseUrl: string | null | undefined): string | null {
  const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return `${trimmed}/scim/v2`;
}

export function ScimBaseUrlCard({
  baseUrl,
}: {
  baseUrl: string | null | undefined;
}) {
  const { t } = useTheme();
  const url = scimBaseUrl(baseUrl);
  if (!url) return null;
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
        gap: 6,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        SCIM base URL
      </Text>
      {/* `mono`: a value the reader copies or dictates verbatim during an IdP
          setup call — it must not reflow mid-path as the text size grows. */}
      <Text
        selectable
        accessibilityLabel={`SCIM base URL, ${url}`}
        {...typeCap("mono")}
        style={{
          color: t.fg,
          ...typeStyle("mono"),
          fontFamily: "Menlo",
        }}
      >
        {url}
      </Text>
      <Pressable
        onPress={() => {
          void Share.share({ message: url }).catch(() => {
            /* dismissed */
          });
        }}
        accessibilityRole="button"
        accessibilityLabel="Share the SCIM base URL"
        accessibilityHint="Opens the system share sheet"
        hitSlop={8}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Share URL
        </Text>
      </Pressable>
    </View>
  );
}
