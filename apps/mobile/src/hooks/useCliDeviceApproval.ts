import { useEffect, useRef, useState } from "react";

import {
  approveDevice,
  denyDevice,
  inspectDevice,
  type DeviceApproveResult,
} from "@/api/deviceApprove";
import { announce } from "@/lib/a11y";
import { requireDeviceAuth } from "@/lib/biometric";
import { isValidDeviceCode, normalizeDeviceCode } from "@/lib/cliScopes";
import { haptics } from "@/lib/haptics";

function withoutConsentToken(result: DeviceApproveResult): DeviceApproveResult {
  const displayed = { ...result };
  delete displayed.consentToken;
  return displayed;
}

export function useCliDeviceApproval({
  baseUrl,
  scannedCode,
}: {
  baseUrl: string | null;
  scannedCode: string;
}) {
  const [typedCode, setTypedCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<DeviceApproveResult | null>(null);
  const [approved, setApproved] = useState<DeviceApproveResult | null>(null);
  const [denied, setDenied] = useState(false);
  const [reviewVersion, setReviewVersion] = useState(0);
  const consentTokenRef = useRef<string | null>(null);
  const reviewedRequestRef = useRef<{
    code: string;
    grantKind: "session" | "api_key";
  } | null>(null);
  const reinspectMessageRef = useRef<string | null>(null);

  const code = scannedCode || typedCode;
  const valid = isValidDeviceCode(code);
  const scannedInvalid = Boolean(scannedCode) && !valid;
  const requestReady = Boolean(
    preview?.ok &&
    preview.grantKind &&
    reviewedRequestRef.current?.code === code &&
    reviewedRequestRef.current?.grantKind === preview.grantKind &&
    (preview.grantKind !== "session" || consentTokenRef.current),
  );
  const roleCanGrant =
    preview?.grantKind === "session" ||
    (preview?.grantKind === "api_key" && (preview.scopes?.length ?? 0) > 0);
  const needsStepUp = Boolean(preview?.requiresMfa);

  useEffect(() => {
    consentTokenRef.current = null;
    reviewedRequestRef.current = null;
    if (!valid || !baseUrl) {
      setPreview(null);
      setInspecting(false);
      return;
    }
    let active = true;
    setPreview(null);
    setDenied(false);
    setError(reinspectMessageRef.current ?? "");
    setInspecting(true);
    void inspectDevice(baseUrl, code).then((result) => {
      if (!active) return;
      setInspecting(false);
      if (result.ok) {
        const { consentToken, ...displayedResult } = result;
        consentTokenRef.current =
          result.grantKind === "session" ? (consentToken ?? null) : null;
        if (result.grantKind) {
          reviewedRequestRef.current = {
            code,
            grantKind: result.grantKind,
          };
        }
        setPreview(displayedResult);
        setError(reinspectMessageRef.current ?? "");
        reinspectMessageRef.current = null;
        return;
      }
      consentTokenRef.current = null;
      reviewedRequestRef.current = null;
      reinspectMessageRef.current = null;
      setError(result.message ?? "Couldn't verify that device request.");
    });
    return () => {
      active = false;
      consentTokenRef.current = null;
      reviewedRequestRef.current = null;
    };
  }, [baseUrl, code, reviewVersion, valid]);

  async function approve(): Promise<void> {
    if (!valid || busy || !baseUrl || !requestReady) return;
    const reviewedCode = code;
    const reviewedKind = preview?.grantKind;
    setError("");
    const confirmed = await requireDeviceAuth(
      reviewedKind === "session"
        ? "Confirm to sign in the other device"
        : "Confirm to authorize this CLI device",
    );
    if (!confirmed) {
      haptics.warning();
      setError(
        "Device confirmation was cancelled. The grant was not approved.",
      );
      return;
    }
    if (
      !reviewMatches(reviewedRequestRef.current, reviewedCode, reviewedKind)
    ) {
      setError(
        "The request changed while you were confirming. Review it again.",
      );
      return;
    }
    setBusy(true);
    try {
      const consentToken =
        reviewedKind === "session"
          ? (consentTokenRef.current ?? undefined)
          : undefined;
      const result = await approveDevice(baseUrl, reviewedCode, consentToken);
      consentTokenRef.current = null;
      reviewedRequestRef.current = null;
      if (result.ok && result.grantKind === reviewedKind) {
        haptics.success();
        setApproved(withoutConsentToken(result));
        announce("Device approved.");
        return;
      }
      reInspectAfterDecision(
        result,
        reviewedKind,
        "Couldn't approve that device.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deny(): Promise<void> {
    if (!valid || busy || !baseUrl || !requestReady) return;
    const reviewedCode = code;
    const reviewedKind = preview?.grantKind;
    if (
      !reviewMatches(reviewedRequestRef.current, reviewedCode, reviewedKind)
    ) {
      setError("The request changed. Review it again before deciding.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const consentToken =
        reviewedKind === "session"
          ? (consentTokenRef.current ?? undefined)
          : undefined;
      const result = await denyDevice(baseUrl, reviewedCode, consentToken);
      consentTokenRef.current = null;
      reviewedRequestRef.current = null;
      if (result.ok && result.grantKind === reviewedKind) {
        haptics.warning();
        setDenied(true);
        announce("Device request denied.");
        return;
      }
      reInspectAfterDecision(
        result,
        reviewedKind,
        "Couldn't deny that device request.",
      );
    } finally {
      setBusy(false);
    }
  }

  function reInspectAfterDecision(
    result: DeviceApproveResult,
    reviewedKind: DeviceApproveResult["grantKind"],
    fallback: string,
  ): void {
    haptics.error();
    const message = result.ok
      ? "Moosewave returned a different request than the one you reviewed. Review it again before deciding."
      : (result.message ?? fallback);
    reinspectMessageRef.current = message;
    setPreview(null);
    setReviewVersion((current) => current + 1);
    announce(message);
  }

  function changeTypedCode(value: string): void {
    consentTokenRef.current = null;
    reviewedRequestRef.current = null;
    reinspectMessageRef.current = null;
    setTypedCode(normalizeDeviceCode(value));
    if (error) setError("");
  }

  return {
    approved,
    approve,
    busy,
    changeTypedCode,
    code,
    denied,
    deny,
    error,
    inspecting,
    needsStepUp,
    preview,
    requestReady,
    roleCanGrant,
    scannedInvalid,
    typedCode,
    valid,
  };
}

function reviewMatches(
  reviewed: { code: string; grantKind: "session" | "api_key" } | null,
  code: string,
  grantKind: DeviceApproveResult["grantKind"],
): boolean {
  return reviewed?.code === code && reviewed.grantKind === grantKind;
}
