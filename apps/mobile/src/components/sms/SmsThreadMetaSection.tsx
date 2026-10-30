/**
 * SmsThreadMetaSection — operator metadata for one conversation: tags, an
 * internal handoff note, and the consent/subscription activity feed.
 *
 * Mounted by the thread screen inside the list header. Owns its own hooks so
 * the screen adds one line, not three data pipelines. Three honesty rules the
 * copy must keep:
 *   - notes are WRITE-ONLY (no read route returns the stored text) and the
 *     save OVERWRITES — the caption says both;
 *   - a 409 on any write reads as "state moved, refresh/press again", never
 *     as a generic failure;
 *   - the activity feed labels itself as consent evidence plus current list
 *     state, because `historyComplete` is false by contract.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { Card } from "@/components/Card";
import { useToast } from "@/components/Toast";
import {
  useSmsConversationActivity,
  useSmsConversationTags,
  useSmsNotesSave,
  useSmsTagMutations,
} from "@/hooks/useSmsConversationMeta";
import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { smsNotesError, smsTagError } from "@/lib/smsConversationMeta";
import { safeSmsDisplayText } from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function SmsThreadMetaSection({
  phoneE164,
  access,
}: {
  phoneE164: string;
  access: SmsInboxAccess;
}) {
  if (!access.roleAllowed) return null;
  return (
    <View style={{ gap: 10, marginBottom: 10 }}>
      <TagsBlock phoneE164={phoneE164} access={access} />
      <NoteBlock phoneE164={phoneE164} access={access} />
      <ActivityBlock phoneE164={phoneE164} access={access} />
    </View>
  );
}

function SectionTitle({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fg,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.semibold,
      }}
    >
      {text}
    </Text>
  );
}

function Caption({ text, tone = "muted" }: { text: string; tone?: "muted" | "danger" }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityLiveRegion="polite"
      {...typeCap("caption")}
      style={{
        color: tone === "danger" ? t.danger : t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.medium,
      }}
    >
      {text}
    </Text>
  );
}

function TagsBlock({
  phoneE164,
  access,
}: {
  phoneE164: string;
  access: SmsInboxAccess;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const tags = useSmsConversationTags(phoneE164, access);
  const mutate = useSmsTagMutations(phoneE164, access);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // `?? []` only substitutes for null/undefined; a truthy non-array from the
  // wire would reach .map below and throw. Check the type instead.
  const rows = Array.isArray(tags.data?.tags) ? tags.data.tags : [];

  const submit = () => {
    const tag = draft.trim();
    const invalid = smsTagError(tag);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (rows.some((row) => row.tag === tag)) {
      setError("This conversation already carries that tag.");
      return;
    }
    setError(null);
    mutate.mutate(
      { action: "add", tag },
      {
        onSuccess: () => {
          haptics.success();
          setDraft("");
        },
        onError: (failure) => {
          haptics.error();
          toast({
            kind: "error",
            message: writeFailureMessage(failure, "The tag was not added."),
          });
        },
      },
    );
  };

  return (
    <Card>
      <View style={{ gap: 8 }}>
        <SectionTitle text="Tags" />
        {tags.isError ? (
          <Caption tone="danger" text="Tags could not be loaded. Nothing was shown." />
        ) : rows.length === 0 ? (
          <Caption text="No tags on this conversation yet." />
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {rows.map((row) => (
              <Pressable
                key={row.tag}
                onPress={() =>
                  mutate.mutate(
                    {
                      action: "remove",
                      tag: row.tag,
                      expectedCreatedAt: row.createdAt,
                    },
                    {
                      onError: (failure) => {
                        haptics.error();
                        toast({
                          kind: "error",
                          message: writeFailureMessage(
                            failure,
                            "The tag was not removed.",
                          ),
                        });
                      },
                    },
                  )
                }
                disabled={mutate.isPending || !access.canRequest}
                accessibilityRole="button"
                accessibilityLabel={`Remove tag ${row.tag}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  borderWidth: 1,
                  borderColor: t.borderSubtle,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  minHeight: 32,
                }}
              >
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fg,
                    ...typeStyle("caption"),
                    fontFamily: FONT.medium,
                  }}
                >
                  {safeSmsDisplayText(row.tag, 64)} ✕
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {tags.data?.truncated ? (
          <Caption text="Only the first 100 tags are shown." />
        ) : null}
        {access.canRequest ? (
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <TextInput
              {...typeCap("bodySmall")}
              value={draft}
              onChangeText={(next) => {
                setDraft(next);
                setError(null);
              }}
              onSubmitEditing={submit}
              placeholder="Add a tag (e.g. refund, vip)"
              placeholderTextColor={t.fgSubtle}
              accessibilityLabel="New tag"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              style={{
                flex: 1,
                color: t.fg,
                borderColor: t.border,
                borderWidth: 1,
                borderRadius: 10,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontFamily: FONT.regular,
                fontSize: fontSizeFor("bodySmall"),
                minHeight: 40,
              }}
            />
            <Pressable
              onPress={submit}
              disabled={mutate.isPending || draft.trim() === ""}
              accessibilityRole="button"
              accessibilityLabel="Add tag"
              accessibilityState={{
                disabled: mutate.isPending || draft.trim() === "",
              }}
              style={{ minHeight: 40, justifyContent: "center" }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color:
                    mutate.isPending || draft.trim() === ""
                      ? t.fgMuted
                      : t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {mutate.isPending ? "Saving…" : "Add"}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {error ? <Caption tone="danger" text={error} /> : null}
      </View>
    </Card>
  );
}

function NoteBlock({
  phoneE164,
  access,
}: {
  phoneE164: string;
  access: SmsInboxAccess;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const save = useSmsNotesSave(phoneE164, access);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const submit = () => {
    const invalid = smsNotesError(draft.trim());
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    save.mutate(
      { notes: draft.trim() },
      {
        onSuccess: (receipt) => {
          haptics.success();
          setSavedAt(receipt.stateUpdatedAt);
          toast({ kind: "info", message: "Internal note saved." });
        },
        onError: (failure) => {
          haptics.error();
          toast({
            kind: "error",
            message: writeFailureMessage(
              failure,
              "The note was not saved. If the conversation's state moved, press Save again.",
            ),
          });
        },
      },
    );
  };

  if (!access.canRequest) return null;
  return (
    <Card>
      <View style={{ gap: 8 }}>
        <SectionTitle text="Internal note" />
        <Caption text="Operator-only. Saving OVERWRITES the stored note; the server does not expose existing note text to any client." />
        <TextInput
          {...typeCap("bodySmall")}
          value={draft}
          onChangeText={(next) => {
            setDraft(next);
            setError(null);
          }}
          placeholder="Handoff note for the next operator"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Internal note"
          multiline
          style={{
            color: t.fg,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontFamily: FONT.regular,
            fontSize: fontSizeFor("bodySmall"),
            minHeight: 64,
            textAlignVertical: "top",
          }}
        />
        <Pressable
          onPress={submit}
          disabled={save.isPending || draft.trim() === ""}
          accessibilityRole="button"
          accessibilityLabel="Save internal note, overwriting the stored note"
          accessibilityState={{
            disabled: save.isPending || draft.trim() === "",
          }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color:
                save.isPending || draft.trim() === "" ? t.fgMuted : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {save.isPending ? "Saving…" : "Save note"}
          </Text>
        </Pressable>
        {savedAt ? <Caption text={`Saved · state ${dateTime(savedAt)}`} /> : null}
        {error ? <Caption tone="danger" text={error} /> : null}
      </View>
    </Card>
  );
}

function ActivityBlock({
  phoneE164,
  access,
}: {
  phoneE164: string;
  access: SmsInboxAccess;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const activity = useSmsConversationActivity(phoneE164, access, open);
  const events = Array.isArray(activity.data?.events)
    ? activity.data.events
    : [];
  return (
    <Card>
      <View style={{ gap: 8 }}>
        <Pressable
          onPress={() => setOpen((current) => !current)}
          accessibilityRole="button"
          accessibilityLabel={
            open ? "Hide consent activity" : "Show consent activity"
          }
          accessibilityState={{ expanded: open }}
          style={{ minHeight: 32, justifyContent: "center" }}
        >
          <SectionTitle text={open ? "Consent activity ▾" : "Consent activity ▸"} />
        </Pressable>
        {open ? (
          activity.isError ? (
            <Caption
              tone="danger"
              text="Activity could not be loaded. Nothing was shown."
            />
          ) : activity.isLoading ? (
            <Caption text="Loading consent evidence…" />
          ) : events.length === 0 ? (
            <Caption text="No consent evidence or current list state recorded." />
          ) : (
            <View style={{ gap: 6 }}>
              {events.map((event, index) => (
                <Text
                  key={`${event.kind}-${event.at}-${index}`}
                  {...typeCap("caption")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {`${dateTime(event.at)} · ${event.title}`}
                </Text>
              ))}
              <Caption
                text={`Consent evidence and current list state only — not a complete operator log.${
                  activity.data?.truncated ? " Oldest entries were truncated." : ""
                }`}
              />
            </View>
          )
        ) : null}
      </View>
    </Card>
  );
}
