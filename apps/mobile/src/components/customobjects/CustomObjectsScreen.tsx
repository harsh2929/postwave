/**
 * CustomObjectsScreen — look up a booking, an order, a policy, a court
 * reservation: whatever this workspace decided its business objects are.
 *
 * THE SHAPE IS THE WORKSPACE'S, NOT OURS. `GET /custom-objects/types` returns
 * types the tenant defined, and each record under one carries a free-form
 * `properties` map. This screen therefore renders WHATEVER comes back: it lists
 * a record's fields by the workspace's own key names, in a stable order, and
 * where a value is nested or of a type it cannot print it says so in place
 * instead of dropping the row. A type this build has never seen renders like
 * any other; there is no client-side schema to fall out of.
 *
 * DEFINITIONS STAY ON THE DESKTOP. Create/edit/delete of a TYPE are admin
 * routes and are deliberately absent here, per the ledger's recorded reason:
 * changing a definition retypes data across everything that uses it. Record
 * upsert and delete are admin too. This is a read.
 *
 * NO FILTERING, AND THAT IS A SERVER RULE RATHER THAN A SHORTCUT. Exact
 * property values may not travel in a URL (handlers.go:190-201) — they are
 * customer data that would land in access logs — so the only filter route is a
 * POST search. The phone reads one page and says so.
 *
 * NativeWind v4: static style objects only.
 */
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { CustomObjectRecordCard } from "@/components/customobjects/CustomObjectRecordCard";
import {
  useCustomObjectRecords,
  useCustomObjectTypes,
} from "@/hooks/useCustomObjects";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  customObjectRecordsSummary,
  customObjectsErrorMessage,
  type CustomObjectType,
} from "@/lib/customObjectRecords";
import { FONT } from "@/lib/fonts";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CustomObjectsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  useScreenViewed("custom-objects");

  const types = useCustomObjectTypes();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(
    () => (Array.isArray(types.data) ? types.data : []),
    [types.data],
  );
  // A selection survives a refetch while the type is still there; otherwise the
  // first type, so the screen is never a picker with nothing under it.
  const activeId =
    selectedId && rows.some((row) => row.id === selectedId)
      ? selectedId
      : (rows[0]?.id ?? null);
  const activeType = rows.find((row) => row.id === activeId) ?? null;
  const records = useCustomObjectRecords(activeId);
  const refresh = useManualRefresh([types.refetch, records.refetch], {
    enabled: gate.enabled,
  });

  const page = records.data ?? { items: [], limit: null, hasMore: false };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Custom objects"
        {...(rows.length > 0
          ? {
              subtitle: `${rows.length} ${rows.length === 1 ? "type" : "types"} defined in this workspace`,
            }
          : {})}
        onBack={goBackOrMore}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        <QueryStates
          query={types}
          gate={gate}
          isEmpty={rows.length === 0}
          offlineMessage="Custom objects need a connection. Reconnect and pull to refresh — this is not the same as the workspace having none."
          skeleton={<SkeletonList rows={3} lines={2} label="Loading object types" />}
          empty={{
            title: "No object types defined",
            description:
              "This workspace has not defined any custom object types. They are created on the web admin, because changing a definition retypes data across everything that uses it.",
          }}
        >
          <SegmentedControl
            options={rows.map((row) => ({ value: row.id, label: row.label }))}
            value={activeId ?? ""}
            onChange={setSelectedId}
            accessibilityLabel="Custom object type"
            scrollable
          />

          {activeType ? <TypeSummary type={activeType} /> : null}

          <SectionLabel topMargin={16}>Records</SectionLabel>
          <QueryStates
            query={records}
            gate={gate}
            isEmpty={page.items.length === 0}
            offlineMessage="Reconnect to read this type's records."
            skeleton={<SkeletonList rows={4} lines={3} label="Loading records" />}
            empty={{
              title: "No records of this type",
              description:
                "Nothing has been written against this object type yet, so there is nothing to look up.",
            }}
          >
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginBottom: 8,
              }}
            >
              {customObjectRecordsSummary(page)}
            </Text>
            {page.items.map((record) => (
              <CustomObjectRecordCard
                key={record.id}
                record={record}
                type={activeType}
              />
            ))}
          </QueryStates>
          {records.isError ? (
            <Text
              accessibilityRole="alert"
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
            >
              {customObjectsErrorMessage(records.error)}
            </Text>
          ) : null}
        </QueryStates>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * What the workspace says this type IS: its own key, the property it treats as
 * the natural id, its lifecycle status and the definition version the records
 * below were read against. All four are the server's words.
 */
function TypeSummary({ type }: { type: CustomObjectType }) {
  const { t } = useTheme();
  const parts = [
    `key ${type.key}`,
    type.primaryKey ? `identified by ${type.primaryKey}` : null,
    type.status ? `status ${type.status}` : null,
    type.version !== null ? `definition v${type.version}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginTop: 12,
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
      >
        {type.label}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {parts.join(" · ")}
      </Text>
    </View>
  );
}
