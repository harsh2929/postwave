/**
 * SubscriberTrackingCard — honor "stop tracking me" from the phone.
 *
 * Desktop's TrackingPrefsPanel translated: per-dimension (open / click)
 * sentences that keep the two truth layers distinct — the EXPLICIT evidence
 * this workspace recorded, and the EFFECTIVE send-time state that also
 * honors Global Privacy Control. The verbs write only the explicit layer,
 * conditionally on the exact state the operator was shown (strong ETag), so
 * a concurrent change 412s honestly instead of being overwritten.
 *
 * Verbs exist only for `canMutate` (editor+, online, live session); a
 * viewer sees the state. A 412 is copy-explained as a refresh prompt.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import {
  useSetSubscriberTracking,
  useSubscriberTracking,
} from "@/hooks/useSubscriberTracking";
import { FONT } from "@/lib/fonts";
import { statusFromError } from "@/api/request";
import { haptics } from "@/lib/haptics";
import { trackingDimensionSummary } from "@/lib/subscriberTracking";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberTrackingCard({
  subscriberId,
  canMutate,
}: {
  subscriberId: string;
  canMutate: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const tracking = useSubscriberTracking(subscriberId, open);
  const write = useSetSubscriberTracking();

  const prefs = tracking.data?.prefs ?? null;
  const etag = tracking.data?.etag ?? "";

  const toggle = (dimension: "open" | "click", nextOptOut: boolean) => {
    if (write.isPending) return;
    haptics.tap();
    write.mutate(
      { subscriberId, dimension, nextOptOut, etag },
      {
        onSuccess: () => {
          haptics.success();
          toast({
            kind: "success",
            message: nextOptOut
              ? `${dimension === "open" ? "Open" : "Click"} tracking opt-out recorded.`
              : `${dimension === "open" ? "Open" : "Click"} tracking opt-out cleared.`,
          });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              statusFromError(e) === 412
                ? "This contact's tracking state changed since it loaded. Re-open the card and decide against the current state."
                : `Couldn't record the tracking preference. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  };

  const dimensionRow = (
    dimension: "open" | "click",
    label: "Open" | "Click",
    explicitAt: string | null,
    effective: boolean,
  ) => {
    const explicit = Boolean(explicitAt);
    return (
      <View
        style={{
          borderTopColor: t.borderSubtle,
          borderTopWidth: 1,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          accessibilityLabel={trackingDimensionSummary(
            label,
            explicit,
            effective,
            prefs?.gpc ?? false,
          )}
          style={{
            flex: 1,
            minWidth: 0,
            color: effective || explicit ? t.fgMuted : t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {trackingDimensionSummary(
            label,
            explicit,
            effective,
            prefs?.gpc ?? false,
          )}
        </Text>
        {canMutate ? (
          <Chip
            label={explicit ? "Clear opt-out" : "Record opt-out"}
            active={false}
            onPress={() => toggle(dimension, !explicit)}
            accessibilityLabel={
              explicit
                ? `Clear the explicit ${label.toLowerCase()}-tracking opt-out`
                : `Record an explicit ${label.toLowerCase()}-tracking opt-out for this subscriber`
            }
          />
        ) : null}
      </View>
    );
  };

  return (
    <SubscriberDisclosureCard
      title="Tracking preferences"
      hint="Open/click tracking consent, including Global Privacy Control"
      open={open}
      count={null}
      onToggle={() => setOpen((v) => !v)}
    >
      {tracking.isLoading ? (
        <SkeletonList rows={2} />
      ) : tracking.isError ? (
        <ErrorState
          error={tracking.error}
          onRetry={() => void tracking.refetch()}
        />
      ) : !prefs ? (
        <DisclosureEmptyLine text="The server returned no tracking record for this contact." />
      ) : (
        <>
          {prefs.gpc ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.warning,
                ...typeStyle("label"),
                fontFamily: FONT.medium,
                marginBottom: 4,
              }}
            >
              This subscriber&apos;s browser sends Global Privacy Control. It
              cannot be overridden from here.
            </Text>
          ) : null}
          {dimensionRow(
            "open",
            "Open",
            prefs.openOptOutAt,
            prefs.effectiveOpenOptOut,
          )}
          {dimensionRow(
            "click",
            "Click",
            prefs.clickOptOutAt,
            prefs.effectiveClickOptOut,
          )}
        </>
      )}
    </SubscriberDisclosureCard>
  );
}
