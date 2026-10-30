/**
 * ListMemberRow — one member of a list, with the remove action attached.
 *
 * The roster used to render a bare `SubscriberRow`, whose only row action is
 * "Suppress" (a tenant-wide verb). Taking someone off THIS list had to be done
 * from their profile, one detour per person, which is the parity gap this
 * closes.
 *
 * The action is a swipe, and `SwipeableRow` publishes it as an
 * `accessibilityAction` as well, so the gesture is never the only path to it.
 * It is ABSENT — not disabled — when the session may not remove (below editor,
 * offline, or a row the server sent without a uuid id, which the DELETE would
 * 400): the caller decides by passing `onRemove` or omitting it.
 */
import { memo, useMemo } from "react";
import { View } from "react-native";

import { SwipeableRow, type SwipeAction } from "@/components/SwipeableRow";
import {
  SubscriberRow,
  type SubscriberListRow,
} from "@/components/subscriber/SubscriberRow";
import { isSubscriberUuid } from "@/lib/listMembershipRows";

export interface ListMemberRowItem extends SubscriberListRow {
  id: string;
  email: string;
}

function ListMemberRowBody({
  item,
  onRemove,
  removing = false,
}: {
  item: ListMemberRowItem;
  /** Omit to offer no row action at all — see the module doc. */
  onRemove?: ((member: { id: string; email: string }) => void) | undefined;
  /** This row's DELETE is in flight; withdraw the action until it settles. */
  removing?: boolean;
}) {
  const removable = Boolean(onRemove) && isSubscriberUuid(item.id) && !removing;
  const actions = useMemo<SwipeAction[]>(
    () =>
      removable && onRemove
        ? [
            {
              label: "Remove",
              kind: "danger",
              onPress: () => onRemove({ id: item.id, email: item.email }),
            },
          ]
        : [],
    [item.email, item.id, onRemove, removable],
  );

  return (
    <SwipeableRow
      right={actions}
      accessibilityLabel={`${item.email}, member of this list`}
    >
      <View style={{ opacity: removing ? 0.5 : 1 }}>
        <SubscriberRow item={item} />
      </View>
    </SwipeableRow>
  );
}

export const ListMemberRow = memo(ListMemberRowBody);
