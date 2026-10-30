/**
 * SubscriberNotesCard — the operator memo pane on a subscriber profile.
 *
 * "Met at SaaStr, wants enterprise pricing" is the note you write within
 * sixty seconds of the conversation, on the device in your hand. Full CRUD
 * has been mounted server-side (SUB-097) since before mobile shipped a
 * subscriber profile, and mobile had no notes code at all.
 *
 * Self-contained like SubscriberListsCard: the profile passes identity and
 * permission, the card owns its own query, sheet and writes.
 *
 * Deleting a note is NOT reversible server-side — there is no restore
 * endpoint — so it takes a ConfirmSheet rather than a toast-with-undo,
 * which is exactly the split the Toast/ConfirmSheet contract prescribes.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { NoteComposerSheet } from "@/components/subscriber/NoteComposerSheet";
import { SubActionButton } from "@/components/subscriber/SubActionButton";
import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import {
  useCreateSubscriberNote,
  useDeleteSubscriberNote,
  useSubscriberNotes,
} from "@/hooks/useSubscriberNotes";
import { FONT } from "@/lib/fonts";
import { plural, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { noteSpokenLabel, type SubscriberNote } from "@/lib/subscriberNotes";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberNotesCard({
  subscriberId,
  email,
  canMutate,
  disabledReason,
}: {
  subscriberId: string;
  email: string;
  canMutate: boolean;
  disabledReason?: string | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const notes = useSubscriberNotes(subscriberId);
  const create = useCreateSubscriberNote();
  const remove = useDeleteSubscriberNote();
  const [composerOpen, setComposerOpen] = useState(false);

  const rows = Array.isArray(notes.data) ? notes.data : [];

  function onSave(body: string) {
    create.mutate(
      { id: subscriberId, body },
      {
        onSuccess: () => {
          haptics.success();
          setComposerOpen(false);
          toast({ kind: "success", message: "Note added" });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `Couldn't save that note. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  }

  async function onDelete(note: SubscriberNote) {
    if (!canMutate) return;
    const ok = await confirm({
      title: "Delete this note?",
      message: "Notes can't be restored. The audit trail loses this entry.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(
      { id: subscriberId, noteId: note.id },
      {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "info", message: "Note deleted" });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `Couldn't delete that note. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  }

  return (
    <Card style={{ marginTop: 12 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Label>Notes</Label>
        {rows.length > 0 ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {plural(rows.length, "note")}
          </Text>
        ) : null}
      </View>

      {/* A failed load must never render as "no notes" — that reads as a
          fact about the subscriber rather than a failed request. */}
      {notes.isLoading && rows.length === 0 ? (
        <View style={{ marginTop: 8 }}>
          <SkeletonList rows={2} />
        </View>
      ) : notes.isError ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          Couldn&apos;t load notes.
        </Text>
      ) : rows.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          No notes yet. Jot what you just learned about this person.
        </Text>
      ) : (
        <View style={{ marginTop: 10, gap: 10 }}>
          {rows.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              canMutate={canMutate}
              {...(disabledReason ? { disabledReason } : {})}
              busy={remove.isPending}
              onDelete={() => void onDelete(note)}
            />
          ))}
        </View>
      )}

      <View style={{ flexDirection: "row", marginTop: 12 }}>
        <SubActionButton
          label="Add note"
          onPress={() => setComposerOpen(true)}
          disabled={!canMutate}
          {...(!canMutate && disabledReason ? { disabledReason } : {})}
          t={t}
        />
      </View>

      <NoteComposerSheet
        visible={composerOpen}
        onClose={() => setComposerOpen(false)}
        onSave={onSave}
        email={email}
        busy={create.isPending}
        t={t}
      />
    </Card>
  );
}

function NoteRow({
  note,
  canMutate,
  disabledReason,
  busy,
  onDelete,
}: {
  note: SubscriberNote;
  canMutate: boolean;
  disabledReason?: string | undefined;
  busy: boolean;
  onDelete: () => void;
}) {
  const { t } = useTheme();
  const when = relativeTime(note.createdAt, { fallback: "" });

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
      }}
    >
      <Text
        selectable
        // One spoken sentence: pinned state is otherwise conveyed by a
        // visual marker alone, and the byline reads as three fragments.
        accessibilityLabel={noteSpokenLabel(note, when)}
        // The note body is the one genuinely long-form string on this
        // profile, so it takes `callout` — prose that reflows freely.
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.regular,
        }}
      >
        {note.pinned ? "📌 " : ""}
        {note.body}
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 6,
        }}
      >
        <Text
          numberOfLines={1}
          // The row above already speaks author + time; this line is a
          // visual duplicate, so keep it out of the VoiceOver stream.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...typeCap("caption")}
          style={{
            flex: 1,
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {[note.authorEmail, when].filter(Boolean).join(" · ")}
        </Text>
        <Pressable
          onPress={onDelete}
          disabled={!canMutate || busy}
          accessibilityRole="button"
          accessibilityLabel="Delete note"
          accessibilityState={{ disabled: !canMutate || busy }}
          {...(!canMutate && disabledReason
            ? { accessibilityHint: disabledReason }
            : {})}
          hitSlop={12}
          style={{
            minHeight: 44,
            minWidth: 44,
            alignItems: "flex-end",
            justifyContent: "center",
            opacity: canMutate ? 1 : 0.4,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.danger,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Delete
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
