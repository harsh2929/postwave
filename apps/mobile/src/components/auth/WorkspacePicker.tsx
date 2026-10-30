/**
 * WorkspacePicker — the multi-workspace step of session sign-in.
 *
 * Extracted from sign-in.tsx, and made usable on the way out. The old markup
 * rendered `{w.email || "Workspace"}` as every row's title and the raw 36-char
 * `tenant_id` as its subtitle — but every row carries the SAME user's email,
 * so the title was identical across rows and a UUID was the only thing telling
 * them apart. An agency operator with 30 client workspaces got 30 rows
 * discriminated only by hex.
 *
 * The wire type genuinely carries nothing else (`{tenant_id, email}` — see
 * apps/api/internal/auth/handlers.go's Login), so the honest fix is to make
 * the UUID scannable rather than pretend to a name: a short prefix, middle
 * ellipsis, and an index so a user can be told "the second one". A backend
 * change to include workspace_name/slug is noted for the orchestrator.
 *
 * Long lists go through FlatList so 30+ rows are not all mounted at once.
 */
import { FlatList, Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface WorkspaceChoice {
  tenant_id: string;
  email: string;
}

/** Above this, render virtualized instead of mapping inside the ScrollView. */
const VIRTUALIZE_ABOVE = 8;

export function WorkspacePicker({
  workspaces,
  selected,
  onSelect,
  headingRef,
}: {
  workspaces: readonly WorkspaceChoice[];
  selected: string;
  onSelect: (tenantId: string) => void;
  headingRef?: React.Ref<Text> | undefined;
}) {
  const { t } = useTheme();
  const rows = workspaces.map((workspace, index) => ({ workspace, index }));

  return (
    <View
      style={{ marginTop: 4, marginBottom: 12 }}
      accessibilityRole="radiogroup"
      accessibilityLabel={`Pick a workspace, ${workspaces.length} available`}
    >
      <Text
        ref={headingRef}
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {workspaces.length > 1
          ? `Pick a workspace (${workspaces.length})`
          : "Confirm workspace"}
      </Text>
      {rows.length > VIRTUALIZE_ABOVE ? (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.workspace.tenant_id}
          style={{ maxHeight: 320 }}
          nestedScrollEnabled
          renderItem={({ item }) => (
            <WorkspaceRow
              workspace={item.workspace}
              index={item.index}
              active={item.workspace.tenant_id === selected}
              onSelect={onSelect}
            />
          )}
          {...MOBILE_LIST_PERF_PROPS}
        />
      ) : (
        rows.map((row) => (
          <WorkspaceRow
            key={row.workspace.tenant_id}
            workspace={row.workspace}
            index={row.index}
            active={row.workspace.tenant_id === selected}
            onSelect={onSelect}
          />
        ))
      )}
    </View>
  );
}

function WorkspaceRow({
  workspace,
  index,
  active,
  onSelect,
}: {
  workspace: WorkspaceChoice;
  index: number;
  active: boolean;
  onSelect: (tenantId: string) => void;
}) {
  const { t } = useTheme();
  const shortId = workspace.tenant_id.slice(0, 8);
  return (
    <Pressable
      onPress={() => onSelect(workspace.tenant_id)}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Workspace ${index + 1}, id ${shortId}`}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: 1,
        minHeight: 44,
        justifyContent: "center",
        borderColor: active ? t.accent : t.border,
        backgroundColor: active ? t.accentSubtle : t.surface,
        marginBottom: 8,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          ...typeStyle("callout"),
        }}
        numberOfLines={1}
      >
        {`Workspace ${index + 1}`}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {`${shortId} · ${workspace.email || "no email"}`}
      </Text>
    </Pressable>
  );
}
