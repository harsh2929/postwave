/**
 * TagManageSheets — the tag screen's maintenance sheets:
 *
 *  - TagEditSheet: cosmetic PATCH (color preset / description / group),
 *    conditional on the row's revision. NO delete verb — both delete
 *    routes are unconditional server-side 409 holds (lib/tagManage), and a
 *    button that always fails is worse than none.
 *  - TagHistorySheet: the tag's membership event feed (viewer).
 *  - TagGroupManageSheet: create / rename / delete groups (editor).
 */
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { useConfirm } from "@/components/ConfirmSheet";
import { ErrorState } from "@/components/ErrorState";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { ModalHeader, SubActionButton } from "@/components/subscriber/SubActionButton";
import { useTagHistory, useTagManageWrites } from "@/hooks/useTagManage";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import type { TagCatalogueRow } from "@/lib/tagCatalogue";
import type { TagGroup } from "@/lib/tagGroups";
import {
  TAG_COLOR_CHOICES,
  buildGroupCreateBody,
  buildGroupRenameBody,
  buildTagPatch,
  tagHistoryLine,
} from "@/lib/tagManage";
import type { ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function TagEditSheet({
  row,
  groups,
  onClose,
  t,
}: {
  /** Null closes the sheet. */
  row: TagCatalogueRow | null;
  groups: readonly TagGroup[];
  onClose: () => void;
  t: ThemeTokens;
}) {
  const { toast } = useToast();
  const writes = useTagManageWrites();
  const [color, setColor] = useState("");
  const [description, setDescription] = useState("");
  const [groupId, setGroupId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (row) {
      setColor("");
      setDescription(row.description ?? "");
      setGroupId(undefined);
    }
  }, [row]);

  if (!row) return null;

  const submit = () => {
    const body = buildTagPatch({
      color,
      description:
        description.trim() === (row.description ?? "") ? "" : description,
      groupId,
    });
    if (!body) {
      haptics.warning();
      toast({ kind: "info", message: "Nothing changed yet." });
      return;
    }
    haptics.tap();
    writes.edit.mutate(
      { id: row.id, etag: row.etag ?? "", body },
      {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "success", message: `Updated “${row.name}”.` });
          onClose();
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `The tag was not updated. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  };

  return (
    <KeyboardFormSheet
      visible
      onClose={onClose}
      accessibilityLabel={`Edit tag ${row.name}`}
    >
      <ModalHeader title={`Edit “${row.name}”`} onClose={onClose} t={t} />
      <View style={{ gap: 12 }}>
        <Text
          {...typeCap("label")}
          style={{ color: t.fgMuted, ...typeStyle("label"), fontFamily: FONT.medium }}
        >
          Color
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {TAG_COLOR_CHOICES.map((preset) => (
            <Chip
              key={preset}
              label={preset}
              active={color === preset}
              onPress={() => setColor(color === preset ? "" : preset)}
              accessibilityLabel={`Color ${preset}`}
            />
          ))}
        </View>
        <Text
          {...typeCap("label")}
          style={{ color: t.fgMuted, ...typeStyle("label"), fontFamily: FONT.medium }}
        >
          Description
        </Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="What this tag means"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Tag description"
          multiline
          {...typeCap("body")}
          style={{
            color: t.fg,
            backgroundColor: t.surface,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            minHeight: 64,
            fontFamily: FONT.regular,
            fontSize: fontSizeFor("body"),
          }}
        />
        {groups.length > 0 ? (
          <>
            <Text
              {...typeCap("label")}
              style={{ color: t.fgMuted, ...typeStyle("label"), fontFamily: FONT.medium }}
            >
              Group
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {groups.map((group) => {
                const activeNow =
                  groupId === undefined
                    ? row.group_id === group.id
                    : groupId === group.id;
                return (
                  <Chip
                    key={group.id}
                    label={group.name}
                    active={activeNow}
                    onPress={() =>
                      setGroupId(activeNow ? "" : group.id)
                    }
                    accessibilityLabel={`Group ${group.name}`}
                  />
                );
              })}
            </View>
          </>
        ) : null}
        <SubActionButton
          label="Save tag"
          onPress={submit}
          disabled={false}
          busy={writes.edit.isPending}
          t={t}
        />
      </View>
    </KeyboardFormSheet>
  );
}

export function TagHistorySheet({
  row,
  onClose,
  t,
}: {
  row: TagCatalogueRow | null;
  onClose: () => void;
  t: ThemeTokens;
}) {
  const history = useTagHistory(row?.id ?? null, row !== null);
  if (!row) return null;
  const view = history.data;
  return (
    <KeyboardFormSheet
      visible
      onClose={onClose}
      accessibilityLabel={`Membership history for ${row.name}`}
    >
      <ModalHeader title={`History: ${row.name}`} onClose={onClose} t={t} />
      {history.isLoading ? (
        <SkeletonList rows={4} />
      ) : history.isError ? (
        <ErrorState
          error={history.error}
          onRetry={() => void history.refetch()}
        />
      ) : !view || view.items.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{ color: t.fgMuted, ...typeStyle("bodySmall"), fontFamily: FONT.regular }}
        >
          No membership events recorded for this tag yet.
        </Text>
      ) : (
        view.items.map((item, i) => (
          <View
            key={`${item.occurredAt}-${i}`}
            accessible
            accessibilityLabel={tagHistoryLine(item)}
            style={{
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingVertical: 8,
              gap: 2,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{ color: t.fg, ...typeStyle("bodySmall"), fontFamily: FONT.regular }}
            >
              {tagHistoryLine(item)}
            </Text>
            {item.occurredAt ? (
              <Text
                {...typeCap("label")}
                style={{ color: t.fgSubtle, ...typeStyle("label"), fontFamily: FONT.regular }}
              >
                {date(item.occurredAt)}
              </Text>
            ) : null}
          </View>
        ))
      )}
    </KeyboardFormSheet>
  );
}

export function TagGroupManageSheet({
  visible,
  groups,
  onClose,
  t,
}: {
  visible: boolean;
  groups: readonly TagGroup[];
  onClose: () => void;
  t: ThemeTokens;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const writes = useTagManageWrites();
  const [newName, setNewName] = useState("");
  const [renames, setRenames] = useState<Record<string, string>>({});

  const report = (receipt: string) => ({
    onSuccess: () => {
      haptics.success();
      toast({ kind: "success", message: receipt });
    },
    onError: (e: unknown) => {
      haptics.error();
      toast({
        kind: "error",
        message: `The group change failed. ${e instanceof Error ? e.message : ""}`.trim(),
      });
    },
  });

  const onCreate = () => {
    const body = buildGroupCreateBody(newName);
    if (!body) {
      haptics.warning();
      toast({ kind: "info", message: "Enter a group name first." });
      return;
    }
    writes.groupCreate.mutate(body, {
      ...report(`Group “${newName.trim()}” created.`),
      onSettled: () => setNewName(""),
    });
  };

  const onRename = (id: string, currentName: string) => {
    const body = buildGroupRenameBody(renames[id] ?? "");
    if (!body || renames[id]?.trim() === currentName) {
      haptics.warning();
      toast({ kind: "info", message: "Enter a different name first." });
      return;
    }
    writes.groupRename.mutate({ id, body }, report("Group renamed."));
  };

  const onDelete = async (id: string, name: string) => {
    const ok = await confirm({
      title: `Delete the group “${name}”?`,
      message:
        "Tags in it are not deleted — they become ungrouped.",
      confirmLabel: "Delete group",
      consequence: "The grouping disappears for everyone.",
      destructive: true,
    });
    if (!ok) return;
    writes.groupDelete.mutate(id, report(`Group “${name}” deleted.`));
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Manage tag groups"
    >
      <ModalHeader title="Tag groups" onClose={onClose} t={t} />
      <View style={{ gap: 10 }}>
        {groups.map((group) => (
          <View key={group.id} style={{ gap: 6 }}>
            <TextInput
              value={renames[group.id] ?? group.name}
              onChangeText={(next) =>
                setRenames((r) => ({ ...r, [group.id]: next }))
              }
              accessibilityLabel={`Group name for ${group.name}`}
              placeholderTextColor={t.fgSubtle}
              {...typeCap("body")}
              {...keyboardChain({
                onSubmit: () => onRename(group.id, group.name),
                disabled: writes.groupRename.isPending,
              })}
              style={{
                color: t.fg,
                backgroundColor: t.surface,
                borderColor: t.border,
                borderWidth: 1,
                borderRadius: 10,
                paddingHorizontal: 12,
                minHeight: 44,
                fontFamily: FONT.regular,
                fontSize: fontSizeFor("body"),
              }}
            />
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Chip
                label="Rename"
                active={false}
                onPress={() => onRename(group.id, group.name)}
                accessibilityLabel={`Rename the group ${group.name}`}
              />
              <Chip
                label="Delete"
                active={false}
                onPress={() => void onDelete(group.id, group.name)}
                accessibilityLabel={`Delete the group ${group.name}`}
              />
            </View>
          </View>
        ))}
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="New group name"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="New group name"
          {...typeCap("body")}
          {...keyboardChain({
            onSubmit: onCreate,
            disabled: writes.groupCreate.isPending,
          })}
          style={{
            color: t.fg,
            backgroundColor: t.surface,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 12,
            minHeight: 44,
            fontFamily: FONT.regular,
            fontSize: fontSizeFor("body"),
          }}
        />
        <Chip
          label={writes.groupCreate.isPending ? "Creating…" : "Create group"}
          active={false}
          onPress={onCreate}
          accessibilityLabel="Create the tag group"
        />
      </View>
    </KeyboardFormSheet>
  );
}
