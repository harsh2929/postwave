/**
 * SubscriberBulkLayer — the selection bar plus the two pickers it opens,
 * mounted as one element so app/(tabs)/subscribers/index.tsx stays a view.
 *
 * It renders NOTHING when selection mode is off, which is what keeps the
 * list's normal gesture contract untouched: no bar, no sheets, no hidden
 * pressable overlaying the tab bar.
 */
import { useSubscriberSelection } from "@/hooks/useSubscriberSelection";
import { BulkValidationSheet } from "@/components/subscriber/BulkValidationSheet";
import {
  BulkListSheet,
  BulkTagSheet,
} from "@/components/subscriber/SubscriberBulkSheets";
import { SubscriberSelectionBar } from "@/components/subscriber/SubscriberSelectionBar";
import type { ThemeTokens } from "@/lib/theme";

export function SubscriberBulkLayer({
  selection,
  loadedCount,
  t,
}: {
  selection: ReturnType<typeof useSubscriberSelection>;
  loadedCount: number;
  t: ThemeTokens;
}) {
  if (!selection.active) return null;
  return (
    <>
      <SubscriberSelectionBar
        count={selection.count}
        loadedCount={loadedCount}
        allLoadedSelected={selection.allLoadedSelected}
        availability={selection.availability}
        pending={selection.pending}
        onVerb={(verb) => void selection.startVerb(verb)}
        onSelectAll={selection.selectAll}
        onClear={selection.clear}
        onDone={selection.exit}
        t={t}
      />
      <BulkTagSheet
        visible={selection.sheet === "tag"}
        count={selection.count}
        onClose={selection.closeSheet}
        onSubmit={(tag) => void selection.applyTag(tag)}
        t={t}
      />
      <BulkListSheet
        visible={selection.sheet === "list"}
        count={selection.count}
        onClose={selection.closeSheet}
        onSubmit={(list) => void selection.applyList(list)}
        t={t}
      />
      <BulkValidationSheet
        visible={selection.sheet === "validation"}
        validation={selection.validation}
        onClose={selection.closeSheet}
        t={t}
      />
    </>
  );
}
