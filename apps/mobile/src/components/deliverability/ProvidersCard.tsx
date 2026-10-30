/**
 * ProvidersCard — the ESP connections that feed deliverability evidence
 * (bounce/complaint webhooks, suppression mirrors).
 *
 * The list is a viewer read; create / activate / deactivate / remove are
 * ScopeAdmin and ONLINE-ONLY (secret-adjacent configuration never rides the
 * outbox). Secrets never render: the GET is redacted server-side, so the row
 * makes presence-only claims ("webhook token set"), and the create form's
 * credential field is a runtime-secret NAME, never a key — the same rule
 * desktop's ProviderConfigCard enforces.
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
import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import {
  useCreateProviderConnection,
  useDeleteProviderConnection,
  useProviderConnections,
  useSetProviderConnection,
} from "@/hooks/useDeliverabilityProviders";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isAdminRole } from "@/lib/campaignAccess";
import {
  DELIVERABILITY_PROVIDERS,
  providerCredentialRefError,
  providerSecretSummary,
  providerTokenError,
} from "@/lib/deliverabilityOpsView";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ProvidersCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const query = useProviderConnections();
  const create = useCreateProviderConnection();
  const set = useSetProviderConnection();
  const remove = useDeleteProviderConnection();

  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<string>(DELIVERABILITY_PROVIDERS[0]);
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [credentialRef, setCredentialRef] = useState("");

  const admin = isAdminRole(gate.effectiveRole);
  const offline = !gate.enabled;
  const connections = Array.isArray(query.data) ? query.data : [];

  const tokenError = providerTokenError(token);
  const refError = providerCredentialRefError(credentialRef);
  const formError =
    tokenError ?? refError ?? (displayName.trim() ? null : "Name the connection.");

  const body = offline
    ? "Provider connections can't be read offline."
    : query.isError
      ? "Provider connections couldn't be loaded."
      : !query.data
        ? "Loading provider connections…"
        : connections.length === 0
          ? "No ESP evidence connections yet — bounce/complaint webhooks from other providers aren't being ingested."
          : `${connections.length} connection${connections.length === 1 ? "" : "s"} feeding deliverability evidence.`;

  const onCreate = () => {
    haptics.tap();
    create.mutate(
      {
        provider,
        displayName: displayName.trim(),
        ...(token.trim() ? { webhookToken: token } : {}),
        ...(credentialRef.trim() ? { credentialRef } : {}),
      },
      {
        onSuccess: () => {
          setAdding(false);
          setDisplayName("");
          setToken("");
          setCredentialRef("");
          toast({ kind: "success", message: "Provider connection saved." });
        },
        onError: (err) => {
          haptics.error();
          toast({
            kind: "error",
            message: errorPresentation(err).message || "Couldn't save the connection.",
          });
        },
      },
    );
  };

  const onDelete = async (id: string, name: string) => {
    haptics.tap();
    const ok = await confirm({
      title: `Remove ${name}?`,
      message:
        "Its webhook token stops being accepted and suppression mirroring stops. Evidence already ingested is kept.",
      confirmLabel: "Remove connection",
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(id, {
      onSuccess: () => toast({ kind: "success", message: "Connection removed." }),
      onError: (err) => {
        haptics.error();
        toast({
          kind: "error",
          message: errorPresentation(err).message || "Couldn't remove the connection.",
        });
      },
    });
  };

  return (
    <OpsCard>
      <OpsCardTitle>Evidence providers</OpsCardTitle>
      <OpsCardBody {...(query.isError ? { role: "alert" as const } : {})}>
        {body}
      </OpsCardBody>
      {connections.map((connection) => (
        <View
          key={connection.id}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 8,
            gap: 4,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.medium,
                flexShrink: 1,
              }}
              numberOfLines={1}
            >
              {connection.displayName || connection.provider}
            </Text>
            <Pill
              label={connection.active ? "active" : "paused"}
              tone={connection.active ? "success" : "neutral"}
            />
          </View>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
          >
            {`${connection.provider} · ${providerSecretSummary(connection.config)}`}
          </Text>
          {admin && !offline ? (
            <View style={{ flexDirection: "row", gap: 16 }}>
              <OpsAction
                label={connection.active ? "Pause" : "Activate"}
                onPress={() => {
                  haptics.tap();
                  set.mutate(
                    { connection, patch: { active: !connection.active } },
                    {
                      onError: (err) => {
                        haptics.error();
                        toast({
                          kind: "error",
                          message:
                            errorPresentation(err).message ||
                            "Couldn't update the connection.",
                        });
                      },
                    },
                  );
                }}
                disabled={set.isPending}
                accessibilityLabel={`${connection.active ? "Pause" : "Activate"} the ${connection.displayName || connection.provider} connection`}
              />
              <OpsAction
                label="Remove"
                onPress={() =>
                  void onDelete(
                    connection.id,
                    connection.displayName || connection.provider,
                  )
                }
                disabled={remove.isPending}
                destructive
                accessibilityLabel={`Remove the ${connection.displayName || connection.provider} connection`}
              />
            </View>
          ) : null}
        </View>
      ))}
      {admin && !offline && !adding ? (
        <OpsAction label="Connect a provider" onPress={() => setAdding(true)} />
      ) : null}
      {admin && !offline && adding ? (
        <View style={{ gap: 8 }}>
          <SegmentedControl
            options={DELIVERABILITY_PROVIDERS.map((key) => ({
              value: key,
              label: key,
            }))}
            value={provider}
            onChange={setProvider}
            accessibilityLabel="Provider"
            scrollable
          />
          <OpsTextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Connection name"
            accessibilityLabel="Connection name"
          />
          <OpsTextInput
            value={token}
            onChangeText={setToken}
            placeholder="Webhook token (optional, 32+ chars)"
            accessibilityLabel="Webhook token — stored hashed, never shown again"
            secureTextEntry
          />
          <OpsTextInput
            value={credentialRef}
            onChangeText={setCredentialRef}
            placeholder="Vault reference name (optional)"
            accessibilityLabel="Runtime-secret name for suppression-mirror credentials — a name, not a key"
          />
          {formError ? <OpsCardBody>{formError}</OpsCardBody> : null}
          <View style={{ flexDirection: "row", gap: 16 }}>
            <OpsAction
              label={create.isPending ? "Saving…" : "Save connection"}
              onPress={onCreate}
              disabled={create.isPending || formError !== null}
            />
            <OpsAction label="Cancel" onPress={() => setAdding(false)} />
          </View>
        </View>
      ) : null}
    </OpsCard>
  );
}
