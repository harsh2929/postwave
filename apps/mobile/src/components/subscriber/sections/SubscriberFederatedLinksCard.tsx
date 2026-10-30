/**
 * SubscriberFederatedLinksCard — SUB-023 cross-workspace identity links on
 * the profile's Data cluster.
 *
 * Desktop's FederatedIdentityPanel translated: the links to master
 * identities in the agency parent workspace, each with its provenance;
 * unlink behind a confirm; a manual link form (two UUIDs) for `canMutate`.
 * Both writes bind to the subscriber_version the LIST carried — the state
 * on screen — so a concurrent profile change 412s honestly.
 */
import { useRef, useState } from "react";
import type { RefObject } from "react";
import { Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { useConfirm } from "@/components/ConfirmSheet";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import {
  useSubscriberFederation,
  useSubscriberFederationWrites,
} from "@/hooks/useSubscriberFederation";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain, type FocusableRef } from "@/lib/keyboardChain";
import {
  buildCreateLinkBody,
  createLinkProblem,
  federationMatchLabel,
} from "@/lib/subscriberFederation";
import { useTheme } from "@/lib/theme";
import type { ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

function IdField({
  label,
  value,
  onChangeText,
  t,
  inputRef,
  next,
  onSubmit,
  submitDisabled,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  t: ThemeTokens;
  /** Set so an earlier field's return key can focus this one. */
  inputRef?: RefObject<TextInput | null>;
  /** The field the return key advances to. */
  next?: FocusableRef;
  /** Terminal action for the last field of the pair. */
  onSubmit?: () => void;
  /** The terminal action is not available yet (a write already in flight). */
  submitDisabled?: boolean;
}) {
  return (
    <TextInput
      ref={inputRef}
      value={value}
      onChangeText={onChangeText}
      placeholder={label}
      placeholderTextColor={t.fgSubtle}
      accessibilityLabel={label}
      autoCapitalize="none"
      autoCorrect={false}
      {...typeCap("body")}
      {...keyboardChain({ next, onSubmit, disabled: submitDisabled })}
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
  );
}

export function SubscriberFederatedLinksCard({
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
  const federation = useSubscriberFederation(subscriberId, open);
  const writes = useSubscriberFederationWrites(subscriberId);
  const [parentTenantId, setParentTenantId] = useState("");
  const [masterSubscriberId, setMasterSubscriberId] = useState("");
  // Two ids typed in order: the first field's return key lands on the second.
  const masterIdRef = useRef<TextInput>(null);

  const view = federation.data;
  const version = view?.subscriberVersion ?? "";

  const onLink = () => {
    const input = { parentTenantId, masterSubscriberId };
    const problem = createLinkProblem(input);
    if (problem) {
      haptics.warning();
      toast({ kind: "info", message: problem });
      return;
    }
    haptics.tap();
    writes.link.mutate(
      { version, body: buildCreateLinkBody(input) },
      {
        onSuccess: () => {
          haptics.success();
          setParentTenantId("");
          setMasterSubscriberId("");
          toast({ kind: "success", message: "Identity link created." });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `The identity link was not created. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  };

  const onUnlink = async (masterId: string) => {
    const ok = await confirm({
      title: "Unlink this identity?",
      message:
        "The cross-workspace link is removed. Both subscriber records stay where they are.",
      confirmLabel: "Unlink",
      consequence: "Agency-level views stop treating them as one person.",
      destructive: true,
    });
    if (!ok) return;
    writes.unlink.mutate(
      { masterSubscriberId: masterId, version },
      {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "info", message: "Identity link removed." });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `The identity link was not removed. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  };

  return (
    <SubscriberDisclosureCard
      title="Federated identities"
      hint="Links to master identities in the agency parent workspace"
      open={open}
      count={view ? view.links.length : null}
      onToggle={() => setOpen((v) => !v)}
    >
      {federation.isLoading ? (
        <SkeletonList rows={2} />
      ) : federation.isError ? (
        <ErrorState
          error={federation.error}
          onRetry={() => void federation.refetch()}
        />
      ) : !view || view.links.length === 0 ? (
        <DisclosureEmptyLine text="No cross-workspace identity links exist for this contact." />
      ) : (
        view.links.map((link) => (
          <View
            key={link.id}
            style={{
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingVertical: 8,
              gap: 4,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              accessibilityLabel={`Master identity ${link.masterSubscriberId}, ${federationMatchLabel(link.matchType)}`}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
            >
              {link.masterSubscriberId}
            </Text>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
            >
              {federationMatchLabel(link.matchType)}
              {link.matchKey ? ` · ${link.matchKey}` : ""} · workspace{" "}
              {link.parentTenantId}
            </Text>
            {canMutate ? (
              <Chip
                label="Unlink"
                active={false}
                onPress={() => void onUnlink(link.masterSubscriberId)}
                accessibilityLabel={`Unlink master identity ${link.masterSubscriberId}`}
              />
            ) : null}
          </View>
        ))
      )}

      {canMutate && !federation.isLoading && !federation.isError ? (
        <View style={{ marginTop: 10, gap: 6 }}>
          <IdField
            label="Parent workspace id"
            value={parentTenantId}
            onChangeText={setParentTenantId}
            t={t}
            next={masterIdRef}
          />
          <IdField
            label="Master subscriber id"
            value={masterSubscriberId}
            onChangeText={setMasterSubscriberId}
            t={t}
            inputRef={masterIdRef}
            onSubmit={onLink}
            submitDisabled={writes.link.isPending}
          />
          <Chip
            label={writes.link.isPending ? "Linking…" : "Link identity"}
            active={false}
            onPress={onLink}
            accessibilityLabel="Link this subscriber to a master identity"
          />
        </View>
      ) : null}
    </SubscriberDisclosureCard>
  );
}
