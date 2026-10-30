/**
 * LandingPublicLinkCard — the page's public URL, or the reason there isn't one.
 *
 * THE LINK IS OFFERED ONLY WHEN IT RESOLVES. `Repo.PublicLandingPage` serves
 * `status = 'published'` rows and nothing else, so a draft's URL is a 404.
 * `publicLandingUrl` returns null for anything not live, and this card then
 * explains the absence rather than handing over a link that would be pasted
 * into an ad and quietly fail — the same contract lib/archiveLinks keeps.
 *
 * THE CUSTOM DOMAIN IS A FACT, NOT A LINK. `landing_pages.domain` is INSERTed,
 * SELECTed and echoed, and read by no resolver in the API, so building
 * `https://{domain}/landing/{slug}` here would invent a URL nobody serves.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  publicUrlUnavailableReason,
  type MobileLandingPage,
} from "@/lib/landingPages";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface LandingPublicLinkCardProps {
  page: MobileLandingPage;
  /** Absolute public URL, or null when the page is not served publicly. */
  url: string | null;
  onCopy: (value: string) => void;
}

export function LandingPublicLinkCard({
  page,
  url,
  onCopy,
}: LandingPublicLinkCardProps) {
  const { t } = useTheme();
  const reason = publicUrlUnavailableReason(page);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 8,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.semibold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Public link
      </Text>

      {url ? (
        <>
          <Text
            selectable
            {...typeCap("mono")}
            style={{
              color: t.fg,
              ...typeStyle("mono"),
              // Menlo, as every other copyable identifier in the app uses: a
              // proportional face makes an l/1/I mistake invisible.
              fontFamily: "Menlo",
            }}
          >
            {url}
          </Text>
          <Pressable
            onPress={() => onCopy(url)}
            accessibilityRole="button"
            accessibilityLabel="Copy the public link"
            accessibilityHint="Copies this page's public URL to the clipboard"
            style={{
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              backgroundColor: t.accent,
              borderWidth: 1,
              borderColor: t.accent,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accentFg,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Copy link
            </Text>
          </Pressable>
        </>
      ) : (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {reason ?? "There is no public link for this page."}
        </Text>
      )}

      {page.domain ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Custom domain recorded: {page.domain}. Moosewave resolves this page by
          slug, so the link above is the one it serves.
        </Text>
      ) : null}
    </View>
  );
}
