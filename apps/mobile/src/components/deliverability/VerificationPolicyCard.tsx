/**
 * VerificationPolicyCard — the pre-send verification gate's mode, and the
 * paid-credit meter behind it.
 *
 * Two facts with two audiences, deliberately on one card:
 *  - CREDITS are a viewer read and render for everyone — "can we afford a
 *    verification job" is the question the jobs panel above raises.
 *  - THE POLICY is admin-scoped even for GET (which signups the workspace
 *    refuses is access-control-shaped), so the mode section MOUNTS only for
 *    admins; below admin the card is the credit meter alone, with no disabled
 *    controls pretending otherwise.
 *
 * The mode write is ONLINE-ONLY and echoes the full policy back (the server's
 * PUT is a full replace — sending one field would wipe the reject-status
 * lists tuned at a desk). A server `warning` renders verbatim: it is the
 * consequence sentence for "full mode with no provider".
 */
import { Text, View } from "react-native";

import {
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import {
  useSetVerificationMode,
  useVerificationCredits,
  useVerificationPolicy,
} from "@/hooks/useDeliverabilityVerificationPolicy";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isAdminRole } from "@/lib/campaignAccess";
import { verificationCreditsCaption } from "@/lib/deliverabilityOpsView";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

import type { VerificationMode } from "@/api/verificationPolicy";

const MODES: { value: string; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "local", label: "Local" },
  { value: "full", label: "Full" },
];

function isVerificationMode(value: string): value is VerificationMode {
  return value === "off" || value === "local" || value === "full";
}

export function VerificationPolicyCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const admin = isAdminRole(gate.effectiveRole);
  const offline = !gate.enabled;

  const credits = useVerificationCredits();
  // Admin-only mount: asking as a viewer buys a guaranteed 403.
  const policyQuery = useVerificationPolicy(admin);
  const setMode = useSetVerificationMode();

  const creditsLine = offline
    ? "Verification credits can't be read offline."
    : credits.isError
      ? "The credit balance couldn't be loaded."
      : !credits.data
        ? "Loading verification credits…"
        : verificationCreditsCaption(credits.data);

  const policy = policyQuery.data?.policy;

  const onChange = (target: "forms" | "import", raw: string) => {
    if (!policy || !isVerificationMode(raw)) return;
    haptics.tap();
    setMode.mutate(
      { current: policy, gate: target, mode: raw },
      {
        onSuccess: ({ warning }) => {
          toast(
            warning
              ? { kind: "info", message: warning }
              : { kind: "success", message: "Verification policy updated." },
          );
        },
        onError: (err) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              errorPresentation(err).message ||
              "Couldn't change the verification policy.",
          });
        },
      },
    );
  };

  const gateRow = (label: string, target: "forms" | "import", value: string) => (
    <View style={{ gap: 6 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.medium,
        }}
      >
        {label}
      </Text>
      <SegmentedControl
        options={MODES}
        value={value}
        onChange={(raw) => onChange(target, raw)}
        accessibilityLabel={`${label} verification mode`}
      />
    </View>
  );

  return (
    <OpsCard>
      <OpsCardTitle>Address verification</OpsCardTitle>
      <OpsCardBody {...(credits.isError && !offline ? { role: "alert" as const } : {})}>
        {creditsLine}
      </OpsCardBody>
      {admin ? (
        offline ? (
          <OpsCardBody>
            The verification gate can&apos;t be read or changed offline — it decides
            which addresses enter lists right now.
          </OpsCardBody>
        ) : policyQuery.isError ? (
          <OpsCardBody role="alert">
            The gate policy couldn&apos;t be loaded — its real mode is unknown.
          </OpsCardBody>
        ) : !policy ? (
          <OpsCardBody>Loading the gate policy…</OpsCardBody>
        ) : (
          <View style={{ gap: 10 }}>
            {gateRow("Form signups", "forms", policy.formsMode)}
            {gateRow("Imports", "import", policy.importMode)}
            <OpsCardBody>
              Off admits everything · Local runs the free syntax/domain filter ·
              Full also asks the paid provider.
            </OpsCardBody>
          </View>
        )
      ) : (
        <OpsCardBody>
          The gate&apos;s mode is workspace-admin territory; this card shows the
          spend it drives.
        </OpsCardBody>
      )}
    </OpsCard>
  );
}
