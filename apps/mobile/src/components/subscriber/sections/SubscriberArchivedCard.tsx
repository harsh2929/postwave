/**
 * SubscriberArchivedCard — "this contact is soft-deleted, and here is the way
 * back" (AUDIENCE#56).
 *
 * SUB-009 soft delete is fully implemented server-side and desktop ships a
 * "show archived" chip, but mobile had neither the view nor the undo — so
 * "I removed the wrong person" was unrecoverable from a phone, which is
 * precisely the device you are holding when you notice.
 *
 * DELIBERATELY RESTORE-ONLY. The card offers the way BACK and never the way
 * out. Archiving is a bulk, deliberate, desk-shaped decision (desktop drives it
 * from a browse panel over a selection); recovery is the phone-shaped half, and
 * shipping only that half keeps the destructive verb where the keyboard is
 * while making the reversal available where the panic is.
 *
 * The restore carries the row's `version` as an exact `If-Match` — see
 * hooks/useSubscriberArchive.ts for why the endpoint refuses without it, and
 * why a 412 here is a real, expected outcome rather than a fault.
 */
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { SubActionButton } from "@/components/subscriber/SubActionButton";
import { useToast } from "@/components/Toast";
import {
  archiveFailureMessage,
  useUnarchiveSubscriber,
} from "@/hooks/useSubscriberArchive";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberArchivedCard({
  subscriberId,
  archivedAt,
  version,
  canMutate,
  disabledReason,
}: {
  subscriberId: string;
  /** `archived_at` off the detail GET. Null/undefined = the row is active. */
  archivedAt?: string | null | undefined;
  /** The row's `version` ETag, verbatim. Absent = restore cannot be offered. */
  version?: string | null | undefined;
  /** Online AND holding at least an editor role (write:subscribers). */
  canMutate: boolean;
  disabledReason?: string | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const unarchive = useUnarchiveSubscriber();

  // Active row — say nothing. An "Not archived" card would be noise on every
  // profile in the workspace.
  if (!archivedAt) return null;

  const since = relativeTime(archivedAt, { fallback: "" });
  const exactWhen = dateTime(archivedAt, "");
  const token = (version ?? "").trim();
  // The endpoint 428s without an exact revision token, so a row loaded from a
  // representation that carried none cannot offer a button that could work.
  const blockedReason = !canMutate
    ? disabledReason
    : token === ""
      ? "This contact was loaded without a revision token. Pull to refresh first."
      : undefined;
  const canRestore = canMutate && token !== "";

  async function onRestore() {
    if (!canRestore) return;
    const ok = await confirm({
      title: "Restore this contact?",
      message:
        "They return to the active audience and become eligible for campaigns and flows again.",
      confirmLabel: "Restore",
      cancelLabel: "Leave archived",
    });
    if (!ok) return;
    try {
      await unarchive.mutateAsync({ id: subscriberId, version: token });
      haptics.success();
      toast({ kind: "success", message: "Contact restored" });
    } catch (e: unknown) {
      haptics.error();
      const status =
        e && typeof e === "object" && "status" in e
          ? Number((e as { status?: unknown }).status)
          : 0;
      toast({
        kind: "error",
        message: archiveFailureMessage(
          status,
          false,
          e instanceof Error ? e.message : "Couldn't restore this contact.",
        ),
      });
    }
  }

  return (
    <Card style={{ marginTop: 12, borderColor: t.warning }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Label>Archived</Label>
        {/* The state is a WORD as well as a border colour. */}
        <Pill label="Archived" tone="warning" />
      </View>
      <Text
        accessibilityLabel={`This contact is archived${since ? `, ${since}` : ""}. Archived contacts are hidden from the audience and receive nothing.`}
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          marginTop: 8,
          fontFamily: FONT.regular,
        }}
      >
        This contact is hidden from the audience. Campaigns, flows and segments
        skip archived contacts entirely.
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {since
          ? `Archived ${since}${exactWhen ? ` · ${exactWhen}` : ""}`
          : "Archived date unknown"}
      </Text>
      <View style={{ flexDirection: "row", marginTop: 12 }}>
        <SubActionButton
          label={unarchive.isPending ? "Restoring…" : "Restore contact"}
          onPress={() => void onRestore()}
          disabled={!canRestore}
          busy={unarchive.isPending}
          {...(!canRestore && blockedReason
            ? { disabledReason: blockedReason }
            : {})}
          t={t}
        />
      </View>
    </Card>
  );
}
