// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ConfirmDialogProps {
  /** Omit when driving `open`/`onOpenChange` yourself (programmatic open). */
  trigger?: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonProps["variant"];
  onConfirm: () => void | Promise<void>;
  /** Controlled open state. When provided, the dialog is fully controlled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Explicit return target for dialogs opened by a control outside
   * `DialogTrigger` (for example, a controlled toolbar action).
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * When set, the confirm button stays disabled until the user types this exact
   * token — a second gate for high-blast-radius destructive actions (e.g. the
   * migration rollback that deletes a whole imported audience, MIGR-001).
   */
  confirmationToken?: string;
  /**
   * Keeps the confirm action unavailable, for a dialog that explains why the
   * action can't be taken yet (the description should say what to do first).
   */
  confirmDisabled?: boolean;
  /** Focus target when a successful action removes its own trigger. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

function isUsableReturnFocusTarget(
  target: HTMLElement | null | undefined,
): target is HTMLElement {
  if (!target?.isConnected) return false;
  if ((target as HTMLElement & { disabled?: boolean }).disabled === true) {
    return false;
  }
  if (
    target.matches(
      ":disabled, [aria-disabled='true'], [aria-hidden='true'], [hidden]",
    )
  ) {
    return false;
  }
  return !target.closest("[inert], [hidden]");
}

function getReturnFocusTarget(
  trigger: HTMLElement | null,
  fallback: HTMLElement | null | undefined,
): HTMLElement | null {
  if (isUsableReturnFocusTarget(trigger)) return trigger;
  return isUsableReturnFocusTarget(fallback) ? fallback : null;
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "destructive",
  onConfirm,
  open: openProp,
  onOpenChange,
  returnFocusRef: explicitReturnFocusRef,
  confirmationToken,
  confirmDisabled = false,
  fallbackFocusRef,
}: ConfirmDialogProps) {
  const [openState, setOpenState] = useState(false);
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const triggerReturnFocusRef = useRef<HTMLElement | null>(null);
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const closingDialogFocusRef = useRef<HTMLElement | null>(null);
  const tokenId = useId();
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openState;
  const openRef = useRef(open);
  openRef.current = open;
  const restoreReturnFocus = () => {
    if (openRef.current) return;
    const active = document.activeElement;
    const activeElement = active instanceof HTMLElement ? active : null;
    const activeIsUsableElsewhere =
      isUsableReturnFocusTarget(activeElement) &&
      activeElement !== document.body &&
      activeElement !== closingDialogFocusRef.current &&
      !dialogContentRef.current?.contains(activeElement) &&
      !activeElement.closest('[role="dialog"]');
    if (activeIsUsableElsewhere) return;

    const target = getReturnFocusTarget(
      explicitReturnFocusRef?.current ?? triggerReturnFocusRef.current,
      fallbackFocusRef?.current,
    );
    target?.focus();
    if (target && document.activeElement === target) {
      closingDialogFocusRef.current = null;
    }
  };
  const queueReturnFocus = () => {
    setTimeout(() => {
      let framesRemaining = 2;
      const attempt = () => {
        restoreReturnFocus();
        // A successful mutation can remove or disable its trigger in the same
        // React batch that closes this dialog. Re-evaluate through the portal
        // exit; the guard above never steals focus from a usable new target.
        if (framesRemaining > 0) {
          framesRemaining -= 1;
          requestAnimationFrame(attempt);
        }
      };
      attempt();
    }, 0);
  };
  const setOpen = (next: boolean) => {
    if (!next && pendingRef.current) return;
    if (!next) {
      const active = document.activeElement;
      closingDialogFocusRef.current =
        active instanceof HTMLElement &&
        dialogContentRef.current?.contains(active)
          ? active
          : null;
    }
    openRef.current = next;
    if (next) setError(null);
    if (!isControlled) setOpenState(next);
    onOpenChange?.(next);
    if (!next) queueReturnFocus();
  };

  // Reset the typed gate whenever the dialog closes so a re-open starts clean.
  useEffect(() => {
    if (!open) {
      setTyped("");
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const tokenSatisfied =
    !confirmationToken || typed.trim() === confirmationToken;

  async function handleConfirm() {
    if (confirmDisabled || !tokenSatisfied || pendingRef.current) return;
    pendingRef.current = true;
    setError(null);
    setPending(true);
    try {
      await onConfirm();
      pendingRef.current = false;
      setOpen(false);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "This action could not be completed. Review the details and try again.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? (
        <DialogTrigger
          asChild
          onClick={(event) => {
            triggerReturnFocusRef.current = event.currentTarget;
          }}
        >
          {trigger}
        </DialogTrigger>
      ) : null}
      <DialogContent
        ref={dialogContentRef}
        aria-busy={pending}
        closeDisabled={pending}
        className="[&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-h-0 sm:[&_input]:min-h-0 sm:[&_input]:text-sm"
        onEscapeKeyDown={(event) => {
          if (pendingRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pendingRef.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const target = getReturnFocusTarget(
            explicitReturnFocusRef?.current ?? triggerReturnFocusRef.current,
            fallbackFocusRef?.current,
          );
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {confirmationToken ? (
          <div className="space-y-2">
            <Label htmlFor={tokenId}>
              Type{" "}
              <span className="font-mono font-semibold text-foreground">
                {confirmationToken}
              </span>{" "}
              to confirm
            </Label>
            <Input
              id={tokenId}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={typed}
              disabled={pending}
              onChange={(e) => {
                setTyped(e.target.value);
                if (error) setError(null);
              }}
              aria-invalid={typed.length > 0 && !tokenSatisfied}
              placeholder={confirmationToken}
            />
          </div>
        ) : null}
        {error ? (
          <div
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={pending}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={confirmVariant}
            onClick={() => void handleConfirm()}
            disabled={pending || !tokenSatisfied || confirmDisabled}
            loading={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
