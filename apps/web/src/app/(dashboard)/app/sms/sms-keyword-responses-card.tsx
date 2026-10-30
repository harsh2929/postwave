// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, Pencil } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createSmsKeywordResponse,
  deleteSmsKeywordResponse,
  listSmsKeywordResponses,
  updateSmsKeywordResponse,
  type SmsKeywordResponse,
} from "@/lib/sms-api";
import { canonicalSmsKeyword } from "@/lib/sms-keyword-contract";
import { CardLoadError } from "./sms-card-states";
import { smsKnownWriteRefusalMessage } from "./sms-write-outcome";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk } from "@/lib/query-keys";

const OPT_OUT_RESPONSE_BODY =
  "You are unsubscribed from SMS marketing messages from this sender.";

const REPLY_ONLY_HELD_COPY =
  "Reply-only rows are display-only while automatic confirmation dispatch is release-held.";

export function canToggleSmsKeywordResponse(
  row: Pick<SmsKeywordResponse, "action">,
): boolean {
  return row.action === "opt_out";
}

/**
 * Local pre-check shared by create and rename. The server stays the authority
 * (422 `reserved_keyword`), but a carrier compliance word is refused here so
 * the operator is told why instead of seeing an "outcome unknown" error for a
 * request the transport never sent.
 */
export function smsKeywordInputError(value: string): string | null {
  if (!/^[A-Za-z0-9_.:-]+$/u.test(value)) {
    return "Enter an ASCII keyword using letters, numbers, _, ., :, or -";
  }
  if (value.length > 80) {
    return "Keep the keyword to 80 characters or fewer.";
  }
  if (!canonicalSmsKeyword(value)) {
    return "STOP, HELP, START and the other carrier compliance keywords are built in and cannot be a custom rule.";
  }
  return null;
}

interface SmsKeywordResponsesCardProps {
  baseKey: readonly unknown[];
  enabled: boolean;
  tenantId: string;
  userId: string;
}

