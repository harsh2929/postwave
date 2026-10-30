// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import {
  getRecoveryCodesStatus,
  regenerateRecoveryCodes,
  totpChallenge,
  totpDisable,
  totpEnroll,
  totpVerify,
  type RecoveryCodesStatus,
  type TotpEnrollResponse,
} from "@/lib/auth-api";
import {
  abortAccountSecurityOperationForPrincipal,
  accountSecurityOperationIsCurrent,
  beginAccountSecurityOperation,
  finishAccountSecurityOperation,
  type AccountSecurityOperation,
} from "@/lib/account-security-operation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CopyTextButton } from "@/components/copy-text-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QrCode } from "@/components/qr-code";
import { downloadTextFile } from "@/lib/download";
import { verifyFreshExactPrincipal } from "@/lib/exact-principal";
import { qk } from "@/lib/query-keys";
import { useExactPrincipal } from "@/lib/use-exact-principal";
import { useOnline } from "@/lib/use-online";

type TotpStage =
  | { kind: "loading" }
  | { kind: "not-enrolled" }
  | { kind: "enrolling"; data: TotpEnrollResponse }
  | { kind: "verifying"; data: TotpEnrollResponse }
  | { kind: "active" };

export function TotpEnrollmentCard() {
  const queryClient = useQueryClient();
  const principal = useExactPrincipal();
  const online = useOnline();
  const identity = principal.identity;
  const principalKey = principal.principalKey;
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef = useRef<AccountSecurityOperation | null>(null);
  const recoveryKey = useMemo(
    () => ["account-security", principalKey, "totp-recovery-status"] as const,
    [principalKey],
  );
  const [stage, setStage] = useState<TotpStage>({ kind: "loading" });
  const [working, setWorking] = useState(false);
  const [code, setCode] = useState("");
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const recoveryQuery = useQuery({
    queryKey: recoveryKey,
    queryFn: ({ signal }) => getRecoveryCodesStatus({ signal }),
    enabled: Boolean(identity) && stage.kind === "active",
    retry: false,
    refetchOnWindowFocus: true,
  });
  const recoveryStatus: RecoveryCodesStatus | null = recoveryQuery.data ?? null;

  // Enrollment is an account property. `mfa_satisfied` is only the current
  // session's step-up state and must not drive this card. A failed identity
  // read stays an explicit error; it is never translated into "not enrolled".
  useEffect(() => {
    const scopedPrincipal = principalKey;
    if (operationRef.current?.principalKey === scopedPrincipal) {
      abortAccountSecurityOperationForPrincipal(scopedPrincipal);
      operationRef.current = null;
    }
    setWorking(false);
    setCode("");
    setVerifyError(null);
    setDisableOpen(false);
    setRegenOpen(false);
    setStage(
      identity
        ? identity.totp_enabled
          ? { kind: "active" }
          : { kind: "not-enrolled" }
        : { kind: "loading" },
    );
    const scopedKey = recoveryKey;
    return () => {
      if (operationRef.current?.principalKey === scopedPrincipal) {
        abortAccountSecurityOperationForPrincipal(scopedPrincipal);
        operationRef.current = null;
      }
      void queryClient.cancelQueries({ queryKey: scopedKey, exact: true });
      queryClient.removeQueries({ queryKey: scopedKey, exact: true });
    };
  }, [identity, principalKey, queryClient, recoveryKey]);

  function beginOperation(kind: string): AccountSecurityOperation {
    if (!identity) throw new Error("Verify your account before changing 2FA.");
    if (online === "offline") {
      throw new Error("Reconnect before changing two-factor authentication.");
    }
    const operation = beginAccountSecurityOperation(principalKey, kind);
    operationRef.current = operation;
    setWorking(true);
    return operation;
  }

  function operationIsCurrent(operation: AccountSecurityOperation): boolean {
    return (
      operationRef.current === operation &&
      accountSecurityOperationIsCurrent(operation, principalKeyRef.current)
    );
  }

  function finishOperation(operation: AccountSecurityOperation): void {
    if (operationRef.current === operation) {
      operationRef.current = null;
      setWorking(false);
    }
    finishAccountSecurityOperation(operation);
  }

  async function startEnroll() {
    let operation: AccountSecurityOperation;
    try {
      operation = beginOperation("totp-enroll");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start enrollment.",
      );
      return;
    }
    try {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: qk.authMe(), exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) return;
      const data = await totpEnroll({
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      if (!operationIsCurrent(operation)) return;
      setStage({ kind: "enrolling", data });
    } catch (err) {
      if (!operationIsCurrent(operation)) return;
      toast.error(
        err instanceof Error ? err.message : "Could not start enrollment.",
      );
    } finally {
      finishOperation(operation);
    }
  }

  async function verify() {
    if (stage.kind !== "verifying" && stage.kind !== "enrolling") return;
    const data = stage.data;
    setVerifyError(null);
    let operation: AccountSecurityOperation;
    try {
      operation = beginOperation("totp-verify");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not verify code.",
      );
      return;
    }
    try {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: qk.authMe(), exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) return;
      await totpVerify(code, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      const readback = await verifyFreshExactPrincipal(
        identity,
        operation.controller.signal,
      );
      if (!operationIsCurrent(operation)) return;
      if (readback.totp_enabled) {
        queryClient.setQueryData(qk.authMe(), readback);
      } else {
        void queryClient.invalidateQueries({ queryKey: qk.authMe() });
      }
      setStage({ kind: "active" });
      setCode("");
      toast.success("Two-factor authentication is active.");
      if (!readback.totp_enabled) {
        toast.warning(
          "Verification was accepted, but the refreshed account state did not confirm 2FA. Refresh before relying on this status.",
        );
      }
    } catch (err) {
      if (!operationIsCurrent(operation)) return;
      if (
        err instanceof ApiError &&
        (err.status === 400 || err.status === 401)
      ) {
        setVerifyError("That code didn't match. Try again.");
        setStage({ kind: "verifying", data });
        return;
      }
      toast.error(
        err instanceof Error ? err.message : "Could not verify code.",
      );
    } finally {
      finishOperation(operation);
    }
  }

  async function disable(codeToVerify: string) {
    const operation = beginOperation("totp-disable");
    try {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: qk.authMe(), exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      await totpChallenge(
        { code: codeToVerify },
        {
          signal: operation.controller.signal,
          idempotencyKey: operation.idempotencyKey,
        },
      );
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) return;
      await totpDisable({
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      const readback = await verifyFreshExactPrincipal(
        identity,
        operation.controller.signal,
      );
      if (!operationIsCurrent(operation)) return;
      if (!readback.totp_enabled) {
        queryClient.setQueryData(qk.authMe(), readback);
      } else {
        void queryClient.invalidateQueries({ queryKey: qk.authMe() });
      }
      queryClient.removeQueries({ queryKey: recoveryKey, exact: true });
      setStage({ kind: "not-enrolled" });
      toast.success("Two-factor authentication disabled.");
      if (readback.totp_enabled) {
        toast.warning(
          "Disable was accepted, but the refreshed account state still reports 2FA enabled. Refresh before relying on this status.",
        );
      }
    } catch (err) {
      if (!operationIsCurrent(operation)) return;
      throw err;
    } finally {
      finishOperation(operation);
    }
  }

  async function regenerate(codeToVerify: string): Promise<string[]> {
    const operation = beginOperation("totp-recovery-regenerate");
    try {
      if (!identity) throw new Error("Account identity is unavailable.");
      await queryClient.cancelQueries({ queryKey: recoveryKey, exact: true });
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (!operationIsCurrent(operation)) {
        throw new DOMException("Account identity changed.", "AbortError");
      }
      const receipt = await regenerateRecoveryCodes(codeToVerify, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      let readback: RecoveryCodesStatus | null = null;
      try {
        readback = await getRecoveryCodesStatus({
          signal: operation.controller.signal,
        });
      } catch {
        // Keep the reveal-once codes available; losing them because a
        // verification GET failed would strand the account.
      }
      if (!operationIsCurrent(operation)) {
        throw new DOMException("Account identity changed.", "AbortError");
      }
      if (readback) queryClient.setQueryData(recoveryKey, readback);
      else
        void queryClient.invalidateQueries({
          queryKey: recoveryKey,
          exact: true,
        });
      if (
        !readback ||
        !readback.enrolled ||
        readback.remaining !== receipt.remaining ||
        readback.total !== receipt.total
      ) {
        toast.warning(
          "New recovery codes were created and are shown below, but the live status readback could not confirm the bundle. Store them now, then refresh.",
        );
      }
      return receipt.recovery_codes;
    } finally {
      finishOperation(operation);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>
          Add a second factor to your sign-in. Moosewave supports any
          standards-compliant TOTP authenticator (1Password, Authy, Google
          Authenticator, etc.).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {principal.error ? (
          <SecurityStateError
            message="Account identity could not be verified. Two-factor status is unknown, not disabled."
            retrying={principal.retrying}
            onRetry={principal.retry}
          />
        ) : stage.kind === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : null}

        {stage.kind === "not-enrolled" && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium text-sm">Not enrolled</div>
              <p className="text-xs text-muted-foreground">
                Enable 2FA to require a code from your authenticator app at
                sign-in.
              </p>
            </div>
            <Button
              type="button"
              onClick={() => void startEnroll()}
              disabled={working || online === "offline" || !identity}
            >
              {working ? "Working…" : "Enable 2FA"}
            </Button>
          </div>
        )}

        {stage.kind === "active" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-sm">2FA is active</div>
                <p className="text-xs text-muted-foreground">
                  Your account requires a code from your authenticator app at
                  sign-in.
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  setCode("");
                  setVerifyError(null);
                  setDisableOpen(true);
                }}
                disabled={working || online === "offline" || !identity}
              >
                Disable 2FA
              </Button>
            </div>

            {/* SETC-035: recovery-code state + regeneration for an already-
                enrolled user (previously codes were only shown once at
                enrollment, with no way back). */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
              <div>
                <div className="text-sm font-medium">Recovery codes</div>
                <p className="text-xs text-muted-foreground">
                  {recoveryStatus
                    ? `${recoveryStatus.remaining} of ${recoveryStatus.total} unused.`
                    : "One-time codes to sign in if you lose your authenticator."}
                  {recoveryStatus?.low ? (
                    <span className="ml-1 font-medium text-amber-600 dark:text-amber-500">
                      Running low — regenerate soon.
                    </span>
                  ) : null}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRegenOpen(true)}
                disabled={working || online === "offline"}
              >
                Regenerate codes
              </Button>
            </div>
            {recoveryQuery.isError ? (
              <SecurityStateError
                message="Recovery-code status could not be verified. Existing codes may still be active."
                retrying={recoveryQuery.isFetching}
                onRetry={() => void recoveryQuery.refetch()}
              />
            ) : null}
          </div>
        )}

        {(stage.kind === "enrolling" || stage.kind === "verifying") && (
          <div className="space-y-4">
            <p className="text-sm">
              Scan the QR code with your authenticator app (or paste the setup
              URI), then enter the 6-digit code it shows to confirm.
            </p>
            <div className="flex flex-col items-center gap-3 rounded-md border bg-background p-4 sm:flex-row sm:items-start">
              <QrCode value={stage.data.otpauth_uri} size={168} />
              <div className="w-full space-y-1.5">
                <Label>Setup URI</Label>
                <code className="block break-all rounded-md border bg-muted/50 p-2 text-xs">
                  {stage.data.otpauth_uri}
                </code>
                <div className="flex items-center gap-2">
                  <CopyTextButton
                    value={stage.data.otpauth_uri}
                    label="Copy setup URI"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Can&apos;t scan? Most authenticator apps let you paste the
                  otpauth:// URI directly — fully supported and offline.
                </p>
              </div>
            </div>

            <RecoveryCodes codes={stage.data.recovery_codes} />

            <div className="space-y-1.5">
              <Label htmlFor="totp-code">6-digit code</Label>
              <Input
                id="totp-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                disabled={working}
                className="text-center tracking-[0.4em]"
              />
              {verifyError && (
                <p className="text-xs text-destructive" role="alert">
                  {verifyError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCode("");
                  setVerifyError(null);
                  setStage({ kind: "not-enrolled" });
                }}
                disabled={working}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void verify()}
                disabled={working || code.length !== 6}
              >
                {working ? "Verifying…" : "Verify and activate"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {online === "offline" ? (
        <p role="note" className="px-6 pb-6 text-sm text-muted-foreground">
          Reconnect before changing 2FA or recovery codes. Security mutations
          are never queued for later replay.
        </p>
      ) : null}

      {/* Disabling 2FA requires a fresh TOTP code (step-up), not just a
          confirm click (SETC-020). The backend also enforces this — it 403s a
          disable unless the session has completed a TOTP challenge. */}
      <DisableTwoFactorDialog
        open={disableOpen}
        onOpenChange={(open) => {
          if (!working) setDisableOpen(open);
        }}
        onConfirmed={async (freshCode) => {
          await disable(freshCode);
          setDisableOpen(false);
        }}
      />

      {/* Regenerating requires a fresh TOTP step-up (the backend 403s an
          unsatisfied session), and replaces the whole bundle — the previous
          codes stop working immediately. */}
      <RegenerateRecoveryCodesDialog
        open={regenOpen}
        onOpenChange={setRegenOpen}
        onRegenerate={regenerate}
      />
    </Card>
  );
}

function SecurityStateError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        loading={retrying}
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

function DisableTwoFactorDialog({
  open,
  onOpenChange,
  onConfirmed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) {
      setCode("");
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (code.length !== 6) {
      setError("Enter the current 6-digit code.");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      // The parent keeps the fresh-principal check, step-up, disable, and
      // readback under one cross-card account-security operation lock.
      await onConfirmed(code);
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 400 || err.status === 401)
      ) {
        setError("That code didn't match. Try again.");
        return;
      }
      setError(err instanceof Error ? err.message : "Could not verify code.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable two-factor authentication?</DialogTitle>
          <DialogDescription>
            This removes the second factor from your account. Enter a current
            code from your authenticator to confirm it&apos;s really you. We
            strongly recommend keeping 2FA enabled.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="disable-totp-code">Current 6-digit code</Label>
          <Input
            id="disable-totp-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) =>
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            disabled={working}
            className="text-center tracking-[0.4em]"
          />
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={working}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void submit()}
            disabled={working || code.length !== 6}
          >
            {working ? "Disabling…" : "Disable 2FA"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// SETC-035: step-up (a fresh TOTP code) then replace the whole recovery-code
// bundle, shown exactly once. Mirrors the disable-2FA step-up gate.
function RegenerateRecoveryCodesDialog({
  open,
  onOpenChange,
  onRegenerate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRegenerate: (code: string) => Promise<string[]>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open) {
      setCode("");
      setError(null);
      setNewCodes(null);
    }
  }, [open]);

  async function submit() {
    if (code.length !== 6) {
      setError("Enter the current 6-digit code.");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      // The code is verified server-side by regenerate itself (a genuine fresh
      // possession proof) — no separate step-up call whose short-circuit would
      // make this prompt theater.
      setNewCodes(await onRegenerate(code));
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 400 || err.status === 401)
      ) {
        setError("That code didn't match. Try again.");
        return;
      }
      setError(
        err instanceof Error ? err.message : "Could not regenerate codes.",
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!working) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regenerate recovery codes</DialogTitle>
          <DialogDescription>
            {newCodes
              ? "Save these somewhere safe. Each code works once, and your previous codes no longer work."
              : "Enter a current code from your authenticator to confirm it's you. This replaces all your recovery codes — the old ones stop working immediately."}
          </DialogDescription>
        </DialogHeader>
        {newCodes ? (
          <>
            <ul className="grid grid-cols-2 gap-2 font-mono text-xs">
              {newCodes.map((c) => (
                <li
                  key={c}
                  className="rounded-md border bg-background px-2 py-1.5"
                >
                  {c}
                </li>
              ))}
            </ul>
            <DialogFooter className="gap-2">
              <CopyTextButton value={newCodes.join("\n")} label="Copy all" />
              <Button
                type="button"
                variant="outline"
                onClick={() => downloadRecoveryCodes(newCodes)}
              >
                Download .txt
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="regen-totp-code">Current 6-digit code</Label>
              <Input
                id="regen-totp-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                disabled={working}
                className="text-center tracking-[0.4em]"
              />
              {error && (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={working}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void submit()}
                disabled={working || code.length !== 6}
              >
                {working ? "Regenerating…" : "Regenerate codes"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function downloadRecoveryCodes(codes: string[]) {
  const text = [
    "Moosewave recovery codes",
    "Keep these somewhere safe. Each code can be used once.",
    "",
    ...codes,
  ].join("\n");
  // Through the shared helper: the hand-rolled version here revoked the object
  // URL synchronously right after .click() and never attached the anchor to the
  // document, so the download could be dropped — and these are the codes that
  // get the operator back into a 2FA-locked account.
  downloadTextFile("postwave-recovery-codes.txt", text);
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const [open, setOpen] = useState(true);
  const download = () => downloadRecoveryCodes(codes);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Recovery codes</span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(true)}
            >
              View
            </Button>
            <CopyTextButton value={codes.join("\n")} label="Copy all" />
            <Button type="button" size="sm" onClick={download}>
              Download .txt
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Save these somewhere safe — each code can be used once if you lose
          access to your authenticator.
        </p>
      </div>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your recovery codes</DialogTitle>
          <DialogDescription>
            Save these somewhere you can find them. Each code works once.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid grid-cols-2 gap-2 font-mono text-xs">
          {codes.map((c) => (
            <li key={c} className="rounded-md border bg-background px-2 py-1.5">
              {c}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" onClick={download}>
            Download .txt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
