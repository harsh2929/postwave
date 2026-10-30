/**
 * BotOpensCard — how much of the open rate is machines, and the signature
 * list that decides the split.
 *
 * The stats/signature reads are viewer-scoped but ARMED by a press: both walk
 * open history, and this card sits in a cluster that must not fan out reads
 * nobody asked for. Signature create/delete are ScopeAdmin and ONLINE-ONLY —
 * a queued pattern change re-classifies opens recorded between queue and
 * replay. Default (platform-shipped) signatures carry no delete verb because
 * the server would only 404 it.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import {
  OpsAction,
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
  OpsTextInput,
} from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  useBotOpenSignatures,
  useBotOpenStats,
  useCreateBotOpenSignature,
  useDeleteBotOpenSignature,
} from "@/hooks/useDeliverabilityBotOpens";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isAdminRole } from "@/lib/campaignAccess";
import { botOpenShareCaption } from "@/lib/deliverabilityOpsView";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function BotOpensCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [armed, setArmed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [pattern, setPattern] = useState("");

  const stats = useBotOpenStats(armed);
  const signatures = useBotOpenSignatures(armed);
  const create = useCreateBotOpenSignature();
  const remove = useDeleteBotOpenSignature();

  const admin = isAdminRole(gate.effectiveRole);
  const offline = !gate.enabled;

  if (!armed) {
    return (
      <OpsCard>
        <OpsCardTitle>Bot opens</OpsCardTitle>
        <OpsCardBody>
          How much of the open rate is machines — Apple MPP prefetch, security
          scanners — versus people.
        </OpsCardBody>
        {offline ? (
          <OpsCardBody>Open-quality stats can&apos;t be read offline.</OpsCardBody>
        ) : (
          <OpsAction label="Check open quality" onPress={() => setArmed(true)} />
        )}
      </OpsCard>
    );
  }

  const body = offline
    ? "Open-quality stats can't be read offline."
    : stats.isError
      ? "Bot-open stats couldn't be loaded — the human/machine split is unknown."
      : !stats.data
        ? "Analysing recorded opens…"
        : botOpenShareCaption(stats.data);

  const customSignatures = Array.isArray(signatures.data)
    ? signatures.data.filter((signature) => !signature.isDefault)
    : [];
  const defaultCount = Array.isArray(signatures.data)
    ? signatures.data.length - customSignatures.length
    : 0;

  const onCreate = () => {
    haptics.tap();
    create.mutate(
      { label: label.trim(), pattern: pattern.trim() },
      {
        onSuccess: () => {
          setLabel("");
          setPattern("");
          setAdding(false);
          toast({ kind: "success", message: "Signature added — future opens matching it count as machines." });
        },
        onError: (err) => {
          haptics.error();
          toast({
            kind: "error",
            message: errorPresentation(err).message || "Couldn't add the signature.",
          });
        },
      },
    );
  };

  const onDelete = async (id: string, name: string) => {
    haptics.tap();
    const ok = await confirm({
      title: `Remove "${name}"?`,
      message:
        "Future opens matching this pattern will count as human again. Already-recorded opens are not re-classified.",
      confirmLabel: "Remove signature",
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(id, {
      onSuccess: () => toast({ kind: "success", message: "Signature removed." }),
      onError: (err) => {
        haptics.error();
        toast({
          kind: "error",
          message: errorPresentation(err).message || "Couldn't remove the signature.",
        });
      },
    });
  };

  return (
    <OpsCard>
      <OpsCardTitle>Bot opens</OpsCardTitle>
      <OpsCardBody {...(stats.isError ? { role: "alert" as const } : {})}>
        {body}
      </OpsCardBody>
      {stats.data && stats.data.bySignature.length > 0 ? (
        <View style={{ gap: 2 }}>
          {stats.data.bySignature.slice(0, 4).map((bucket) => (
            <Text
              key={bucket.label}
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
            >
              {`${bucket.label}: ${bucket.opens} opens`}
            </Text>
          ))}
        </View>
      ) : null}
      {signatures.isError && !offline ? (
        <OpsCardBody role="alert">
          The signature list couldn&apos;t be loaded.
        </OpsCardBody>
      ) : null}
      {customSignatures.map((signature) => (
        <View
          key={signature.id}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 8,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              {...typeCap("bodySmall")}
              style={{ color: t.fg, ...typeStyle("bodySmall"), fontFamily: FONT.medium }}
              numberOfLines={1}
            >
              {signature.label || signature.pattern}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{ color: t.fgSubtle, ...typeStyle("caption"), fontFamily: FONT.regular }}
              numberOfLines={1}
            >
              {signature.pattern}
            </Text>
          </View>
          {!signature.enabled ? <Pill label="off" tone="neutral" /> : null}
          {admin && !offline ? (
            <OpsAction
              label="Remove"
              onPress={() => void onDelete(signature.id, signature.label || signature.pattern)}
              disabled={remove.isPending}
              destructive
              accessibilityLabel={`Remove the ${signature.label || signature.pattern} signature`}
            />
          ) : null}
        </View>
      ))}
      {defaultCount > 0 ? (
        <OpsCardBody>
          {`${defaultCount} platform signature${defaultCount === 1 ? "" : "s"} always apply and can't be removed per-workspace.`}
        </OpsCardBody>
      ) : null}
      {admin && !offline && !adding ? (
        <OpsAction label="Add a signature" onPress={() => setAdding(true)} />
      ) : null}
      {admin && !offline && adding ? (
        <View style={{ gap: 8 }}>
          <OpsTextInput
            value={label}
            onChangeText={setLabel}
            placeholder="Label (e.g. Corporate scanner)"
            accessibilityLabel="Signature label"
          />
          <OpsTextInput
            value={pattern}
            onChangeText={setPattern}
            placeholder="User-agent pattern"
            accessibilityLabel="User-agent pattern to classify as a machine"
          />
          <View style={{ flexDirection: "row", gap: 16 }}>
            <OpsAction
              label={create.isPending ? "Adding…" : "Add signature"}
              onPress={onCreate}
              disabled={create.isPending || !label.trim() || !pattern.trim()}
            />
            <OpsAction label="Cancel" onPress={() => setAdding(false)} />
          </View>
        </View>
      ) : null}
    </OpsCard>
  );
}
