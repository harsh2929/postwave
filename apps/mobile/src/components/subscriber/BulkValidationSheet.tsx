/**
 * BulkValidationSheet — the receipt for the selection's Validate verb.
 *
 * Desktop's ValidationResultsModal, phone-sized, with its honesty rule kept:
 * validation is SURFACE-only (syntax / MX / disposable / role-account), so
 * the header says "look deliverable", never "are deliverable". The flagged
 * rows are the content; the deliverable ones are a count — a phone sheet
 * listing 500 green rows would bury the five that need action.
 */
import { FlatList, Text, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { ModalHeader } from "@/components/subscriber/SubActionButton";
import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import {
  invalidValidationRows,
  validationReceipt,
  verdictLabel,
  type ValidationBatchView,
} from "@/lib/subscriberValidateEmails";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function BulkValidationSheet({
  visible,
  validation,
  onClose,
  t,
}: {
  visible: boolean;
  validation: { view: ValidationBatchView; skipped: number } | null;
  onClose: () => void;
  t: ThemeTokens;
}) {
  if (!validation) return null;
  const { view, skipped } = validation;
  const flagged = invalidValidationRows(view);
  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Email validation results"
    >
      <ModalHeader title="Validation results" onClose={onClose} t={t} />
      <View style={{ gap: 12 }}>
        <Text
          {...typeCap("body")}
          accessibilityRole="summary"
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
          }}
        >
          {validationReceipt(view, skipped)}
        </Text>
        {view.byVerdict.length > 0 ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {view.byVerdict
              .map(([verdict, n]) => `${verdictLabel(verdict)}: ${n}`)
              .join(" · ")}
          </Text>
        ) : null}
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Surface checks only (syntax, mail server, disposable, role account)
          — a pass means the address looks deliverable.
        </Text>
        {flagged.length > 0 ? (
          <FlatList
            data={flagged}
            keyExtractor={(row) => row.email}
            style={{ maxHeight: 320 }}
            {...MOBILE_LIST_PERF_PROPS}
            renderItem={({ item }) => (
              <View
                accessible
                accessibilityLabel={`${item.email}: ${verdictLabel(item.verdict)}`}
                style={{
                  borderTopColor: t.borderSubtle,
                  borderTopWidth: 1,
                  paddingVertical: 8,
                }}
              >
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                  }}
                  numberOfLines={1}
                >
                  {item.email}
                </Text>
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.danger,
                    ...typeStyle("label"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {verdictLabel(item.verdict)}
                </Text>
              </View>
            )}
          />
        ) : null}
      </View>
    </KeyboardFormSheet>
  );
}
