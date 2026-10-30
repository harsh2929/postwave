/**
 * SuppressionHeaderActions — the right-hand slot of the suppressions header.
 *
 * Extracted from app/(tabs)/suppressions/index.tsx when multi-select landed: three
 * mutually-aware conditions in a route file's JSX is where the screen's
 * complexity budget went, and the RULES between them are worth stating in one
 * place:
 *
 *  - SELECT is offered only to a role whose bulk verb can actually run
 *    (owner|admin — the ScopeAdmin mount), only on the EMAIL channel (the push
 *    roster is a different table with no bulk route), and only when there are
 *    rows to select.
 *  - EXPORT rides `read:subscribers`, a read-only scope, so it is offered to
 *    every signed-in role — not just the admins who may also WRITE. It is
 *    hidden on the PUSH channel: /api/v1/suppressions/export streams the EMAIL
 *    table, and an export button above a push roster that returns email
 *    addresses is the same lie as a mislabelled Copy.
 *  - ADD follows EXPORT's channel rule for EXPORT's reason. AddSuppressionSheet
 *    POSTs to /api/v1/deliverability/suppressions — the EMAIL table — so a "+"
 *    above the push roster accepted an address, reported "suppressed", and
 *    added a row the operator was not looking at and could not see. Select was
 *    already email-only; Add was the outlier.
 *  - EVERYTHING HIDES DURING A SELECTION. The bar owns the verbs then, and a
 *    second set of controls above a selection invites acting on one address
 *    while the bar says four hundred are selected.
 *  - SYNC (mirror from ESP) follows ADD's rules plus ONLINE: it is an admin
 *    write against the EMAIL table (POST /api/v1/suppressions/mirror/*) and
 *    runs a provider walk that cannot be queued, so it hides offline instead
 *    of offering a button whose only outcome is a refusal sentence.
 */
import { View } from "react-native";

import { HeaderAction } from "@/components/deliverability/HeaderAction";
import type { SuppressionChannel } from "@/components/deliverability/SuppressionChannelNav";
import { haptics } from "@/lib/haptics";

export function SuppressionHeaderActions({
  channel,
  canWrite,
  rowCount,
  total,
  online,
  selecting,
  exporting,
  onSelect,
  onExport,
  onAdd,
  onMirror,
}: {
  channel: SuppressionChannel;
  /** owner|admin — the boundary every suppression write sits behind. */
  canWrite: boolean;
  /** Rows materialised right now; "Select" is pointless without them. */
  rowCount: number;
  /** The server's count for the current query — the export's denominator. */
  total: number;
  online: boolean;
  selecting: boolean;
  exporting: boolean;
  onSelect: () => void;
  onExport: () => void;
  onAdd: () => void;
  onMirror: () => void;
}) {
  if (selecting) return null;
  const emailChannel = channel === "email";
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {canWrite && emailChannel && rowCount > 0 ? (
        <HeaderAction
          label="Select"
          tone="muted"
          accessibilityLabel="Select several addresses"
          onPress={() => {
            haptics.tap();
            onSelect();
          }}
        />
      ) : null}
      {emailChannel && total > 0 && online ? (
        <HeaderAction
          label={"\u2934\uFE0E"}
          tone="muted"
          accessibilityLabel="Share the suppression list as CSV"
          disabled={exporting}
          onPress={onExport}
        />
      ) : null}
      {canWrite && emailChannel && online ? (
        <HeaderAction
          label="Sync"
          tone="muted"
          accessibilityLabel="Mirror suppressions from your sending provider"
          onPress={() => {
            haptics.tap();
            onMirror();
          }}
        />
      ) : null}
      {canWrite && emailChannel ? (
        <HeaderAction
          label="+"
          accessibilityLabel="Suppress an address"
          onPress={() => {
            haptics.tap();
            onAdd();
          }}
        />
      ) : null}
    </View>
  );
}
