/**
 * SubscriberCustomObjectsCard — the non-person records linked to this
 * profile (SUB-011) plus the catalog computed-traits, read-only on the
 * profile's disclosure idiom.
 *
 * Desktop splits these across the customObjects tab and the
 * CatalogAttributesPanel; the phone shows both under one card because each
 * answers "what does the workspace know is attached to this person". A
 * trait never computed renders as NOTHING (absence, not "unknown").
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import { useSubscriberCustomObjects } from "@/hooks/useSubscriberProfileData";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberCustomObjectsCard({
  subscriberId,
}: {
  subscriberId: string;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const objects = useSubscriberCustomObjects(subscriberId, open);
  const view = objects.data;
  const empty =
    view && view.links.length === 0 && view.catalog.length === 0;

  return (
    <SubscriberDisclosureCard
      title="Linked records"
      hint="Custom-object records and catalog traits attached to this profile"
      open={open}
      count={view ? view.links.length : null}
      onToggle={() => setOpen((v) => !v)}
    >
      {objects.isLoading ? (
        <SkeletonList rows={2} />
      ) : objects.isError ? (
        <ErrorState
          error={objects.error}
          onRetry={() => void objects.refetch()}
        />
      ) : !view || empty ? (
        <DisclosureEmptyLine text="No records or catalog traits are linked to this contact." />
      ) : (
        <>
          {view.links.map((link) => (
            <View
              key={link.id}
              accessible
              accessibilityLabel={`${link.typeLabel} ${link.recordLabel}, ${link.relationship}`}
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
                {link.typeLabel} · {link.relationship}
              </Text>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
                numberOfLines={1}
              >
                {link.recordLabel}
              </Text>
            </View>
          ))}
          {view.catalog.map((row) => (
            <View
              key={row.label}
              accessible
              accessibilityLabel={`${row.label}: ${row.value}`}
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
                {row.value}
              </Text>
            </View>
          ))}
        </>
      )}
    </SubscriberDisclosureCard>
  );
}
