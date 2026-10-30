/**
 * VendorVerifyAction — force a live, paid vendor check on THIS address.
 *
 * The health card above it is derived evidence: consent, suppressions,
 * bounces, and whatever the last verification said, however old that is. It
 * cannot answer "is this mailbox good RIGHT NOW", which is the question
 * somebody has when a single important address is in doubt. That answer costs
 * one provider credit, so the whole design of this component is about the
 * money:
 *
 *  - THE ADDRESS IS FIXED. There is no input, so nothing can fire on typing.
 *  - NOTHING FIRES ON RENDER. The request exists only inside onPress.
 *  - THE PRESS IS CONFIRMED, and the confirmation says the vendor is called
 *    and a credit is charged.
 *  - THERE IS NO AUTOMATIC RETRY. A failed attempt keeps its idempotency key,
 *    so a deliberate second press REPLAYS on the server rather than buying a
 *    second check; an ambiguous outcome (the server's 409) removes the button
 *    entirely, because the charge may already have happened.
 *
 * Editor floor: POST /verification/verify is write:subscribers — "spending
 * money is a write, whatever the HTTP verb says".
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { OpsAction } from "@/components/deliverability/OpsCard";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  mintVendorVerifyKey,
  useVerifyAddressWithVendor,
} from "@/hooks/useVendorVerify";
import {
  vendorVerifyErrorCode,
  vendorVerifyOutcomeAmbiguous,
} from "@/api/vendorVerify";
import { errorPresentation } from "@/lib/errorCopy";
import { verificationFailureMessage } from "@/lib/verificationErrors";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  nextVendorVerifyAttempt,
  vendorVerifyConfirmation,
  vendorVerifyResultLine,
  vendorVerifySpendLine,
  type VendorVerifyAttempt,
  type VendorVerifyResult,
} from "@/lib/vendorVerify";

export function VendorVerifyAction({
  email,
  onVerified,
}: {
  email: string;
  onVerified?: () => void;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const verify = useVerifyAddressWithVendor();

  const [attempt, setAttempt] = useState<VendorVerifyAttempt | null>(null);
  const [result, setResult] = useState<VendorVerifyResult | null>(null);
  const [ambiguous, setAmbiguous] = useState("");

  const mayVerify = canAccessMinimumRole("editor", gate.effectiveRole);
  const offline = !gate.enabled;

  const caption = (value: string, alert = false) => (
    <Text
      {...(alert ? { accessibilityRole: "alert" as const } : {})}
      {...typeCap("caption")}
      style={{
        color: alert ? t.danger : t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {value}
    </Text>
  );

  if (!mayVerify) {
    return (
      <View style={{ marginTop: 10 }}>
        {caption(
          "A live vendor check spends a provider credit, so it needs an editor.",
        )}
      </View>
    );
  }

  const onPress = async () => {
    haptics.tap();
    const copy = vendorVerifyConfirmation(email);
    const ok = await confirm({
      title: copy.title,
      consequence: copy.consequence,
      confirmLabel: "Check with vendor",
    });
    if (!ok) return;
    // The key is minted HERE, after the confirmation, and reused when the last
    // attempt on this address never settled. That is what makes a second press
    // a replay instead of a second charge.
    const next = nextVendorVerifyAttempt(attempt, email, mintVendorVerifyKey);
    setAttempt(next);
    verify.mutate(
      { email: next.email, idempotencyKey: next.key },
      {
        onSuccess: (value) => {
          setAttempt({ ...next, settled: true });
          setResult(value);
          setAmbiguous("");
          toast({ kind: "success", message: "Address checked." });
          onVerified?.();
        },
        onError: (err) => {
          haptics.error();
          // The server's own sentence wins for the codes it authored. The
          // status table maps 409 to "Something went wrong loading this.
          // Please try again." — which, on a request that may already have
          // been charged, tells the operator to do the exact thing the server
          // refused to do. See lib/verificationErrors.
          const message = verificationFailureMessage({
            code: vendorVerifyErrorCode(err),
            serverMessage: err instanceof Error ? err.message : "",
            fallback:
              errorPresentation(err).message ||
              "Couldn't check that address with the vendor.",
          });
          if (vendorVerifyOutcomeAmbiguous(err)) {
            // Settled on purpose: the request may already have been charged,
            // so this address must not offer another press at all.
            setAttempt({ ...next, settled: true });
            setAmbiguous(message);
          }
          toast({ kind: "error", message });
        },
      },
    );
  };

  return (
    <View style={{ marginTop: 10, gap: 4 }}>
      {offline ? (
        caption(
          "A live vendor check can't run offline — it calls the paid vendor the moment it goes out, so it is never queued.",
        )
      ) : ambiguous ? (
        caption(ambiguous, true)
      ) : (
        <OpsAction
          label={verify.isPending ? "Checking…" : "Check with vendor"}
          accessibilityLabel="Check this address with the verification vendor now"
          disabled={verify.isPending}
          onPress={() => void onPress()}
        />
      )}
      {ambiguous
        ? caption(
            "This check was not retried, so a credit is not spent twice. The verification credits meter on Deliverability shows the balance.",
          )
        : null}
      {result ? (
        <>
          {caption(vendorVerifyResultLine(result))}
          {caption(vendorVerifySpendLine(result))}
        </>
      ) : null}
    </View>
  );
}
