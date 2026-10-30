/**
 * SubscriberEmailsCard — SUB-016 alternate addresses on the profile
 * ("also reach me at my work address"), on the disclosure idiom.
 *
 * Desktop's SubscriberEmailsSection translated with its boundaries intact:
 *  - the PRIMARY address is identity — no remove verb here (rotation is the
 *    subscriber editor's job, stated on the row);
 *  - a consent change is a REVIEWED decision: the same ConsentEvidenceSheet
 *    as Resubscribe/channel-consents, never a bare toggle;
 *  - suppression is its own axis with a mandatory operator reason;
 *  - every per-address write binds to the ADDRESS revision on screen
 *    (If-Match), so a concurrent change 412s honestly.
 * Verbs exist only for `canMutate`; a viewer sees the state.
 */
import { useState } from "react";
import { Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { useConfirm } from "@/components/ConfirmSheet";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { ConsentEvidenceSheet } from "@/components/subscriber/ConsentEvidenceSheet";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import {
  useSubscriberEmailWrites,
  useSubscriberEmails,
} from "@/hooks/useSubscriberEmails";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import {
  addEmailProblem,
  buildAddEmailBody,
  buildEmailConsentPatch,
  buildEmailSuppressionPatch,
  emailConsentLabel,
  type SubscriberEmailRow,
} from "@/lib/subscriberEmails";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

type ConsentReview = {
  row: SubscriberEmailRow;
  nextStatus: "subscribed" | "unsubscribed";
};

export function SubscriberEmailsCard({
  subscriberId,
  canMutate,
}: {
  subscriberId: string;
  canMutate: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const emails = useSubscriberEmails(subscriberId, open);
  const writes = useSubscriberEmailWrites(subscriberId);
  const [review, setReview] = useState<ConsentReview | null>(null);
  const [draftEmail, setDraftEmail] = useState("");

  const rows = Array.isArray(emails.data) ? emails.data : [];

  const onAdd = () => {
    const problem = addEmailProblem(rows, draftEmail);
    if (problem) {
      haptics.warning();
      toast({ kind: "info", message: problem });
      return;
    }
    haptics.tap();
    writes.add.mutate(buildAddEmailBody(draftEmail), {
      onSuccess: () => {
        haptics.success();
        setDraftEmail("");
        toast({
          kind: "success",
          message:
            "Address attached with no recorded consent — granting it is a separate reviewed step.",
        });
      },
      onError: (e: unknown) => {
        haptics.error();
        toast({
          kind: "error",
          message: `Couldn't attach the address. ${e instanceof Error ? e.message : ""}`.trim(),
        });
      },
    });
  };

  const onToggleSuppression = async (row: SubscriberEmailRow) => {
    const suppress = !row.suppressed;
    const ok = await confirm({
      title: suppress
        ? `Suppress ${row.email}?`
        : `Lift the suppression on ${row.email}?`,
      message: suppress
        ? "No sends will reach this address while the hold stands. Its consent state is untouched."
        : "Sends may reach this address again, subject to its consent state.",
      confirmLabel: suppress ? "Suppress" : "Unsuppress",
      consequence: "The change is recorded with your operator reason.",
      destructive: suppress,
    });
    if (!ok) return;
    const body = buildEmailSuppressionPatch(
      suppress,
      suppress
        ? "Manual suppression recorded from the mobile profile"
        : "Manual unsuppression recorded from the mobile profile",
    );
    if (!body) return;
    writes.update.mutate(
      { emailId: row.id, version: row.version, body },
      {
        onSuccess: () => {
          haptics.success();
          toast({
            kind: "success",
            message: suppress
              ? `${row.email} is suppressed.`
              : `Suppression lifted for ${row.email}.`,
          });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `The suppression change was not recorded. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  };

  const onRemove = async (row: SubscriberEmailRow) => {
    const ok = await confirm({
      title: `Remove ${row.email}?`,
      message:
        "The address and its per-address consent history leave this profile.",
      confirmLabel: "Remove address",
      consequence: "This cannot be undone from the app.",
      destructive: true,
    });
    if (!ok) return;
    writes.remove.mutate(
      { emailId: row.id, version: row.version },
      {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "info", message: `${row.email} removed.` });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `The address was not removed. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  };

  return (
    <SubscriberDisclosureCard
      title="Email addresses"
      hint="Alternate addresses with per-address consent and suppression"
      open={open}
      count={emails.data ? emails.data.length : null}
      onToggle={() => setOpen((v) => !v)}
    >
      {emails.isLoading ? (
        <SkeletonList rows={2} />
      ) : emails.isError ? (
        <ErrorState error={emails.error} onRetry={() => void emails.refetch()} />
      ) : rows.length === 0 ? (
        <DisclosureEmptyLine text="Only the canonical address is on file." />
      ) : (
        rows.map((row) => (
          <View
            key={row.id}
            style={{
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingVertical: 8,
              gap: 6,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              accessibilityLabel={`${row.email}${row.isPrimary ? ", primary address" : ""}, ${emailConsentLabel(row.consentStatus)}${row.suppressed ? ", suppressed" : ""}`}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.medium,
              }}
              numberOfLines={1}
            >
              {row.email}
              {row.isPrimary ? "  · Primary" : ""}
            </Text>
            <Text
              {...typeCap("label")}
              style={{
                color: row.suppressed ? t.warning : t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {emailConsentLabel(row.consentStatus)}
              {row.suppressed ? " · Suppressed" : ""}
              {row.isPrimary
                ? " · Identity changes happen in the web editor"
                : ""}
            </Text>
            {canMutate ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <Chip
                  label={
                    row.consentStatus === "subscribed"
                      ? "Review opt-out"
                      : "Review opt-in"
                  }
                  active={false}
                  onPress={() => {
                    haptics.tap();
                    setReview({
                      row,
                      nextStatus:
                        row.consentStatus === "subscribed"
                          ? "unsubscribed"
                          : "subscribed",
                    });
                  }}
                  accessibilityLabel={`Review consent for ${row.email}`}
                />
                <Chip
                  label={row.suppressed ? "Unsuppress" : "Suppress"}
                  active={false}
                  onPress={() => void onToggleSuppression(row)}
                  accessibilityLabel={`${row.suppressed ? "Lift the suppression on" : "Suppress"} ${row.email}`}
                />
                {row.isPrimary ? null : (
                  <Chip
                    label="Remove"
                    active={false}
                    onPress={() => void onRemove(row)}
                    accessibilityLabel={`Remove ${row.email} from this profile`}
                  />
                )}
              </View>
            ) : null}
          </View>
        ))
      )}

      {canMutate && !emails.isLoading && !emails.isError ? (
        <View style={{ marginTop: 10, gap: 6 }}>
          <TextInput
            value={draftEmail}
            onChangeText={setDraftEmail}
            placeholder="work@example.com"
            placeholderTextColor={t.fgSubtle}
            accessibilityLabel="New alternate address"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            {...typeCap("body")}
            // The only field in this mini-form, so the return key does what
            // the Attach button does. `onAdd` owns the validation either way.
            {...keyboardChain({ onSubmit: onAdd })}
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
            label={writes.add.isPending ? "Attaching…" : "Attach address"}
            active={false}
            onPress={onAdd}
            accessibilityLabel="Attach this address to the profile"
          />
        </View>
      ) : null}

      <ConsentEvidenceSheet
        visible={review !== null}
        title={
          review?.nextStatus === "unsubscribed"
            ? `Opt out: ${review?.row.email ?? ""}`
            : `Opt in: ${review?.row.email ?? ""}`
        }
        subtitle={
          review?.nextStatus === "unsubscribed"
            ? "Records a reviewed opt-out for this address only."
            : "Creates a reviewed marketing grant for this address only. Suppressions still apply."
        }
        requireEvidence={review?.nextStatus === "subscribed"}
        submitLabel={
          review?.nextStatus === "unsubscribed"
            ? "Record opt-out"
            : "Record opt-in"
        }
        busy={writes.update.isPending}
        submitError={
          writes.update.error instanceof Error
            ? writes.update.error.message
            : undefined
        }
        onClose={() => {
          if (!writes.update.isPending) setReview(null);
        }}
        onSubmit={(draft) => {
          if (!review) return;
          haptics.warning();
          writes.update.mutate(
            {
              emailId: review.row.id,
              version: review.row.version,
              body: buildEmailConsentPatch(review.nextStatus, draft),
            },
            {
              onSuccess: () => {
                haptics.success();
                setReview(null);
                toast({
                  kind: "success",
                  message: `Consent recorded for ${review.row.email}.`,
                });
              },
              onError: () => haptics.error(),
            },
          );
        }}
      />
    </SubscriberDisclosureCard>
  );
}