export function SmsKeywordResponsesCard({
  baseKey,
  enabled,
  tenantId,
  userId,
}: SmsKeywordResponsesCardProps) {
  const queryClient = useQueryClient();
  const key = useMemo(
    () => [...baseKey, "keyword-responses"] as const,
    [baseKey],
  );
  const lifecycle = useRef(0);
  const writes = useRef(new Set<AbortController>());
  useEffect(() => {
    const ownedWrites = writes.current;
    lifecycle.current += 1;
    const generation = lifecycle.current;
    return () => {
      if (lifecycle.current === generation) lifecycle.current += 1;
      for (const controller of ownedWrites) controller.abort();
      ownedWrites.clear();
      mutationBusyRef.current = false;
      void queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.removeQueries({ queryKey: key, exact: true });
    };
  }, [enabled, key, queryClient, tenantId, userId]);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listSmsKeywordResponses(tenantId, signal),
    enabled,
  });
  const [keyword, setKeyword] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const mutationBusyRef = useRef(false);
  const [removeTarget, setRemoveTarget] = useState<SmsKeywordResponse | null>(
    null,
  );
  const [disableTarget, setDisableTarget] = useState<SmsKeywordResponse | null>(
    null,
  );
  const removeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [editTarget, setEditTarget] = useState<SmsKeywordResponse | null>(
    null,
  );
  const [editKeyword, setEditKeyword] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (enabled) return;
    mutationBusyRef.current = false;
    setMutationBusy(false);
    setRemoveTarget(null);
    setDisableTarget(null);
    setEditTarget(null);
  }, [enabled]);

  const rows = Array.isArray(query.data?.items) ? query.data?.items : [];
  const verifiedCurrent = Boolean(
    enabled &&
    query.isSuccess &&
    !query.isError &&
    !query.isFetching &&
    query.data?.tenantId === tenantId,
  );
  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: key, exact: true });

  const acquireMutation = () => {
    if (!verifiedCurrent || mutationBusyRef.current) return false;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    return true;
  };

  const releaseMutation = () => {
    mutationBusyRef.current = false;
    setMutationBusy(false);
  };

  const assertCurrentLifecycle = (generation: number) => {
    if (!enabled || lifecycle.current !== generation) {
      throw new DOMException("SMS keyword operation retired", "AbortError");
    }
  };

  const reauthorize = async (generation: number) => {
    assertCurrentLifecycle(generation);
    const current = await whoami();
    assertCurrentLifecycle(generation);
    queryClient.setQueryData(qk.authMe(), current);
    const role = effectiveAuthRole(current);
    if (
      current.tenant_id !== tenantId ||
      current.user_id !== userId ||
      current.viewer_mode === true ||
      (role !== "owner" && role !== "admin")
    ) {
      throw new Error("SMS keyword mutation reauthorization failed");
    }
  };

  const withWrite = async <T,>(
    generation: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    assertCurrentLifecycle(generation);
    const controller = new AbortController();
    writes.current.add(controller);
    try {
      const result = await run(controller.signal);
      assertCurrentLifecycle(generation);
      return result;
    } finally {
      writes.current.delete(controller);
    }
  };

  const retireForIdentityChange = async () => {
    await queryClient.cancelQueries({ queryKey: key, exact: true });
    queryClient.removeQueries({ queryKey: key, exact: true });
    await queryClient.invalidateQueries({ queryKey: qk.authMe() });
  };

  const create = async () => {
    if (!verifiedCurrent) {
      toast.error("Refresh the current keyword rules before changing them", {
        description:
          "Stale or still-loading rows are orientation only; no create request was sent.",
      });
      return;
    }
    const keywordError = smsKeywordInputError(keyword);
    if (keywordError) {
      toast.error(keywordError);
      return;
    }
    if (!acquireMutation()) return;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    try {
      await reauthorize(generation);
      requestStarted = true;
      await withWrite(generation, (signal) =>
        createSmsKeywordResponse(
          {
            keyword,
            response_body: OPT_OUT_RESPONSE_BODY,
            action: "opt_out",
            enabled: true,
          },
          tenantId,
          signal,
        ),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        toast.error(
          "Keyword opt-out rule was created before your identity changed",
          {
            description:
              "The server receipt confirmed the stored rule, but this workspace view was retired. Reload the original workspace before relying on displayed state.",
          },
        );
        return;
      }
      toast.success("Keyword opt-out rule saved", {
        description:
          "The stored match rule was confirmed enabled. Verified provider callback ingestion and automatic confirmation dispatch remain release-held.",
      });
      setKeyword("");
      await refetch();
    } catch (error: unknown) {
      if (lifecycle.current !== generation) return;
      const knownRefusal = requestStarted
        ? smsKnownWriteRefusalMessage(error)
        : null;
      toast.error("Could not save keyword opt-out rule", {
        description: knownRefusal
          ? knownRefusal
          : requestStarted
            ? "The request outcome is unknown because no valid receipt was available. Reload the original workspace before retrying."
            : "Reauthorization failed before the write request; no create request was sent.",
      });
      if (requestStarted && !receiptConfirmed) await refetch();
    } finally {
      if (lifecycle.current === generation) releaseMutation();
    }
  };

  const commitToggle = async (
    row: SmsKeywordResponse,
    mutationAlreadyAcquired = false,
  ) => {
    if (!verifiedCurrent) {
      if (mutationAlreadyAcquired) releaseMutation();
      toast.error("Refresh the current keyword rules before changing them", {
        description:
          "Stale or still-loading rows are orientation only; no update request was sent.",
      });
      return;
    }
    if (!canToggleSmsKeywordResponse(row)) {
      toast.error("Stored reply dispatch is held", {
        description:
          "Reply-only rows are display-only while automatic confirmation dispatch is release-held.",
      });
      if (mutationAlreadyAcquired) releaseMutation();
      return;
    }
    if (!mutationAlreadyAcquired && !acquireMutation()) return;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    try {
      await reauthorize(generation);
      requestStarted = true;
      await withWrite(generation, (signal) =>
        updateSmsKeywordResponse(
          row.id,
          { action: "opt_out", enabled: !row.enabled },
          row.updated_at,
          tenantId,
          signal,
        ),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        toast.error(
          "Keyword rule update was confirmed before your identity changed",
          {
            description:
              "The server receipt confirmed the stored change, but this workspace view was retired. Reload the original workspace before relying on displayed state.",
          },
        );
        return;
      }
      await refetch();
    } catch (error: unknown) {
      if (lifecycle.current !== generation) return;
      const knownRefusal = requestStarted
        ? smsKnownWriteRefusalMessage(error)
        : null;
      toast.error("Could not update keyword", {
        description: knownRefusal
          ? knownRefusal
          : requestStarted
            ? "The request outcome is unknown because no valid receipt was available. Reload the original workspace before retrying."
            : "Reauthorization failed before the write request; no update request was sent.",
      });
      if (requestStarted && !receiptConfirmed) await refetch();
    } finally {
      if (lifecycle.current === generation) releaseMutation();
    }
  };

  const commitDelete = async (
    target: SmsKeywordResponse,
    mutationAlreadyAcquired = false,
  ) => {
    if (!verifiedCurrent) {
      if (mutationAlreadyAcquired) releaseMutation();
      toast.error("Refresh the current keyword rules before changing them", {
        description:
          "Stale or still-loading rows are orientation only; no delete request was sent.",
      });
      return;
    }
    if (!mutationAlreadyAcquired && !acquireMutation()) return;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    try {
      await reauthorize(generation);
      requestStarted = true;
      await withWrite(generation, (signal) =>
        deleteSmsKeywordResponse(
          target.id,
          target.updated_at,
          tenantId,
          signal,
        ),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        toast.error(
          "Keyword rule deletion was confirmed before your identity changed",
          {
            description:
              "The server receipt confirmed deletion, but this workspace view was retired. Reload the original workspace before relying on displayed state.",
          },
        );
        return;
      }
      toast.success("Keyword rule deleted");
      await refetch();
    } catch (error: unknown) {
      if (lifecycle.current !== generation) return;
      const knownRefusal = requestStarted
        ? smsKnownWriteRefusalMessage(error)
        : null;
      toast.error("Could not delete keyword", {
        description: knownRefusal
          ? knownRefusal
          : requestStarted
            ? "The request outcome is unknown because no valid receipt was available. Reload the original workspace before retrying."
            : "Reauthorization failed before the write request; no delete request was sent.",
      });
      if (requestStarted && !receiptConfirmed) await refetch();
    } finally {
      if (lifecycle.current === generation) releaseMutation();
    }
  };

  const openEdit = (row: SmsKeywordResponse) => {
    if (
      !verifiedCurrent ||
      mutationBusyRef.current ||
      !canToggleSmsKeywordResponse(row)
    ) {
      return;
    }
    setEditTarget(row);
    setEditKeyword(row.keyword);
    setEditError(null);
  };

  const closeEditor = () => {
    if (mutationBusyRef.current) return;
    setEditTarget(null);
    setEditError(null);
  };

  const commitEdit = async () => {
    const target = editTarget;
    if (!target) return;
    const next = editKeyword.trim();
    const inputError = smsKeywordInputError(next);
    if (inputError) {
      setEditError(inputError);
      return;
    }
    if (canonicalSmsKeyword(next) === target.keyword) {
      setEditError("That is already the stored keyword; nothing was sent.");
      return;
    }
    if (!canToggleSmsKeywordResponse(target)) {
      setEditError(REPLY_ONLY_HELD_COPY);
      return;
    }
    if (!verifiedCurrent) {
      setEditError(
        "Refresh the current keyword rules before changing them; no update request was sent.",
      );
      return;
    }
    if (!acquireMutation()) return;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    setEditError(null);
    try {
      await reauthorize(generation);
      requestStarted = true;
      const saved = await withWrite(generation, (signal) =>
        updateSmsKeywordResponse(
          target.id,
          {
            keyword: next,
            action: "opt_out",
            response_body: OPT_OUT_RESPONSE_BODY,
          },
          target.updated_at,
          tenantId,
          signal,
        ),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        setEditTarget(null);
        toast.error(
          "Keyword rule rename was confirmed before your identity changed",
          {
            description:
              "The server receipt confirmed the stored change, but this workspace view was retired. Reload the original workspace before relying on displayed state.",
          },
        );
        return;
      }
      setEditTarget(null);
      toast.success(`Opt-out keyword renamed to ${saved.keyword}`, {
        description:
          "The stored match rule was updated. Verified provider callback ingestion and automatic confirmation dispatch remain release-held.",
      });
      await refetch();
    } catch (error: unknown) {
      if (lifecycle.current !== generation) return;
      const knownRefusal = requestStarted
        ? smsKnownWriteRefusalMessage(error)
        : null;
      setEditError(
        knownRefusal ??
          (requestStarted
            ? "The rename outcome is unknown because no valid receipt was available. Reload the keyword rules before retrying."
            : "Reauthorization failed before the write request; no update request was sent."),
      );
      if (requestStarted && !receiptConfirmed) await refetch();
    } finally {
      if (lifecycle.current === generation) releaseMutation();
    }
  };

  const toggle = (row: SmsKeywordResponse) => {
    if (row.enabled) {
      if (!acquireMutation()) return;
      setDisableTarget(row);
      return;
    }
    void commitToggle(row);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Keyword state rules</CardTitle>
        <CardDescription>
          Custom opt-out rules may change inbound consent state. Custom and HELP
          automatic confirmations are independently release-held ({" "}
          <code>sms_auto_reply_dispatch_release_held</code>). START and UNSTOP
          restoration remains provider-authoritative.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="keyword_word">Custom opt-out keyword</Label>
            <Input
              id="keyword_word"
              placeholder="LEAVE"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              required
              disabled={!verifiedCurrent || mutationBusy}
            />
            <p className="text-xs text-muted-foreground">
              Defines a stored opt-out match. It is not proof that a provider
              callback was received or that consent state changed; callback
              ingestion and automatic confirmation dispatch remain release-held.
            </p>
          </div>
          <Button type="submit" disabled={!verifiedCurrent || mutationBusy}>
            Save opt-out keyword
          </Button>
        </form>

        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-medium">
                  {row.keyword}
                  <Badge
                    variant={
                      row.action === "opt_out" && row.enabled
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {row.action === "opt_out" && row.enabled
                      ? "Opt-out matching on"
                      : "Held / off"}
                  </Badge>
                  <Badge variant="outline">
                    {row.action === "opt_out"
                      ? "inbound state change"
                      : "stored reply; no outbound effect"}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Checkbox
                      checked={row.enabled}
                      disabled={
                        !verifiedCurrent ||
                        mutationBusy ||
                        !canToggleSmsKeywordResponse(row)
                      }
                      onChange={() => toggle(row)}
                      aria-label={`Toggle ${row.keyword}`}
                    />
                    Opt-out rule enabled
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={
                      !verifiedCurrent ||
                      mutationBusy ||
                      !canToggleSmsKeywordResponse(row)
                    }
                    title={
                      canToggleSmsKeywordResponse(row)
                        ? undefined
                        : REPLY_ONLY_HELD_COPY
                    }
                    aria-label={`Edit ${row.keyword}`}
                    onClick={() => openEdit(row)}
                  >
                    <Pencil aria-hidden />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={!verifiedCurrent || mutationBusy}
                    onClick={(event) => {
                      if (!acquireMutation()) return;
                      removeTriggerRef.current = event.currentTarget;
                      setRemoveTarget(row);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              <div className="mt-1 text-muted-foreground">
                <span className="sr-only">Stored response text: </span>
                <bdi
                  dir="auto"
                  className="[unicode-bidi:isolate] [overflow-wrap:anywhere]"
                >
                  {row.response_body || row.response_text}
                </bdi>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {row.action === "opt_out"
                  ? `This stored opt-out match rule is ${row.enabled ? "enabled" : "disabled"}. Verified provider callback ingestion and automatic confirmation dispatch remain release-held.`
                  : "This stored reply-only configuration has no outbound effect while sms_auto_reply_dispatch_release_held is active."}
              </p>
            </div>
          ))}
          {query.isError ? (
            <CardLoadError
              message={
                rows.length > 0
                  ? "The current keyword-policy read failed. Rows shown are from an earlier response and may be stale."
                  : "Keyword state rules could not be loaded."
              }
              onRetry={() => void refetch()}
            />
          ) : !query.isPending && rows.length === 0 ? (
            <EmptyState
              icon={MessagesSquare}
              title="No custom keyword state rules yet"
              description="Add an opt-out keyword. Automatic confirmations remain release-held, and only provider-verified START or UNSTOP events may restore consent."
            />
          ) : null}
        </div>
      </CardContent>

      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent closeDisabled={mutationBusy}>
          <DialogHeader>
            <DialogTitle>Edit opt-out keyword</DialogTitle>
            <DialogDescription>
              Renames the stored opt-out match
              {editTarget ? ` for ${editTarget.keyword}` : ""}. Its enabled
              state and confirmation text are unchanged. Provider callback
              ingestion and automatic confirmation dispatch remain
              release-held, so saving is not proof that any inbound message
              matched.
            </DialogDescription>
          </DialogHeader>
          {editTarget ? (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void commitEdit();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="keyword_edit_word">Opt-out keyword</Label>
                <Input
                  id="keyword_edit_word"
                  maxLength={80}
                  required
                  value={editKeyword}
                  disabled={mutationBusy}
                  onChange={(event) => {
                    setEditKeyword(event.target.value);
                    setEditError(null);
                  }}
                />
              </div>
              {editError ? (
                <Alert variant="destructive">
                  <AlertDescription>{editError}</AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutationBusy}
                  onClick={closeEditor}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={mutationBusy}>
                  Save keyword
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      {disableTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setDisableTarget(null);
              releaseMutation();
            }
          }}
          title="Disable this opt-out match rule?"
          description={`Disable the stored ${disableTarget.keyword} definition? Provider-authoritative STOP handling is unchanged. This makes no claim about a live callback or consent-state effect.`}
          confirmLabel="Disable stored rule"
          confirmVariant="destructive"
          onConfirm={async () => {
            const target = disableTarget;
            setDisableTarget(null);
            await commitToggle(target, true);
          }}
        />
      ) : null}

      {removeTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setRemoveTarget(null);
              releaseMutation();
            }
          }}
          title="Delete this keyword rule?"
          description={
            removeTarget.action === "opt_out"
              ? `Delete the stored opt-out definition for "${removeTarget.keyword}"? This makes no claim about a live callback, consent-state effect, or delivery. Built-in provider-authoritative STOP handling is unchanged.`
              : `Delete stored held configuration for "${removeTarget.keyword}"? No outbound auto-reply is currently dispatched.`
          }
          confirmLabel="Delete"
          fallbackFocusRef={removeTriggerRef}
          onConfirm={async () => {
            const target = removeTarget;
            setRemoveTarget(null);
            await commitDelete(target, true);
          }}
        />
      ) : null}
    </Card>
  );
}
