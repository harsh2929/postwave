/**
 * SubscriberDemographicsCard — the SUB-063 inferred demographics, on the
 * profile's disclosure idiom (collapsed, fetch-on-open, viewer-scoped).
 *
 * Desktop's DemographicsPanel translated with its honesty rules intact: a
 * trait the model never inferred renders as NOTHING (not "unknown"), and a
 * value never appears without its confidence label — "female" and "female ·
 * 62% confidence" are different claims about a person.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { SkeletonList } from "@/components/Skeleton";
import { ErrorState } from "@/components/ErrorState";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import { useSubscriberDemographics } from "@/hooks/useSubscriberDemographics";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberDemographicsCard({
  subscriberId,
}: {
  subscriberId: string;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const traits = useSubscriberDemographics(subscriberId, open);
  // `?? []` only covers null/undefined; a truthy non-array off the wire would
  // reach the .map below and throw. Check the type.
  const rows = Array.isArray(traits.data) ? traits.data : [];

  return (
    <SubscriberDisclosureCard
      title="Demographics"
      hint="Model-inferred attributes with their confidence — never declared facts"
      open={open}
      count={traits.data ? rows.length : null}
      onToggle={() => setOpen((v) => !v)}
    >
      {traits.isLoading ? (
        <SkeletonList rows={2} />
      ) : traits.isError ? (
        <ErrorState
          error={traits.error}
          onRetry={() => void traits.refetch()}
        />
      ) : rows.length === 0 ? (
        <DisclosureEmptyLine text="Nothing has been inferred for this contact. Absent is absent — not unknown." />
      ) : (
        rows.map((row) => (
          <View
            key={row.key}
            accessible
            accessibilityLabel={[row.label, row.value, row.confidence]
              .filter(Boolean)
              .join(", ")}
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
              {row.label}
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {[row.value, row.confidence].filter(Boolean).join(" · ")}
            </Text>
          </View>
        ))
      )}
    </SubscriberDisclosureCard>
  );
}
