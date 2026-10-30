/**
 * VerificationProvidersCard — which vendor verifies addresses, and the switch.
 *
 * The phone could already read the verification MODE (off / local / full) and
 * the credit meter, but not the vendor row underneath them. So "full" mode with
 * a rejected ZeroBounce key looked exactly like "full" mode working: same
 * segmented control, same balance line, nothing naming the vendor or saying
 * whether one was enabled at all.
 *
 * ADMIN-ONLY MOUNT. GET /verification/providers is admin even for the read
 * because the row points at a billable credential, so a viewer never buys a
 * guaranteed 403 and sees no disabled controls pretending otherwise.
 *
 * SECRETS: nothing credential-shaped renders here. The card shows only what the
 * server reports about configuration STATE — vendor name, enabled, last
 * reported balance, and the server's own sanitised connection-failure sentence.
 * The credential handle needed by the full-replace PUT is re-read and echoed
 * inside api/verificationProviders.ts and never reaches this component.
 *
 * ADDING a vendor is deliberately absent: credential_ref names a secret that
 * must already exist in the workspace's server-side namespace, and a phone is
 * not where that gets provisioned. Enabling, disabling and removing an already
 * configured vendor are the changes that belong in a pocket.
 */
import { View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import {
  OpsAction,
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  useRemoveVerificationProvider,
  useSetVerificationProviderEnabled,
  useVerificationProviders,
} from "@/hooks/useVerificationProviders";
import { verificationProviderErrorCode } from "@/api/verificationProviders";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isAdminRole } from "@/lib/campaignAccess";
import { errorPresentation } from "@/lib/errorCopy";
import { haptics } from "@/lib/haptics";
import {
  verificationFailureMessage,
  verificationProviderProbeHint,
} from "@/lib/verificationErrors";
import {
  verificationProviderChangeConsequence,
  verificationProviderStatusLine,
  verificationProviderSummary,
  verificationVendorLabel,
  type VerificationProviderConfig,
} from "@/lib/verificationProviders";

export function VerificationProvidersCard() {
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const admin = isAdminRole(gate.effectiveRole);
  const offline = !gate.enabled;

  const query = useVerificationProviders(admin);
  const setEnabled = useSetVerificationProviderEnabled();
  const remove = useRemoveVerificationProvider();
  const busy = setEnabled.isPending || remove.isPending;

  if (!admin) return null;

  const onToggle = async (config: VerificationProviderConfig) => {
    haptics.tap();
    const next = !config.enabled;
    const ok = await confirm({
      title: next
        ? `Enable ${verificationVendorLabel(config.provider)}?`
        : `Disable ${verificationVendorLabel(config.provider)}?`,
      consequence: verificationProviderChangeConsequence(
        config.provider,
        next ? "enable" : "disable",
      ),
      confirmLabel: next ? "Enable vendor" : "Disable vendor",
      destructive: !next,
    });
    if (!ok) return;
    setEnabled.mutate(
      { provider: config.provider, enabled: next },
      {
        onSuccess: () =>
          toast({
            kind: "success",
            message: next
              ? `${verificationVendorLabel(config.provider)} is now verifying addresses.`
              : `${verificationVendorLabel(config.provider)} is off.`,
          }),
        onError: (err) => {
          haptics.error();
          // ConfigureProvider probes the credential before it touches the row
          // — on a DISABLE too — so a revoked key blocks the off switch. Say
          // that in the server's own words, plus the escape hatch (DELETE does
          // not probe), instead of a generic "please try again".
          const code = verificationProviderErrorCode(err);
          const hint = verificationProviderProbeHint(code);
          const message = verificationFailureMessage({
            code,
            serverMessage: err instanceof Error ? err.message : "",
            fallback:
              errorPresentation(err).message ||
              "Couldn't change the verification vendor.",
          });
          toast({
            kind: "error",
            message: hint ? `${message} ${hint}` : message,
          });
        },
      },
    );
  };

  const onRemove = async (config: VerificationProviderConfig) => {
    haptics.tap();
    const label = verificationVendorLabel(config.provider);
    const ok = await confirm({
      title: `Remove ${label}?`,
      consequence: verificationProviderChangeConsequence(
        config.provider,
        "remove",
      ),
      confirmLabel: "Remove vendor",
      confirmPhrase: label,
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(config.provider, {
      onSuccess: () =>
        toast({ kind: "success", message: `${label} removed.` }),
      onError: (err) => {
        haptics.error();
        toast({
          kind: "error",
          message: verificationFailureMessage({
            code: verificationProviderErrorCode(err),
            serverMessage: err instanceof Error ? err.message : "",
            fallback:
              errorPresentation(err).message ||
              "Couldn't remove the verification vendor.",
          }),
        });
      },
    });
  };

  const view = query.data;

  return (
    <OpsCard>
      <OpsCardTitle>Verification vendor</OpsCardTitle>
      {offline ? (
        <OpsCardBody>
          The verification vendor can&apos;t be read or changed offline — it
          decides whether mailboxes are probed and credits spent right now.
        </OpsCardBody>
      ) : query.isError ? (
        <OpsCardBody role="alert">
          The verification vendor couldn&apos;t be loaded, so which vendor
          verifies addresses — if any — is unknown.
        </OpsCardBody>
      ) : !view ? (
        <OpsCardBody>Loading the verification vendor…</OpsCardBody>
      ) : (
        <View style={{ gap: 10 }}>
          <OpsCardBody>{verificationProviderSummary(view)}</OpsCardBody>
          {view.providers.map((config) => (
            <View
              key={config.provider}
              style={{ gap: 4 }}
              accessibilityLabel={`${verificationVendorLabel(config.provider)} verification vendor`}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <OpsCardBody>
                  {verificationVendorLabel(config.provider)}
                </OpsCardBody>
                <Pill
                  label={config.enabled ? "enabled" : "off"}
                  tone={config.enabled ? "success" : "neutral"}
                />
              </View>
              <OpsCardBody>
                {verificationProviderStatusLine(config)}
              </OpsCardBody>
              {config.lastError ? (
                <OpsCardBody role="alert">{config.lastError}</OpsCardBody>
              ) : null}
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 16 }}
              >
                <OpsAction
                  label={config.enabled ? "Disable" : "Enable"}
                  accessibilityLabel={`${config.enabled ? "Disable" : "Enable"} ${verificationVendorLabel(config.provider)}`}
                  disabled={busy}
                  destructive={config.enabled}
                  onPress={() => void onToggle(config)}
                />
                <OpsAction
                  label="Remove"
                  accessibilityLabel={`Remove ${verificationVendorLabel(config.provider)}`}
                  disabled={busy}
                  destructive
                  onPress={() => void onRemove(config)}
                />
              </View>
            </View>
          ))}
          {view.providers.length === 0 ? (
            <OpsCardBody>
              {view.available.length > 0
                ? `${view.available.map(verificationVendorLabel).join(" and ")} can be connected, but that starts with a credential stored server-side — it is not something to set up from a phone.`
                : "No vendor is configured, and the server advertised none that can be."}
            </OpsCardBody>
          ) : null}
        </View>
      )}
    </OpsCard>
  );
}
