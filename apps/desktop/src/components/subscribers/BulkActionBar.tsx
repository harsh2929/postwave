/**
 * Sticky subscriber bulk-action surface. Mutation logic, presentation, and
 * overlays are split into bounded modules so permission, scope ownership, and
 * retry/recovery contracts remain independently reviewable.
 */
import type { ReactElement } from "react";

import { useCanAdmin } from "../../lib/store";
import { BulkActionOverlays } from "./BulkActionOverlays";
import { BulkActionProgress, BulkActionToolbar } from "./BulkActionToolbar";
import {
  type BulkActionBarProps,
  type BulkActionCallbacks,
} from "./bulk-action-types";
import { useBulkActionState } from "./useBulkActionState";
import { useBulkExtendedActions } from "./useBulkExtendedActions";
import { useBulkPrimaryActions } from "./useBulkPrimaryActions";
import { useBulkUtilityActions } from "./useBulkUtilityActions";

export function BulkActionBar({
  selected,
  onClear,
  onDone,
  onOpenDedupeReview,
  canMutate,
}: BulkActionBarProps): ReactElement | null {
  const canAdmin = useCanAdmin();
  const canBulk = canMutate && canAdmin;
  const state = useBulkActionState();
  const count = selected.length;
  const plural = count === 1 ? "" : "s";

  const primaryActions = useBulkPrimaryActions({
    selected,
    onDone,
    state,
  });
  const extendedActions = useBulkExtendedActions({
    selected,
    onDone,
    state,
  });
  const utilityActions = useBulkUtilityActions({
    selected,
    state,
  });
  const actions: BulkActionCallbacks = {
    ...primaryActions,
    ...extendedActions,
    ...utilityActions,
  };

  if (count === 0) return null;

  return (
    <>
      <BulkActionToolbar
        count={count}
        canBulk={canBulk}
        canMutate={canMutate}
        onClear={onClear}
        onOpenDedupeReview={onOpenDedupeReview}
        state={state}
        actions={actions}
      />
      <BulkActionProgress count={count} plural={plural} state={state} />
      <BulkActionOverlays
        selected={selected}
        count={count}
        plural={plural}
        canMutate={canMutate}
        state={state}
        actions={actions}
      />
    </>
  );
}
