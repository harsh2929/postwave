/**
 * PreferenceCenterThemePreview — an APPROXIMATION of the hosted preference
 * page, drawn in-app from the four theme fields.
 *
 * WHY IT IS NOT A WEBVIEW. The register's row suggested "preview could be a
 * WebView", and there is nothing to point one at. The hosted page is rendered
 * by a client from GET /api/public/preferences/{token} — a per-SUBSCRIBER,
 * expiring token (apps/api/internal/preferences/topics.go:130) — and the
 * operator surface exposes no preview URL and no rendered HTML. Loading an
 * arbitrary subscriber's live token from an operator's phone would also be the
 * wrong thing to do even if we had one. So this draws the four fields itself
 * and says so: the caption is part of the component, not decoration, because a
 * preview that is silently an approximation is a claim we cannot support.
 *
 * What it DOES model, and all it models: the logo, the primary colour behind
 * white button text (the pairing the contrast rule exists for), the footer
 * sentence, and whether the Moosewave badge shows. Layout, fonts, the topic list
 * and the frequency controls all come from the page itself.
 */
import { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  preferenceLogoUrlAccepted,
  preferenceThemeEffectiveColor,
  type PreferenceCenterTheme,
} from "@/lib/preferenceCenterTheme";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export const PREVIEW_DISCLAIMER =
  "Approximation, drawn in this app from the four saved fields. It is not a render of the hosted page — its layout, fonts, topic list and frequency controls come from the page itself.";

export function PreferenceCenterThemePreview({
  theme,
  verified,
}: {
  theme: PreferenceCenterTheme;
  /** False while the saved theme has not been read back from the server. */
  verified: boolean;
}) {
  const { t } = useTheme();
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = theme.logoUrl.trim();
  // Never point an <Image> at a URL the server itself would refuse: the
  // request would leave the device for a host we have already judged unsafe.
  const showLogo = logo !== "" && preferenceLogoUrlAccepted(logo);
  const primary = preferenceThemeEffectiveColor(theme);

  useEffect(() => {
    setLogoFailed(false);
  }, [logo]);

  return (
    <View
      accessible={false}
      accessibilityLabel="Preference-centre theme approximation"
      style={{
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <View style={{ backgroundColor: t.bgSubtle, padding: 12, gap: 10 }}>
        {showLogo && !logoFailed ? (
          <Image
            source={{ uri: logo }}
            onError={() => setLogoFailed(true)}
            resizeMode="contain"
            accessibilityLabel="Logo as the hosted page would load it"
            style={{ height: 32, width: "100%" }}
          />
        ) : (
          <Caption
            text={
              logo === ""
                ? "No logo configured."
                : logoFailed
                  ? "This URL did not load an image on this device."
                  : "This URL is not one the server accepts, so it is not previewed."
            }
          />
        )}

        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          Email preferences
        </Text>
        <Caption text="Choose which emails you'd like to receive from us." />

        <View
          style={{
            backgroundColor: primary,
            borderRadius: 8,
            paddingVertical: 10,
            paddingHorizontal: 14,
            alignItems: "center",
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              // White, exactly like the hosted page's button label — which is
              // why the contrast rule is measured against white and nothing else.
              color: "#FFFFFF",
              ...typeStyle("bodySmall"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            Save preferences
          </Text>
        </View>

        <Caption
          text={
            theme.footerText.trim() === ""
              ? "No footer text — the hosted page shows nothing here."
              : theme.footerText
          }
        />
        {theme.showPostwaveBadge ? <Caption text="Powered by Moosewave" /> : null}
      </View>

      <View
        style={{
          backgroundColor: t.surface,
          borderTopColor: t.borderSubtle,
          borderTopWidth: 1,
          padding: 10,
          gap: 4,
        }}
      >
        <Caption text={PREVIEW_DISCLAIMER} />
        {verified ? null : (
          <Caption text="Showing defaults: the saved theme has not been read back from the server yet." />
        )}
      </View>
    </View>
  );
}

function Caption({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
