/**
 * CampaignLinkCheckCard — "do all the links in this email actually work?",
 * asked before the send instead of discovered after it.
 *
 * A broken link is the one pre-send mistake with no recovery: once delivery
 * starts every recipient has the dead URL. The gateway has always been able to
 * answer (apps/api/internal/link_checker) and no client asked from a phone —
 * the surface where a link is least likely to have been clicked through by a
 * human first.
 *
 * Deliberately on-demand rather than automatic: the check makes one real HTTP
 * request per link, and firing that every time a send sheet opens would be a
 * fan-out the operator never asked for.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import type { LinkCheckReading } from "@/lib/campaignLinkCheck";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignLinkCheckCardProps {
  reading: LinkCheckReading | null;
  running: boolean;
  error: unknown;
  onRun: () => void;
  disabled?: boolean;
}

export function CampaignLinkCheckCard({
  reading,
  running,
  error,
  onRun,
  disabled = false,
}: CampaignLinkCheckCardProps) {
  const { t } = useTheme();
  const tone = reading
    ? reading.brokenCount > 0
      ? t.danger
      : t.success
    : t.fgMuted;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor:
          reading && reading.brokenCount > 0 ? t.danger : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          accessibilityRole="header"
          style={{
            color: tone,
            fontSize: 13,
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          {reading?.headline ?? "Links haven't been checked"}
        </Text>
        <ActionButton
          label={running ? "Checking…" : reading ? "Re-check" : "Check links"}
          onPress={onRun}
          disabled={running || disabled}
        />
      </View>

      {error ? (
        <View style={{ marginTop: 8 }}>
          <ErrorState
            compact
            error={error}
            message="Couldn't check this campaign's links."
            onRetry={onRun}
          />
        </View>
      ) : null}

      {reading && reading.rows.length > 0 ? (
        <View style={{ marginTop: 10, gap: 8 }}>
          {reading.rows.slice(0, 8).map((row) => (
            <View
              key={row.key}
              accessible
              accessibilityLabel={`${row.url}: ${
                row.ok ? "resolved" : `failed, ${row.statusLabel}`
              }${row.detail ? `. ${row.detail}` : ""}`}
              style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
            >
              {/* Glyph as well as colour: a pass/fail carried only by hue is
                  invisible to a colour-blind operator. */}
              <Pill
                label={`${row.ok ? "✓" : "✕"} ${row.statusLabel}`}
                tone={row.ok ? "success" : "danger"}
              />
              <View style={{ flex: 1 }}>
                <Text
                  {...typeCap("label")}
                  numberOfLines={1}
                  style={{
                    color: t.fg,
                    fontSize: 12,
                    fontFamily: FONT.regular,
                  }}
                >
                  {row.url}
                </Text>
                {row.detail ? (
                  <Text
                    {...typeCap("caption")}
                    style={{
                      color: t.fgSubtle,
                      fontSize: 11,
                      lineHeight: 15,
                      marginTop: 1,
                      fontFamily: FONT.regular,
                    }}
                  >
                    {row.detail}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
          {reading.rows.length > 8 ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontSize: 11,
                fontFamily: FONT.regular,
              }}
            >
              +{reading.rows.length - 8} more links checked.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
