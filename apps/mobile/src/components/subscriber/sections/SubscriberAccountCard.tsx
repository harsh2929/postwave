/**
 * SubscriberAccountCard — SUB-012 "which company does this contact belong
 * to", on the profile's disclosure idiom.
 *
 * Desktop's AccountSection translated: the current link stated first, the
 * directory as tappable rows (pick to relink), Unlink, and an inline
 * create-and-link (name + industry). All FK edits bind to the subscriber
 * revision on screen. Verbs exist only for `canMutate`.
 */
import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import {
  useAccountsDirectory,
  useSubscriberAccountWrites,
} from "@/hooks/useSubscriberAccount";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import {
  buildCreateAccountBody,
  createAccountProblem,
  linkedAccountLine,
} from "@/lib/subscriberAccount";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberAccountCard({
  subscriberId,
  accountId,
  version,
  canMutate,
}: {
  subscriberId: string;
  /** The detail row's account_id FK (null/undefined = unlinked). */
  accountId: string | null | undefined;
  /** The detail row's strong revision — every write echoes it. */
  version: string | null | undefined;
  canMutate: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const directory = useAccountsDirectory(open);
  const writes = useSubscriberAccountWrites(subscriberId);
  const [newName, setNewName] = useState("");
  const [newIndustry, setNewIndustry] = useState("");
  const industryRef = useRef<TextInput>(null);

  // `??` only substitutes for null/undefined: a truthy non-array from the wire
  // would reach the `.map` below and take the card down with it.
  const accounts = Array.isArray(directory.data) ? directory.data : [];
  const currentLine = linkedAccountLine(accounts, accountId);
  const rowVersion = version ?? "";

  const report = {
    onError: (e: unknown) => {
      haptics.error();
      toast({
        kind: "error",
        message: `The account link was not changed. ${e instanceof Error ? e.message : ""}`.trim(),
      });
    },
  };

  const onPick = (nextId: string | null, receipt: string) => {
    haptics.tap();
    writes.setAccount.mutate(
      { accountId: nextId, version: rowVersion },
      {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "success", message: receipt });
        },
        ...report,
      },
    );
  };

  const onCreateAndLink = () => {
    const problem = createAccountProblem(newName);
    if (problem) {
      haptics.warning();
      toast({ kind: "info", message: problem });
      return;
    }
    haptics.tap();
    writes.createAndLink.mutate(
      { body: buildCreateAccountBody(newName, newIndustry), version: rowVersion },
      {
        onSuccess: () => {
          haptics.success();
          toast({
            kind: "success",
            message: `${newName.trim()} created and linked.`,
          });
          setNewName("");
          setNewIndustry("");
        },
        ...report,
      },
    );
  };

  return (
    <SubscriberDisclosureCard
      title="Company account"
      hint="The B2B account this contact belongs to"
      open={open}
      count={null}
      onToggle={() => setOpen((v) => !v)}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: currentLine ? t.fg : t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {currentLine ?? "Not linked to any account."}
      </Text>

      {directory.isLoading ? (
        <SkeletonList rows={2} />
      ) : directory.isError ? (
        <ErrorState
          error={directory.error}
          onRetry={() => void directory.refetch()}
        />
      ) : canMutate ? (
        <>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 8,
            }}
          >
            {accounts.map((account) => (
              <Chip
                key={account.id}
                label={account.name}
                active={account.id === accountId}
                onPress={() => {
                  if (account.id === accountId) return;
                  onPick(account.id, `Linked to ${account.name}.`);
                }}
                accessibilityLabel={`Link this contact to ${account.name}`}
              />
            ))}
            {accountId ? (
              <Chip
                label="Unlink"
                active={false}
                onPress={() => onPick(null, "Account link removed.")}
                accessibilityLabel="Remove the account link"
              />
            ) : null}
          </View>
          <View style={{ marginTop: 10, gap: 6 }}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="New company name"
              placeholderTextColor={t.fgSubtle}
              accessibilityLabel="New company name"
              autoCapitalize="words"
              {...typeCap("body")}
              {...keyboardChain({ next: industryRef })}
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
            <TextInput
              ref={industryRef}
              value={newIndustry}
              onChangeText={setNewIndustry}
              placeholder="Industry (optional)"
              placeholderTextColor={t.fgSubtle}
              accessibilityLabel="Industry"
              autoCapitalize="words"
              {...typeCap("body")}
              {...keyboardChain({
                onSubmit: onCreateAndLink,
                disabled: writes.createAndLink.isPending,
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
              label={
                writes.createAndLink.isPending
                  ? "Creating…"
                  : "Create company and link"
              }
              active={false}
              onPress={onCreateAndLink}
              accessibilityLabel="Create this company and link the contact to it"
            />
          </View>
        </>
      ) : accounts.length === 0 && !currentLine ? (
        <DisclosureEmptyLine text="No accounts exist in this workspace yet." />
      ) : null}
    </SubscriberDisclosureCard>
  );
}
