// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldBan } from "lucide-react";
import { toast } from "sonner";
import { pluralizeCount } from "@/lib/pluralize";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/relative-time";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { qk } from "@/lib/query-keys";
import {
  addSmsSuppression,
  listSmsSuppressions,
  removeSmsSuppression,
  type SmsSuppressionRow,
} from "@/lib/sms-api";
import {
  isReversibleManualSmsSuppression,
  mergeSmsSuppressionPages,
} from "@/lib/sms-suppression-contract";
import { E164_PATTERN } from "./page-helpers";
import { CardLoadError } from "./sms-card-states";
import { smsKnownWriteRefusalMessage } from "./sms-write-outcome";

interface SmsSuppressionsCardProps {
  baseKey: readonly unknown[];
  enabled: boolean;
  tenantId: string;
  userId: string;
}

export function SmsSuppressionsCard({
  baseKey,
  enabled,
  tenantId,
  userId,
}: SmsSuppressionsCardProps) {
  const queryClient = useQueryClient();
  const key = useMemo(() => [...baseKey, "suppressions"] as const, [baseKey]);
  const lifecycle = useRef(0);
  const writes = useRef(new Set<AbortController>());
  const writeBusyRef = useRef(false);
  useEffect(() => {
    const ownedWrites = writes.current;
    lifecycle.current += 1;
    const generation = lifecycle.current;
    return () => {
      if (lifecycle.current === generation) lifecycle.current += 1;
      for (const controller of ownedWrites) controller.abort();
      ownedWrites.clear();
      writeBusyRef.current = false;
      void queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.removeQueries({ queryKey: key, exact: true });
    };
  }, [enabled, key, queryClient, tenantId, userId]);
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listSmsSuppressions({
        tenantId,
        limit: 100,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor,
    enabled,
  });
  const [phone, setPhone] = useState("");
  const [writeBusy, setWriteBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SmsSuppressionRow | null>(
    null,
  );
  const removeTriggerRef = useRef<HTMLButtonElement | null>(null);

  const pages = useMemo(
    () => (Array.isArray(query.data?.pages) ? query.data.pages : []),
    [query.data?.pages],
  );
  const merged = useMemo(() => {
    try {
      return {
        value: mergeSmsSuppressionPages(pages),
        error: null,
      };
    } catch (error) {
      return { value: null, error };
    }
  }, [pages]);
  const rows = Array.isArray(merged.value?.items) ? merged.value?.items : [];
  const verifiedRoster = Boolean(
    enabled &&
    query.isSuccess &&
    !query.isError &&
    !query.isFetching &&
    !merged.error &&
    merged.value &&
    pages.length > 0 &&
    pages.every((page) => page.tenantId === tenantId),
  );

  const refetch = () =>
    queryClient.resetQueries({ queryKey: key, exact: true });

  const acquireWrite = () => {
    if (!verifiedRoster || writeBusyRef.current) return false;
    writeBusyRef.current = true;
    setWriteBusy(true);
    return true;
  };

  const releaseWrite = () => {
    writeBusyRef.current = false;
    setWriteBusy(false);
  };

  const assertCurrent = (generation: number) => {
    if (!enabled || lifecycle.current !== generation) {
      throw new DOMException("SMS suppression operation retired", "AbortError");
    }
  };

  const reauthorize = async (generation: number) => {
    assertCurrent(generation);
    const current = await whoami();
    assertCurrent(generation);
    queryClient.setQueryData(qk.authMe(), current);
    const role = effectiveAuthRole(current);
    if (
      current.tenant_id !== tenantId ||
      current.user_id !== userId ||
      current.viewer_mode === true ||
      (role !== "owner" && role !== "admin")
    ) {
      throw new Error("Your workspace identity or effective role changed.");
    }
  };

  const withWrite = async <T,>(
    generation: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    assertCurrent(generation);
    const controller = new AbortController();
    writes.current.add(controller);
    try {
      const result = await run(controller.signal);
      assertCurrent(generation);
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

  const add = async () => {
    if (!verifiedRoster) {
      toast.error("Refresh the current suppression roster before changing it", {
        description:
          "Stale or still-loading rows are orientation only; no add request was sent.",
      });
      return;
    }
    if (!/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(phone)) {
      toast.error("Enter a valid phone in E.164 format, e.g. +14155551212");
      return;
    }
    if (!acquireWrite()) return;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    try {
      await reauthorize(generation);
      requestStarted = true;
      await withWrite(generation, (signal) =>
        addSmsSuppression({ phone, reason: "manual" }, signal),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        toast.error("Manual hold was added before your identity changed", {
          description:
            "The server receipt confirmed the hold, but this workspace view was retired. Reload the current workspace before relying on displayed state.",
        });
        return;
      }
      toast.success("Manual workspace hold added");
      setPhone("");
      await refetch();
    } catch (error: unknown) {
      if (lifecycle.current !== generation) return;
      const knownRefusal = requestStarted
        ? smsKnownWriteRefusalMessage(error)
        : null;
      toast.error("Could not add suppression", {
        description: knownRefusal
          ? knownRefusal
          : requestStarted
            ? "The request outcome is unknown because no valid receipt was available. The roster is being reloaded before any result is shown."
            : "Reauthorization failed before the write request; no add request was sent.",
      });
      if (requestStarted && !receiptConfirmed) await refetch();
    } finally {
      if (lifecycle.current === generation) releaseWrite();
    }
  };

  const commitRemove = async (
    target: SmsSuppressionRow,
    writeAlreadyAcquired = false,
  ) => {
    if (!verifiedRoster) {
      if (writeAlreadyAcquired) releaseWrite();
      toast.error("Refresh the current suppression roster before changing it", {
        description:
          "Stale or still-loading rows are orientation only; no remove request was sent.",
      });
      return;
    }
    if (!writeAlreadyAcquired && !acquireWrite()) return;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    try {
      if (!isReversibleManualSmsSuppression(target)) {
        throw new Error("Only a reversible manual hold can be removed.");
      }
      await reauthorize(generation);
      requestStarted = true;
      await withWrite(generation, (signal) =>
        removeSmsSuppression(target.id, tenantId, signal),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        toast.error("Manual hold was removed before your identity changed", {
          description:
            "The server receipt confirmed removal, but this workspace view was retired. Reload the current workspace before relying on displayed state.",
        });
        return;
      }
      toast.success(
        "Manual hold removed; current consent and policy are still required",
      );
      await refetch();
    } catch (error: unknown) {
      if (lifecycle.current !== generation) return;
      const knownRefusal = requestStarted
        ? smsKnownWriteRefusalMessage(error)
        : null;
      toast.error("Could not remove suppression", {
        description: knownRefusal
          ? knownRefusal
          : requestStarted
            ? "The request outcome is unknown because no valid receipt was available. The roster is being reloaded before any result is shown."
            : "Reauthorization failed before the write request; no remove request was sent.",
      });
      if (requestStarted && !receiptConfirmed) await refetch();
    } finally {
      if (lifecycle.current === generation) releaseWrite();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Suppressions</CardTitle>
        <CardDescription>
          Manual workspace holds and locked STOP, carrier, complaint, or system
          suppressions. Only manual holds can be removed here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="suppress_phone">Phone</Label>
            <Input
              id="suppress_phone"
              type="tel"
              inputMode="tel"
              pattern={E164_PATTERN}
              placeholder="+14155551212"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              disabled={!verifiedRoster || writeBusy}
            />
          </div>
          <Button
            type="submit"
            className="self-end"
            disabled={!verifiedRoster || writeBusy}
          >
            Add manual hold
          </Button>
        </form>

        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"
            >
              <div className="min-w-0">
                <div className="font-medium tabular-nums">
                  <bdi dir="ltr">{row.phone_e164}</bdi>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="secondary">
                    {row.reason.replaceAll("_", " ")}
                  </Badge>
                  <span>via {row.source.replaceAll("_", " ")}</span>
                  <span>·</span>
                  <RelativeTime iso={row.created_at} />
                  <span>·</span>
                  <span>
                    {isReversibleManualSmsSuppression(row)
                      ? "manual hold; removable after reauthorization"
                      : `locked: ${(row.locked_reason ?? "carrier_or_system_authority").replaceAll("_", " ")}`}
                  </span>
                </div>
              </div>
              {enabled && isReversibleManualSmsSuppression(row) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!verifiedRoster || writeBusy}
                  onClick={(event) => {
                    if (!acquireWrite()) return;
                    removeTriggerRef.current = event.currentTarget;
                    setRemoveTarget(row);
                  }}
                >
                  Remove manual hold
                </Button>
              ) : (
                <Badge variant="secondary">Locked</Badge>
              )}
            </div>
          ))}
          {query.isError || merged.error ? (
            <CardLoadError
              message="Suppressions failed tenant, response-cutoff, pagination, timestamp, phone, or authority checks."
              onRetry={() => void refetch()}
            />
          ) : !query.isPending && merged.value && rows.length === 0 ? (
            <EmptyState
              icon={ShieldBan}
              title="No suppressions returned for this response cutoff"
              description="The tenant-bound response reported zero matching manual or authoritative suppressions; newer changes may still exist."
            />
          ) : null}
          {merged.value && rows.length > 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              {merged.value.hasMore
                ? `${rows.length.toLocaleString()} of ${pluralizeCount(merged.value.total, "row")} loaded for this response cutoff; more are available.`
                : `${rows.length.toLocaleString()} of ${pluralizeCount(merged.value.total, "row")} loaded for this response cutoff; no continuation cursor returned. Newer changes may still exist.`}
            </p>
          ) : null}
          {query.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={query.isFetchingNextPage}
              onClick={() => void loadNextQueryPage(query, query.isEnabled)}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more suppressions"}
            </Button>
          ) : null}
        </div>
      </CardContent>

      {removeTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setRemoveTarget(null);
              releaseWrite();
            }
          }}
          title="Remove this manual workspace hold?"
          description={`Removing the manual hold for ${removeTarget.phone_e164} does not restore consent or make texting lawful. STOP, carrier, complaint, and system authority cannot be removed here.`}
          confirmLabel="Remove manual hold"
          confirmationToken={removeTarget.phone_e164}
          fallbackFocusRef={removeTriggerRef}
          onConfirm={async () => {
            const target = removeTarget;
            await commitRemove(target, true);
          }}
        />
      ) : null}
    </Card>
  );
}
