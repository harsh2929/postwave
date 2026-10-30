/**
 * AuditAdvancedFiltersSheet — the four extra SERVER facets, behind one chip.
 *
 * Desktop pushes action / resource type / resource id / actor label to
 * GET /api/v1/audit (AuditFilterPanels.tsx); mobile now does the same instead
 * of narrowing only the loaded pages. The sheet edits a DRAFT and applies it
 * in one commit, because each keystroke in a server-pushed field would
 * otherwise be a fresh page-one fetch of the most expensive read in the
 * product.
 *
 * Copy discipline: `resource type` and `actor label` are EXACT matches on the
 * server, the other two are substring — each field says which, so an empty
 * result reads as an answer rather than a bug.
 */
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import {
  EMPTY_AUDIT_ADVANCED_FILTERS,
  hasAuditAdvancedFilters,
  normalizeAuditAdvancedFilters,
  type AuditAdvancedFilters,
} from "@/lib/auditAdvancedFilters";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditAction } from "./AuditAction";
import { SheetHeader } from "./AuditSheetParts";

export interface AuditAdvancedFiltersSheetProps {
  visible: boolean;
  value: AuditAdvancedFilters;
  onApply: (next: AuditAdvancedFilters) => void;
  onClose: () => void;
}

export function AuditAdvancedFiltersSheet({
  visible,
  value,
  onApply,
  onClose,
}: AuditAdvancedFiltersSheetProps) {
  const { t } = useTheme();
  const [draft, setDraft] = useState<AuditAdvancedFilters>(value);

  // Re-seed the draft each time the sheet opens, so a cancelled edit never
  // leaks into the next open.
  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  const apply = () => {
    onApply(normalizeAuditAdvancedFilters(draft));
    onClose();
  };
  const clear = () => {
    onApply(EMPTY_AUDIT_ADVANCED_FILTERS);
    onClose();
  };

  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Server-side audit filters"
      >
        <SheetHeader title="Filter on the server" onClose={onClose} />
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 14 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            These narrow the query itself, so they cover the FULL window — not
            just the pages loaded so far.
          </Text>
          <FilterField
            label="Action contains"
            hint="Substring match, e.g. “delete” or “campaign.send”."
            value={draft.action}
            onChange={(action) => setDraft((d) => ({ ...d, action }))}
            onSubmit={apply}
          />
          <FilterField
            label="Resource type is exactly"
            hint="Exact match, e.g. “campaign” — a partial value matches nothing."
            value={draft.resourceType}
            onChange={(resourceType) => setDraft((d) => ({ ...d, resourceType }))}
            onSubmit={apply}
          />
          <FilterField
            label="Resource id contains"
            hint="Substring match over the resource id."
            value={draft.resourceId}
            onChange={(resourceId) => setDraft((d) => ({ ...d, resourceId }))}
            onSubmit={apply}
          />
          <FilterField
            label="Actor label is exactly"
            hint="Exact match, e.g. an email address — a partial value matches nothing."
            value={draft.actorLabel}
            onChange={(actorLabel) => setDraft((d) => ({ ...d, actorLabel }))}
            onSubmit={apply}
          />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
            {hasAuditAdvancedFilters(value) ? (
              <AuditAction
                label="Clear"
                hint="Removes every server-side filter"
                onPress={clear}
              />
            ) : null}
            <AuditAction
              label="Apply"
              hint="Re-queries the audit log with these filters"
              emphasis
              onPress={apply}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function FilterField({
  label,
  hint,
  value,
  onChange,
  onSubmit,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.semibold,
          ...typeStyle("label"),
        }}
      >
        {label}
      </Text>
      <TextInput
        // The input scales with the OS text size but its 44pt height does not.
        {...typeCap("body")}
        value={value}
        onChangeText={onChange}
        onSubmitEditing={onSubmit}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholder={hint}
        placeholderTextColor={t.fgSubtle}
        style={{
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          color: t.fg,
          backgroundColor: t.surface,
          fontFamily: FONT.regular,
          minHeight: 44,
        }}
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {hint}
      </Text>
    </View>
  );
}
