/**
 * CustomObjectRecordCard — one record of a type this workspace invented.
 *
 * THE SHAPE IS NOT OURS, SO NOTHING HERE IS CONDITIONAL ON A FIELD NAME. A
 * record's `properties` is a free-form JSON object (customobjects/types.go:29-36)
 * whose keys are the workspace's own. This card therefore renders whatever
 * `customObjectFields` produced, in the workspace's own spelling and in the
 * stable order that function fixed, and it never asks whether a particular key
 * is present.
 *
 * THE THREE THINGS IT REFUSES TO DO SILENTLY, all inherited from the parser:
 *
 *   - a record whose `properties` is not a field map still renders, with the
 *     parser's sentence saying what arrived instead. Hiding it would tell
 *     someone looking a booking up on the road that it does not exist.
 *   - a value it cannot print (nested, or a type JSON should not carry) is
 *     DESCRIBED rather than truncated into something that looks whole. The
 *     description is the parser's, not a shortening of the value.
 *   - a field map that is genuinely empty says so. `{}` and "no properties at
 *     all" are different facts and get different sentences.
 *
 * WHY IT COLLAPSES. A custom object can carry dozens of properties and a phone
 * shows six before the next record leaves the screen. The collapse is a
 * disclosure, never a cap: the count in the control is the REAL number of
 * fields, one press shows every one of them, and nothing is dropped. That is
 * why there is no "+N more — see the web admin" line here; there is nothing
 * this build cannot show.
 *
 * NativeWind v4: static style objects only — a function-style `style` prop on
 * a Pressable silently drops layout.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { dateTime } from "@/lib/format";
import {
  customObjectRecordTitle,
  type CustomObjectField,
  type CustomObjectRecord,
  type CustomObjectType,
} from "@/lib/customObjectRecords";
import { FONT } from "@/lib/fonts";
import { CARD_RADIUS } from "@/lib/shellStyleTokens";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Fields shown before the card asks to be expanded. */
const COLLAPSED_FIELDS = 6;

export function CustomObjectRecordCard({
  record,
  type,
}: {
  record: CustomObjectRecord;
  type: CustomObjectType | null;
}) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const fields = Array.isArray(record.fields) ? record.fields : [];
  const collapsible = fields.length > COLLAPSED_FIELDS;
  const shown = expanded || !collapsible ? fields : fields.slice(0, COLLAPSED_FIELDS);
  const title = customObjectRecordTitle(record, type);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: CARD_RADIUS,
        padding: 12,
        marginTop: 8,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
        numberOfLines={2}
      >
        {title}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 2,
          fontFamily: FONT.regular,
        }}
      >
        {/* `externalId` is the workspace's natural key and the id is ours. The
            line says which one it is showing rather than printing a bare
            string that could be either. */}
        {record.externalId ? `external id ${record.externalId}` : `id ${record.id}`}
        {record.updatedAt ? ` · updated ${dateTime(record.updatedAt)}` : ""}
      </Text>

      {record.unreadable ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          {record.unreadable}
        </Text>
      ) : fields.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          This record&apos;s property map is empty — it exists, but carries no
          fields.
        </Text>
      ) : (
        <View style={{ marginTop: 6 }}>
          {shown.map((field) => (
            <FieldRow key={field.key} field={field} />
          ))}
        </View>
      )}

      {collapsible ? (
        <Pressable
          onPress={() => setExpanded((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={
            expanded
              ? `Show fewer fields of ${title}`
              : `Show all ${fields.length} fields of ${title}`
          }
          accessibilityState={{ expanded }}
          style={{
            minHeight: 44,
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.accent,
              ...typeStyle("caption"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {expanded
              ? "Show fewer fields"
              : `Show all ${fields.length} fields`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * One property. The KEY is printed exactly as the workspace spelled it —
 * title-casing `order_ref` into "Order Ref" would be renaming someone's data
 * in the one place they came to check it.
 */
function FieldRow({ field }: { field: CustomObjectField }) {
  const { t } = useTheme();
  // `empty` is a real value ("the field is here and holds nothing"), and
  // `nested`/`unrenderable` carry a SENTENCE rather than the value itself.
  // Both are set apart so a reader never mistakes either for the data.
  const describes = field.kind === "nested" || field.kind === "unrenderable";
  return (
    <View
      accessible
      accessibilityLabel={`${field.key}: ${
        field.kind === "empty" ? "empty" : field.value
      }`}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 3 }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          flexShrink: 0,
          maxWidth: "45%",
          fontFamily: FONT.regular,
        }}
      >
        {field.key}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: describes || field.kind === "empty" ? t.fgSubtle : t.fg,
          ...typeStyle("caption"),
          flex: 1,
          textAlign: "right",
          fontStyle: describes ? "italic" : "normal",
          fontFamily: FONT.regular,
        }}
      >
        {field.value}
      </Text>
    </View>
  );
}
