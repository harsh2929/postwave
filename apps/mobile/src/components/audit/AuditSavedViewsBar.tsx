/**
 * AuditSavedViewsBar — named filter sets above the audit log.
 *
 * Desktop has had this since Refined Audit PR 2
 * (apps/desktop/src/components/audit/SavedViewsBar.tsx); mobile did not, so
 * an on-call operator re-specified the same investigation on every incident
 * and could never open a view a colleague had saved at a desk. Both clients
 * write the SAME server rows, so this bar lists desktop-authored views too —
 * see lib/auditViews for how the two filter vocabularies are reconciled and
 * where the reconciliation is lossy.
 *
 * Three deliberate shape decisions:
 *
 *  - The delete control is a SIBLING of the chip row, not an "×" inside the
 *    active chip. A tappable glyph inside a tappable pill is the nested
 *    interactive control the lint in lib/noNestedInteractiveControls.test.ts
 *    exists to stop, and at phone scale the two targets overlap: "recall this
 *    view" and "destroy this view" must not share a 44pt box.
 *  - A view is marked ACTIVE by comparing decoded filter state, not by
 *    remembering which chip was tapped. Change one chip after loading a view
 *    and it stops claiming to be that view — because it no longer is.
 *  - A view whose blob came from another client is announced as adapted. A
 *    saved view that silently shows something slightly different from what
 *    was saved is worse than one that says it approximated.
 */
import { ScrollView, Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { FONT } from "@/lib/fonts";
import {
  auditViewsEqual,
  decodeAuditView,
  describeAuditView,
  isNativeAuditView,
  type AuditSavedView,
  type AuditViewState,
} from "@/lib/auditViews";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditSavedViewsBarProps {
  views: readonly AuditSavedView[];
  /** True while the list request is in flight and nothing is cached. */
  loading: boolean;
  /** True when the list request failed — never rendered as "no views". */
  failed: boolean;
  current: AuditViewState;
  onApply: (view: AuditSavedView, state: AuditViewState) => void;
  onSave: () => void;
  onDelete: (view: AuditSavedView) => void;
  /** Disabled while offline or mid-mutation. */
  busy: boolean;
  /**
   * May this actor CREATE or DELETE a view? Reading and writing are two
   * different permissions on the server — see lib/auditSavedViewPolicy — and
   * an affordance that can only 403 is worse than an absent one.
   */
  canManage: boolean;
  /** Why the write controls are absent, or null when they are present. */
  manageNotice: string | null;
}

export function AuditSavedViewsBar({
  views,
  loading,
  failed,
  current,
  onApply,
  onSave,
  onDelete,
  busy,
  canManage,
  manageNotice,
}: AuditSavedViewsBarProps) {
  const { t } = useTheme();

  // Decoded against the DEFAULTS, not against `current`. Basing the decode on
  // the live filter state looks harmless and is not: a view whose blob omits
  // a field would inherit whatever the screen happens to be showing, so an
  // empty or minimal blob would decode to exactly the current state and its
  // chip would light up as "active" on every screen it is rendered on. A saved
  // view has to mean what it says and nothing more.
  const decoded = views.map((view) => ({
    view,
    state: decodeAuditView(view.filters),
    exact: isNativeAuditView(view.filters),
  }));
  const active = decoded.find((entry) => auditViewsEqual(entry.state, current));

  // A failed list must not render as "you have no saved views" — that reads
  // as data loss on a compliance surface. The bar collapses to a line that
  // says the list is unavailable, and the Save affordance goes with it
  // (saving into a list we cannot read invites silent duplicates).
  if (failed) {
    return (
      <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          Saved views are unavailable right now.
        </Text>
      </View>
    );
  }

  if (loading && views.length === 0) return null;
  // Nothing saved and nothing this actor may save: a bar whose only content
  // would be an explanation of an absent button is noise on a compliance
  // screen. The notice appears only where the button would have been.
  if (!canManage && views.length === 0) return null;

  return (
    <View style={{ paddingTop: 6, gap: 6 }}>
      <View accessibilityRole="tablist" accessibilityLabel="Saved audit views">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexDirection: "row",
            gap: 6,
            paddingHorizontal: 16,
            alignItems: "center",
          }}
        >
          {decoded.map(({ view, state, exact }) => (
            <Chip
              key={view.id}
              label={view.name}
              active={active?.view.id === view.id}
              accessibilityLabel={`Saved view ${view.name}: ${describeAuditView(
                state,
                !exact,
              )}`}
              onPress={() => onApply(view, state)}
            />
          ))}
          {canManage ? (
            <Chip
              label={views.length === 0 ? "Save this view" : "Save current"}
              active={false}
              disabled={busy}
              accessibilityLabel="Save the current filters as a named view"
              onPress={onSave}
            />
          ) : null}
        </ScrollView>
      </View>
      {!canManage && manageNotice ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
            paddingHorizontal: 16,
          }}
        >
          {manageNotice}
        </Text>
      ) : null}
      {active ? (
        <View style={{ paddingHorizontal: 16, gap: 4 }}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {describeAuditView(active.state, !active.exact)}
          </Text>
          {canManage ? (
            <Chip
              label={`Delete “${active.view.name}”`}
              active={false}
              disabled={busy}
              accessibilityLabel={`Delete the saved view ${active.view.name}`}
              onPress={() => onDelete(active.view)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
