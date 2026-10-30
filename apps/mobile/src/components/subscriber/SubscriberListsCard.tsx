/**
 * SubscriberListsCard — which lists this person is on, and a way off them.
 *
 * Mobile could push someone INTO a list but never showed memberships, so
 * the profile could not answer the single most common support question:
 * "why is this person getting this email?".
 *
 * Removal is a reversible membership write, so it uses a toast with Undo
 * rather than a confirm dialog (and the removal is optimistic, so the Undo
 * is honest: the row comes back instantly if the DELETE failed).
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { useAddSubscriberToList } from "@/hooks/useSubscribers";
import {
  useRemoveSubscriberFromList,
  useSubscriberLists,
} from "@/hooks/useSubscriberLists";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberListsCard({
  subscriberId,
  canMutate,
  disabledReason,
}: {
  subscriberId: string;
  canMutate: boolean;
  disabledReason?: string | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const memberships = useSubscriberLists(subscriberId);
  const remove = useRemoveSubscriberFromList();
  const readd = useAddSubscriberToList();

  const rows = Array.isArray(memberships.data) ? memberships.data : [];

  function onRemove(listId: string, listName: string) {
    if (!canMutate) return;
    haptics.warning();
    remove.mutate(
      { subscriberId, listId },
      {
        onSuccess: () =>
          toast({
            kind: "info",
            message: `Removed from ${listName}`,
            action: {
              label: "Undo",
              onPress: () =>
                readd.mutate({ id: subscriberId, listId }, {
                  onError: (e: unknown) =>
                    toast({
                      kind: "error",
                      message: `Couldn't undo. ${e instanceof Error ? e.message : ""}`.trim(),
                    }),
                }),
            },
          }),
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `Couldn't remove from ${listName}. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  }

  return (
    <Card style={{ marginTop: 12 }}>
      <Label>Lists</Label>
      {/* An error must never render as "not on any lists" — that reads as a
          fact about the subscriber rather than a failed request. */}
      {memberships.isLoading && rows.length === 0 ? (
        <View style={{ marginTop: 8 }}>
          <SkeletonList rows={2} />
        </View>
      ) : memberships.isError ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          Couldn&apos;t load list memberships.
        </Text>
      ) : rows.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          Not on any list. Tap &quot;Add to list&quot; above.
        </Text>
      ) : (
        <>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 4,
              fontFamily: FONT.regular,
            }}
          >
            {plural(rows.length, "list")}
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 8,
            }}
          >
            {rows.map((row) => (
              <Pressable
                key={row.id}
                onPress={() => onRemove(row.id, row.name)}
                disabled={!canMutate || remove.isPending}
                accessibilityRole="button"
                accessibilityLabel={`Remove from list ${row.name}`}
                {...(!canMutate && disabledReason
                  ? { accessibilityHint: disabledReason }
                  : {})}
                accessibilityState={{ disabled: !canMutate }}
                hitSlop={10}
              >
                <Pill
                  label={canMutate ? `${row.name}  ✕` : row.name}
                  tone="neutral"
                />
              </Pressable>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}
