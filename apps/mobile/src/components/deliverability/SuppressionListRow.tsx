/**
 * SuppressionListRow — one row of the suppressions list, in whichever of the
 * two modes the list is in.
 *
 * Extracted from app/(tabs)/suppressions/index.tsx when multi-select landed: the
 * screen's component function was near its size budget and the mode branching
 * here is behaviour, not layout.
 *
 * The branching that matters:
 *
 *  - IN SELECTION MODE THE ROW IS A CHECKBOX, and the swipe wrapper is gone.
 *    A swipe-to-un-suppress on a selected row would operate on ONE address
 *    while the bar above says four hundred are selected — two different
 *    audiences reachable by two gestures on the same pixel.
 *  - OUT of selection mode the row is a door, and a long-press enters
 *    selection (iOS Mail / Photos) rather than doing nothing.
 *  - Long-press is only wired for a role that can act on a selection. Entering
 *    a selection mode whose only verb 403s is worse than not offering it, and
 *    the bar's own copy already carries that policy for the case where the
 *    role changes mid-session.
 */
import { memo, useCallback } from "react";
import { router } from "expo-router";

import { SuppressionRowCard } from "@/components/deliverability/SuppressionRowCard";
import { SwipeableRow } from "@/components/SwipeableRow";
import type { SuppressionRow } from "@/hooks/useSuppressionOps";
import type { ThemeTokens } from "@/lib/theme";

export interface SuppressionListRowSelection {
  active: boolean;
  ids: readonly string[];
  begin: (email: string) => void;
  toggle: (email: string) => void;
}

function SuppressionListRowImpl({
  row,
  now,
  t,
  canWrite,
  selection,
  onUnsuppress,
}: {
  row: SuppressionRow;
  now: number;
  t: ThemeTokens;
  /** owner|admin — the boundary every suppression write sits behind. */
  canWrite: boolean;
  selection: SuppressionListRowSelection;
  onUnsuppress: (row: SuppressionRow) => void;
}) {
  const email = (row.email ?? "").trim();
  const selecting = selection.active;
  const selected = selecting && selection.ids.includes(email);

  const onPress = useCallback(() => {
    if (selecting) {
      selection.toggle(email);
      return;
    }
    router.push({
      pathname: "/(tabs)/suppressions/[email]",
      params: { email },
    });
  }, [email, selecting, selection]);

  const onLongPress = useCallback(() => {
    selection.begin(email);
  }, [email, selection]);

  const card = (
    <SuppressionRowCard
      email={email}
      reason={row.reason}
      status={row.status}
      createdAt={row.created_at}
      now={now}
      t={t}
      onPress={onPress}
      selectionActive={selecting}
      selected={selected}
      {...(canWrite && email ? { onLongPress } : {})}
    />
  );

  // No swipe while selecting — see the module doc.
  if (!canWrite || !email || selecting) return card;
  return (
    <SwipeableRow
      accessibilityLabel={`${email}, suppressed`}
      right={[
        {
          label: "Un-suppress",
          kind: "danger",
          onPress: () => onUnsuppress(row),
        },
      ]}
    >
      {card}
    </SwipeableRow>
  );
}

export const SuppressionListRow = memo(SuppressionListRowImpl);
