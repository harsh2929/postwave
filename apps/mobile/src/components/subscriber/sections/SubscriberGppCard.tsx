/**
 * SubscriberGppCard — the stored IAB GPP consent sections (SUB-120), on the
 * profile's disclosure idiom (collapsed, fetch-on-open, viewer-scoped).
 *
 * Read-only exactly like desktop's GppSectionsPanel: the GPP strings render
 * VERBATIM (decoding one would claim a meaning this build cannot verify),
 * and the audit trail names who set each jurisdiction and from where.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import { useSubscriberGpp } from "@/hooks/useSubscriberProfileData";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import { gppSourceLabel } from "@/lib/subscriberGpp";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberGppCard({ subscriberId }: { subscriberId: string }) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const gpp = useSubscriberGpp(subscriberId, open);
  const view = gpp.data;

  return (
    <SubscriberDisclosureCard
      title="GPP consent sections"
      hint="Per-jurisdiction Global Privacy Platform strings, stored verbatim"
      open={open}
      count={view ? view.sections.length : null}
      onToggle={() => setOpen((v) => !v)}
    >
      {gpp.isLoading ? (
        <SkeletonList rows={2} />
      ) : gpp.isError ? (
        <ErrorState error={gpp.error} onRetry={() => void gpp.refetch()} />
      ) : !view || view.sections.length === 0 ? (
        <DisclosureEmptyLine text="No GPP sections recorded — no CMP has reported preferences for this contact." />
      ) : (
        <>
          {view.sections.map((section) => (
            <View
              key={section.jurisdiction}
              accessible
              accessibilityLabel={`${section.jurisdiction} GPP section`}
              style={{
                borderTopColor: t.borderSubtle,
                borderTopWidth: 1,
                paddingVertical: 8,
                gap: 2,
              }}
            >
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("label"),
                  fontFamily: FONT.medium,
                }}
              >
                {section.jurisdiction}
              </Text>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
                numberOfLines={2}
              >
                {section.value}
              </Text>
            </View>
          ))}
          {view.audit.slice(0, 5).map((entry, i) => (
            <Text
              key={`${entry.jurisdiction}-${entry.createdAt}-${i}`}
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
                marginTop: i === 0 ? 8 : 2,
              }}
            >
              {entry.jurisdiction} set by {gppSourceLabel(entry.source)}
              {entry.createdAt ? ` · ${date(entry.createdAt)}` : ""}
            </Text>
          ))}
        </>
      )}
    </SubscriberDisclosureCard>
  );
}
