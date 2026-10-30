/**
 * CampaignPreviewCard — the plain-text window into the actual email.
 *
 * Two fixes over the inline version:
 *
 *  - It no longer hard-cuts at 2,000 characters with a bare ellipsis and no
 *    way to read the rest. A "Show more" control states how much was hidden.
 *  - It says out loud that the plain-text rendering FLATTENS dynamic content:
 *    the tag-stripper merges every conditional branch into one blob, so the
 *    preview can misrepresent what any single recipient sees.
 *
 * The expensive part — eleven regex passes over the body — is memoised by the
 * caller (see campaignPreviewText in the detail screen); this component only
 * slices an already-computed string.
 */
import { useState } from "react";
import { Pressable, Text } from "react-native";

import { Card } from "@/components/campaigns/CampaignDetailControls";
import { num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";

/** How much of the body renders before the "Show more" control appears. */
export const PREVIEW_COLLAPSED_CHARS = 2000;

export interface CampaignPreviewCardProps {
  preview: string | null;
  /** True when the body contains conditional/dynamic regions. */
  hasDynamicContent?: boolean;
}

export function CampaignPreviewCard({
  preview,
  hasDynamicContent = false,
}: CampaignPreviewCardProps) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);

  if (!preview) {
    return (
      <Card>
        <Text
          {...typeCap("bodySmall")}
          style={{ color: t.fgSubtle, fontSize: 13, fontFamily: FONT.regular }}
        >
          No preview available. Compose a body on the web app.
        </Text>
      </Card>
    );
  }

  const truncated = preview.length > PREVIEW_COLLAPSED_CHARS;
  const shown =
    truncated && !expanded
      ? `${preview.slice(0, PREVIEW_COLLAPSED_CHARS)}…`
      : preview;
  const hidden = Math.max(0, preview.length - PREVIEW_COLLAPSED_CHARS);

  return (
    <Card>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          fontSize: 14,
          lineHeight: 20,
          fontFamily: FONT.regular,
          writingDirection: "auto",
        }}
        selectable
      >
        {shown}
      </Text>

      {truncated ? (
        <Pressable
          onPress={() => {
            haptics.tap();
            setExpanded((prev) => !prev);
          }}
          accessibilityRole="button"
          accessibilityLabel={
            expanded
              ? "Show less of the email body"
              : `Show the remaining ${num(hidden)} characters of the email body`
          }
          accessibilityState={{ expanded }}
          style={{
            marginTop: 12,
            minHeight: 44,
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{ color: t.accent, fontSize: 13, fontFamily: FONT.semibold }}
          >
            {expanded ? "Show less" : `Show more (${num(hidden)} characters)`}
          </Text>
        </Pressable>
      ) : null}

      {hasDynamicContent ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            lineHeight: 16,
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          This campaign has dynamic regions. The plain-text preview shows every
          branch at once — no single recipient receives exactly this.
        </Text>
      ) : null}
    </Card>
  );
}
