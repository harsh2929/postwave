// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellOff,
  Download,
  FileUp,
  LockKeyhole,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { isApiError } from "@/lib/api";
import { downloadTextFile } from "@/lib/download";
import { pluralizeCount } from "@/lib/pluralize";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  addPushSuppression,
  authorizePushSuppressionAdmin,
  buildPushSuppressionCsv,
  bulkImportPushSuppressions,
  bulkRemovePushSuppressions,
  listPushSuppressions,
  mergePushSuppressionPages,
  parsePushSuppressionImportCsv,
  pushSuppressionExportFilename,
  removePushSuppression,
  rowCanBeRemoved,
  validatePushHashPrefix,
  validateRawPushToken,
  type PushSuppressionAdminAuthority,
  type PushSuppressionImportItem,
  type PushSuppressionPlatform,
  type PushSuppressionReason,
} from "@/lib/push-suppressions-api";
import { qk, STALE } from "@/lib/query-keys";
import { useOnline } from "@/lib/use-online";
import type { PushSuppressionRegistryRow } from "@/lib/consent-evidence-api";
import {
  PushSuppressionDetailDialog,
  pushAuthorityLabel,
  pushPlatformLabel,
} from "./_components/push-suppression-detail-dialog";

interface PushSuppressionsManagerProps {
  me?: MeResponse;
  authPending: boolean;
  authError: boolean;
  authFetching: boolean;
  onRetryAuth: () => void;
}

type Review =
  | { kind: "add"; item: PushSuppressionImportItem }
  | {
      kind: "import";
      items: PushSuppressionImportItem[];
      counts: Record<PushSuppressionPlatform, number>;
    }
  | { kind: "remove"; rows: PushSuppressionRegistryRow[] };

const REGISTRY_PREFIX = ["consent-evidence", "push-registry"] as const;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function safeWriteFailure(error: unknown, requestStarted: boolean): string {
  if (!requestStarted) {
    return "Fresh tenant-bound admin authorization could not be verified. No write request was sent.";
  }
  if (isApiError(error)) {
    if (error.status === 409) {
      return "The reviewed row changed, was locked, or no longer exists. No success is being inferred.";
    }
    if (error.status === 401 || error.status === 403) {
      return "The server did not accept the current admin authority. No success is being inferred.";
    }
    if (error.kind === "offline") {
      return "The connection went offline before a verified receipt arrived. The write was not queued.";
    }
  }
  return "No valid tenant-bound write receipt was available. The registry is being reloaded before any outcome is shown.";
}

export function PushSuppressionsManager({
  me,
  authPending,
  authError,
  authFetching,
  onRetryAuth,
}: PushSuppressionsManagerProps) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const role = me ? effectiveAuthRole(me) : null;
  const tenantId = me?.tenant_id ?? "";
  const userId = me?.user_id ?? "";
  const enabled = useMemo(() => {
    if (!me) return false;
    try {
      authorizePushSuppressionAdmin(me, tenantId, userId);
      return true;
    } catch {
      return false;
    }
  }, [me, tenantId, userId]);
  const [platform, setPlatform] = useState<"all" | PushSuppressionPlatform>(
    "all",
  );
  const [reason, setReason] = useState<"all" | PushSuppressionReason>("all");
  const [hashDraft, setHashDraft] = useState("");
  const [hashPrefix, setHashPrefix] = useState("");
  const [hashError, setHashError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [addPlatform, setAddPlatform] =
    useState<PushSuppressionPlatform>("apns");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [detailFor, setDetailFor] = useState<PushSuppressionRegistryRow | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [writeBusy, setWriteBusy] = useState(false);
  const lifecycle = useRef(0);
  const writes = useRef(new Set<AbortController>());
  const writeBusyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const importTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewReturnFocusRef = useRef<HTMLElement>(null);
  const fallbackFocusRef = useRef<HTMLButtonElement>(null);
  const detailTriggerRef = useRef<HTMLElement | null>(null);

  const identityKey = `${tenantId}\u0000${userId}\u0000${role ?? ""}\u0000${me?.viewer_mode === true}`;
  const queryKey = useMemo(
    () =>
      [
        ...REGISTRY_PREFIX,
        tenantId || null,
        userId || null,
        role,
        me?.viewer_mode ?? null,
        platform,
        reason,
        hashPrefix || null,
      ] as const,
    [hashPrefix, me?.viewer_mode, platform, reason, role, tenantId, userId],
  );

  useEffect(() => {
    const ownedWrites = writes.current;
    lifecycle.current += 1;
    const generation = lifecycle.current;
    setReview(null);
    setDetailFor(null);
    setToken("");
    setTokenError(null);
    setFileError(null);
    setSelected(new Set());
    return () => {
      if (lifecycle.current === generation) lifecycle.current += 1;
      for (const controller of ownedWrites) controller.abort();
      ownedWrites.clear();
      writeBusyRef.current = false;
      void queryClient.cancelQueries({ queryKey: REGISTRY_PREFIX });
      queryClient.removeQueries({ queryKey: REGISTRY_PREFIX });
    };
  }, [identityKey, queryClient]);

  useEffect(() => {
    setSelected(new Set());
  }, [hashPrefix, platform, reason]);

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listPushSuppressions({
        tenantId,
        limit: 100,
        ...(platform !== "all" ? { platform } : {}),
        ...(reason !== "all" ? { reason } : {}),
        ...(hashPrefix ? { hashPrefix } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor,
    enabled: enabled && !authPending && !authError,
    staleTime: STALE.list,
    gcTime: 0,
    refetchOnWindowFocus: "always",
  });
  const pages = useMemo(
    () => (Array.isArray(query.data?.pages) ? query.data.pages : []),
    [query.data?.pages],
  );
  const merged = useMemo(() => {
    try {
      return pages.length > 0
        ? { value: mergePushSuppressionPages(pages), error: null }
        : { value: null, error: null };
    } catch (error) {
      return { value: null, error };
    }
  }, [pages]);
  const rows = useMemo(
    () => (Array.isArray(merged.value?.items) ? merged.value.items : []),
    [merged.value],
  );
  const verifiedRoster = Boolean(
    enabled &&
    query.isSuccess &&
    !query.isError &&
    !query.isFetching &&
    !query.isStale &&
    !merged.error &&
    merged.value &&
    pages.length > 0 &&
    pages.every((page) => page.tenantId === tenantId),
  );
  const removableRows = useMemo(() => rows.filter(rowCanBeRemoved), [rows]);
  const selectedRows = useMemo(
    () => removableRows.filter((row) => selected.has(row.id)),
    [removableRows, selected],
  );

  useEffect(() => {
    const current = new Set(removableRows.map((row) => row.id));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => current.has(id)));
      if (
        next.size === previous.size &&
        [...next].every((id) => previous.has(id))
      ) {
        return previous;
      }
      return next;
    });
  }, [removableRows]);

  const refresh = () => queryClient.resetQueries({ queryKey, exact: true });
  const reloadRegistry = () =>
    queryClient.resetQueries({ queryKey: REGISTRY_PREFIX });

  const assertCurrent = (generation: number) => {
    if (!enabled || lifecycle.current !== generation) {
      throw new DOMException(
        "Push suppression operation retired",
        "AbortError",
      );
    }
  };

  const reauthorize = async (
    generation: number,
  ): Promise<PushSuppressionAdminAuthority> => {
    assertCurrent(generation);
    const current = await whoami();
    assertCurrent(generation);
    queryClient.setQueryData(["whoami"], current);
    queryClient.setQueryData(qk.authMe(), current);
    return authorizePushSuppressionAdmin(current, tenantId, userId);
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
    await queryClient.cancelQueries({ queryKey: REGISTRY_PREFIX });
    queryClient.removeQueries({ queryKey: REGISTRY_PREFIX });
    await queryClient.invalidateQueries({ queryKey: qk.authMe() });
    await queryClient.invalidateQueries({ queryKey: ["whoami"] });
  };

  const acquireWrite = (): boolean => {
    if (!verifiedRoster || online !== "online" || writeBusyRef.current) {
      toast.error(
        "Refresh the verified registry while online before changing it",
        {
          description:
            "Loading, stale, errored, or offline rows are orientation only; no write request was sent.",
        },
      );
      return false;
    }
    writeBusyRef.current = true;
    setWriteBusy(true);
    return true;
  };

  const releaseWrite = () => {
    writeBusyRef.current = false;
    setWriteBusy(false);
  };

  const runReviewedWrite = async (
    successMessage: string,
    run: (
      authority: PushSuppressionAdminAuthority,
      signal: AbortSignal,
    ) => Promise<{
      stillSuppressed?: number | boolean;
      successDetail?: string;
    }>,
  ) => {
    if (!acquireWrite()) return;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    try {
      const authority = await reauthorize(generation);
      assertCurrent(generation);
      if (online !== "online") {
        throw new Error("This write requires a current online connection.");
      }
      requestStarted = true;
      const receipt = await withWrite(generation, (signal) =>
        run(authority, signal),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        toast.error(`${successMessage} before your identity changed`, {
          description:
            "The server receipt was verified, but the previous workspace view was retired.",
        });
        return;
      }
      const independentlyHeld =
        typeof receipt.stillSuppressed === "boolean"
          ? receipt.stillSuppressed
          : Number(receipt.stillSuppressed ?? 0) > 0;
      toast.success(successMessage, {
        ...(independentlyHeld || receipt.successDetail
          ? {
              description: [
                receipt.successDetail,
                independentlyHeld
                  ? "At least one token remains suppressed by an independent authority."
                  : null,
              ]
                .filter(Boolean)
                .join(" "),
            }
          : {}),
      });
      try {
        await reloadRegistry();
      } catch {
        toast.error(
          "The change was confirmed, but the registry did not reload",
          {
            description:
              "Refresh before relying on displayed rows or making another change.",
          },
        );
      }
    } catch (error: unknown) {
      if (lifecycle.current !== generation || isAbort(error)) return;
      toast.error("Could not complete the registry change", {
        // Never surface an arbitrary server sentence here: validation errors
        // for add/import travel next to raw tokens and an upstream echo must
        // not turn a private token into toast/telemetry-visible DOM text.
        description: safeWriteFailure(error, requestStarted),
      });
      if (requestStarted && !receiptConfirmed) await reloadRegistry();
    } finally {
      if (lifecycle.current === generation) releaseWrite();
    }
  };

  const stageAdd = () => {
    const validation = validateRawPushToken(token, addPlatform);
    setTokenError(validation);
    if (validation || !verifiedRoster) return;
    reviewReturnFocusRef.current = addTriggerRef.current;
    setReview({
      kind: "add",
      item: { deviceToken: token, platform: addPlatform },
    });
    setToken("");
  };

  const stageCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!verifiedRoster) {
      setFileError("Refresh the verified registry before reviewing an import.");
      return;
    }
    if (file.size === 0 || file.size > 512 * 1024) {
      setFileError("Choose a non-empty CSV no larger than 512 KB.");
      return;
    }
    const generation = lifecycle.current;
    try {
      const result = parsePushSuppressionImportCsv(await file.text());
      assertCurrent(generation);
      if (!result.ok) {
        setFileError(result.message);
        return;
      }
      setReview({
        kind: "import",
        items: result.items,
        counts: result.platformCounts,
      });
      reviewReturnFocusRef.current = importTriggerRef.current;
    } catch (error) {
      if (isAbort(error)) return;
      setFileError("The CSV could not be read safely.");
    }
  };

  // Client-side CSV of the loaded, verified rows. Only the privacy-safe
  // fingerprint exists on the client, so no raw device token can leave here.
  // Refuses on an unverified snapshot: an export of stale or partial rows
  // would read as a record of the registry it is not.
  const exportVerifiedRows = () => {
    if (!verifiedRoster || rows.length === 0) {
      toast.error("Refresh the verified registry before exporting it", {
        description:
          "Loading, stale, or errored rows are orientation only; no file was written.",
      });
      return;
    }
    try {
      downloadTextFile(
        pushSuppressionExportFilename(),
        buildPushSuppressionCsv(rows),
        "text/csv;charset=utf-8",
      );
      toast.success(
        `Exported ${rows.length.toLocaleString()} verified row${rows.length === 1 ? "" : "s"} with fingerprints only`,
        {
          description:
            "Raw device tokens are not held on the client and are not in the file.",
        },
      );
    } catch {
      toast.error("The verified rows could not be exported");
    }
  };

  const stageBulkRemove = () => {
    if (
      !verifiedRoster ||
      selectedRows.length < 1 ||
      selectedRows.length > 100
    ) {
      toast.error("Select 1–100 removable rows from a verified registry");
      return;
    }
    reviewReturnFocusRef.current = fallbackFocusRef.current;
    setReview({
      kind: "remove",
      rows: selectedRows.map((row) => ({ ...row })),
    });
  };

  const commitReview = async (target: Review) => {
    try {
      if (target.kind === "add") {
        await runReviewedWrite(
          "Manual push hold confirmed",
          async (authority, signal) => {
            await addPushSuppression(authority, target.item, { signal });
            return {};
          },
        );
      } else if (target.kind === "import") {
        await runReviewedWrite(
          "Manual push hold import confirmed",
          async (authority, signal) => {
            const receipt = await bulkImportPushSuppressions(
              authority,
              target.items,
              { signal },
            );
            return {
              successDetail: `${receipt.created.toLocaleString()} created; ${receipt.existing.toLocaleString()} already existed.`,
            };
          },
        );
      } else {
        const current = new Map(rows.map((row) => [row.id, row]));
        if (
          !verifiedRoster ||
          target.rows.some((row) => {
            const latest = current.get(row.id);
            return (
              !latest ||
              latest.version !== row.version ||
              latest.fingerprint !== row.fingerprint ||
              !rowCanBeRemoved(latest)
            );
          })
        ) {
          toast.error("The reviewed rows changed; refresh and review again");
          return;
        }
        if (target.rows.length === 1) {
          const row = target.rows[0]!;
          await runReviewedWrite(
            "Manual push hold removed",
            async (authority, signal) => {
              return removePushSuppression(
                authority,
                { id: row.id, expectedVersion: row.version },
                { signal },
              );
            },
          );
        } else {
          await runReviewedWrite(
            `${target.rows.length.toLocaleString()} manual push holds removed`,
            async (authority, signal) =>
              bulkRemovePushSuppressions(
                authority,
                target.rows.map((row) => ({
                  id: row.id,
                  expectedVersion: row.version,
                })),
                { signal },
              ),
          );
        }
        setSelected(new Set());
      }
    } finally {
      // Import and add reviews contain raw tokens. Retire them on every outcome.
      setReview(null);
    }
  };

  const confirmation = review
    ? review.kind === "add"
      ? {
          title: "Add this manual customer push hold?",
          description: `The exact ${pushPlatformLabel(review.item.platform)} token will be sent once over the private tenant-bound API. It will not be displayed or cached. This does not enable push delivery.`,
          label: "Add manual hold",
          token: "ADD MANUAL",
        }
      : review.kind === "import"
        ? {
            title: `Import ${review.items.length.toLocaleString()} manual push holds?`,
            description: `${review.counts.apns} APNs, ${review.counts.fcm} FCM, and ${review.counts.web} Web push tokens passed local review. Exact tokens will not be displayed or cached.`,
            label: "Import reviewed holds",
            token: `IMPORT ${review.items.length}`,
          }
        : {
            title: `Remove ${review.rows.length.toLocaleString()} manual push hold${review.rows.length === 1 ? "" : "s"}?`,
            description:
              "Removal uses each reviewed row version. It does not restore consent, and provider, complaint, user opt-out, and legacy authority stays locked.",
            label:
              review.rows.length === 1
                ? "Remove manual hold"
                : "Remove reviewed holds",
            token:
              review.rows.length === 1
                ? review.rows[0]!.fingerprint
                : `REMOVE ${review.rows.length}`,
          }
    : null;

  return (
    <GovernanceSection
      icon={BellOff}
      title="Customer push registry"
      description="Tenant-bound APNs, FCM, and Web push suppression authority; separate from operator notification devices."
    >
      <div className="space-y-5">
        <Alert variant="warning">
          <LockKeyhole aria-hidden="true" />
          <AlertTitle>
            Registry management only — delivery remains held
          </AlertTitle>
          <AlertDescription>
            Customer push runtime, recipient materialization, APNs/FCM provider
            delivery, and automatic provider feedback are release-held. These
            controls only manage suppression authority; they do not make a token
            deliverable or establish consent.
          </AlertDescription>
        </Alert>

        {authPending ? (
          <GovernanceLoading label="Checking registry access…" />
        ) : authError || !me ? (
          <GovernanceError
            message="Could not verify registry access. No registry request was made and no zero total is inferred."
            retrying={authFetching}
            onRetry={onRetryAuth}
          />
        ) : !enabled ? (
          <GovernanceEmpty>
            Registry access is restricted to an active owner or admin session
            with a canonical workspace identity. No registry request was made
            and no zero total is inferred.
          </GovernanceEmpty>
        ) : (
          <>
            {online !== "online" ? (
              <Alert variant="warning" role="status">
                <AlertTitle>Writes unavailable while {online}</AlertTitle>
                <AlertDescription>
                  Existing rows are orientation only. Add, import, and removal
                  requests require a verified online connection and are never
                  placed in the offline queue.
                </AlertDescription>
              </Alert>
            ) : null}

            <form
              className="grid min-w-0 gap-3 rounded-xl border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(12rem,1.4fr)_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                const validation = validatePushHashPrefix(hashDraft);
                setHashError(validation);
                if (!validation) setHashPrefix(hashDraft);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="push-platform-filter">Platform</Label>
                <Select
                  id="push-platform-filter"
                  value={platform}
                  onChange={(event) =>
                    setPlatform(event.target.value as typeof platform)
                  }
                >
                  <option value="all">All platforms</option>
                  <option value="apns">APNs</option>
                  <option value="fcm">FCM</option>
                  <option value="web">Web push</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="push-reason-filter">Authority reason</Label>
                <Select
                  id="push-reason-filter"
                  value={reason}
                  onChange={(event) =>
                    setReason(event.target.value as typeof reason)
                  }
                >
                  <option value="all">All reasons</option>
                  <option value="manual">Manual</option>
                  <option value="unregistered">Unregistered</option>
                  <option value="expired">Expired</option>
                  <option value="complaint">Complaint</option>
                  <option value="user_opt_out">User opt-out</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="push-fingerprint-filter">
                  Fingerprint prefix
                </Label>
                <Input
                  id="push-fingerprint-filter"
                  value={hashDraft}
                  onChange={(event) => {
                    setHashDraft(event.target.value);
                    setHashError(null);
                  }}
                  minLength={8}
                  maxLength={16}
                  pattern="[0-9a-f]{8,16}"
                  placeholder="8–16 lowercase hex"
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(hashError)}
                  aria-describedby={hashError ? "push-hash-error" : undefined}
                />
                {hashError ? (
                  <p
                    id="push-hash-error"
                    role="alert"
                    className="text-xs text-destructive-emphasis"
                  >
                    {hashError}
                  </p>
                ) : null}
              </div>
              <div className="flex items-end gap-2">
                <Button type="submit" variant="outline">
                  Apply
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPlatform("all");
                    setReason("all");
                    setHashDraft("");
                    setHashPrefix("");
                    setHashError(null);
                  }}
                >
                  Reset
                </Button>
              </div>
            </form>

            {query.isPending ? (
              <GovernanceLoading
                label="Loading customer push registry…"
                rows={3}
              />
            ) : query.isError || merged.error || !merged.value ? (
              <GovernanceError
                message="Could not verify the tenant, response cutoff, pagination, row authority, or timestamp contract. The registry total is unknown."
                retrying={query.isFetching}
                onRetry={() => void refresh()}
              />
            ) : (
              <>
                <GovernanceMetrics
                  columns={3}
                  items={[
                    {
                      label: "Active authorities",
                      value: verifiedRoster
                        ? merged.value.total.toLocaleString()
                        : "Unverified",
                      detail: `${pluralizeCount(rows.length, "row")} loaded`,
                    },
                    {
                      label: "Manual removable",
                      value: verifiedRoster
                        ? removableRows.length.toLocaleString()
                        : "Unverified",
                      detail: "Dashboard-authored rows only",
                    },
                    {
                      label: "Snapshot",
                      value: formatWireTimestamp(
                        merged.value.snapshotAt,
                        "Unknown",
                      ),
                      detail: merged.value.hasMore
                        ? "Additional rows remain"
                        : "No continuation cursor reported",
                    },
                  ]}
                />
                {!verifiedRoster ? (
                  <Alert variant="warning" role="status">
                    <AlertTitle>Rows are orientation only</AlertTitle>
                    <AlertDescription>
                      This snapshot is stale or refreshing. Writes remain locked
                      until a complete current response verifies again.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="grid gap-4 xl:grid-cols-2">
                  <form
                    className="space-y-3 rounded-xl border p-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      stageAdd();
                    }}
                  >
                    <div>
                      <h3 className="text-sm font-semibold">Add exact token</h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Creates only a reversible manual dashboard authority.
                        The entry field is cleared before review and the token
                        is never displayed.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
                      <div className="space-y-2">
                        <Label htmlFor="push-add-platform">Platform</Label>
                        <Select
                          id="push-add-platform"
                          value={addPlatform}
                          disabled={!verifiedRoster || writeBusy}
                          onChange={(event) =>
                            setAddPlatform(
                              event.target.value as PushSuppressionPlatform,
                            )
                          }
                        >
                          <option value="apns">APNs</option>
                          <option value="fcm">FCM</option>
                          <option value="web">Web push</option>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="push-device-token">
                          Exact device token
                        </Label>
                        <Input
                          id="push-device-token"
                          type="password"
                          value={token}
                          disabled={!verifiedRoster || writeBusy}
                          onChange={(event) => {
                            setToken(event.target.value);
                            setTokenError(null);
                          }}
                          autoComplete="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          aria-invalid={Boolean(tokenError)}
                          aria-describedby={
                            tokenError ? "push-token-error" : "push-token-help"
                          }
                        />
                        <p
                          id="push-token-help"
                          className="text-xs text-muted-foreground"
                        >
                          20–4,096 UTF-8 bytes; no whitespace or controls.
                        </p>
                        {tokenError ? (
                          <p
                            id="push-token-error"
                            role="alert"
                            className="text-xs text-destructive-emphasis"
                          >
                            {tokenError}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      ref={addTriggerRef}
                      type="submit"
                      disabled={
                        !verifiedRoster || writeBusy || online !== "online"
                      }
                    >
                      <Plus aria-hidden="true" />
                      Review manual hold
                    </Button>
                  </form>

                  <div className="space-y-3 rounded-xl border p-4">
                    <div>
                      <h3 className="text-sm font-semibold">Bulk import CSV</h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Exact header <code>platform,device_token</code>; 1–100
                        unique rows and at most 512 KB. Token values are never
                        previewed.
                      </p>
                    </div>
                    <input
                      ref={fileRef}
                      className="sr-only"
                      type="file"
                      accept=".csv,text/csv"
                      tabIndex={-1}
                      onChange={(event) => void stageCsv(event)}
                    />
                    <Button
                      ref={importTriggerRef}
                      type="button"
                      variant="outline"
                      disabled={
                        !verifiedRoster || writeBusy || online !== "online"
                      }
                      onClick={() => fileRef.current?.click()}
                    >
                      <FileUp aria-hidden="true" />
                      Choose CSV for review
                    </Button>
                    {fileError ? (
                      <p
                        role="alert"
                        className="text-xs leading-5 text-destructive-emphasis"
                      >
                        {fileError}
                      </p>
                    ) : null}
                  </div>
                </div>

                {rows.length === 0 && verifiedRoster ? (
                  <GovernanceEmpty>
                    This verified registry snapshot contains no matching active
                    authority rows. It does not prove customer push delivery
                    readiness.
                  </GovernanceEmpty>
                ) : rows.length > 0 ? (
                  <div className="space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p
                        role="status"
                        className="text-xs text-muted-foreground"
                      >
                        {rows.length.toLocaleString()} of{" "}
                        {pluralizeCount(merged.value.total, "row")} loaded
                        {merged.value.hasMore
                          ? "; more available."
                          : "; no later page reported."}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!verifiedRoster || rows.length === 0}
                          onClick={exportVerifiedRows}
                        >
                          <Download aria-hidden="true" />
                          Export verified rows (CSV)
                        </Button>
                        <Button
                          ref={fallbackFocusRef}
                          type="button"
                          variant="destructive"
                          disabled={
                            !verifiedRoster ||
                            writeBusy ||
                            online !== "online" ||
                            selectedRows.length < 1 ||
                            selectedRows.length > 100
                          }
                          onClick={stageBulkRemove}
                        >
                          <Trash2 aria-hidden="true" />
                          Review removal ({selectedRows.length})
                        </Button>
                      </div>
                    </div>
                    <TableContainer aria-label="Customer push suppression registry">
                      <Table>
                        <caption className="sr-only">
                          Tenant-bound customer push suppression authorities.
                          Raw device tokens are never displayed.
                        </caption>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">
                              <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center sm:min-h-0 sm:min-w-0">
                                <Checkbox
                                  aria-label="Select all removable loaded rows"
                                  checked={
                                    removableRows.length > 0 &&
                                    removableRows
                                      .slice(0, 100)
                                      .every((row) => selected.has(row.id))
                                  }
                                  indeterminate={
                                    selectedRows.length > 0 &&
                                    selectedRows.length <
                                      Math.min(removableRows.length, 100)
                                  }
                                  disabled={
                                    !verifiedRoster ||
                                    writeBusy ||
                                    removableRows.length === 0
                                  }
                                  onChange={(event) => {
                                    if (!event.target.checked) {
                                      setSelected(new Set());
                                      return;
                                    }
                                    setSelected(
                                      new Set(
                                        removableRows
                                          .slice(0, 100)
                                          .map((row) => row.id),
                                      ),
                                    );
                                    if (removableRows.length > 100) {
                                      toast.info(
                                        "Selected the first 100 removable rows",
                                      );
                                    }
                                  }}
                                />
                              </label>
                            </TableHead>
                            <TableHead>Fingerprint</TableHead>
                            <TableHead>Platform</TableHead>
                            <TableHead>Authority</TableHead>
                            <TableHead>Updated</TableHead>
                            <TableHead>Version</TableHead>
                            <TableHead className="text-right">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((row) => {
                            const removable = rowCanBeRemoved(row);
                            return (
                              <TableRow key={row.id}>
                                <TableCell>
                                  {removable ? (
                                    <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center sm:min-h-0 sm:min-w-0">
                                      <Checkbox
                                        aria-label={`Select manual hold ${row.fingerprint}`}
                                        checked={selected.has(row.id)}
                                        disabled={!verifiedRoster || writeBusy}
                                        onChange={(event) => {
                                          setSelected((previous) => {
                                            const next = new Set(previous);
                                            if (event.target.checked) {
                                              if (next.size >= 100) {
                                                toast.error(
                                                  "At most 100 rows can be removed at once",
                                                );
                                                return previous;
                                              }
                                              next.add(row.id);
                                            } else next.delete(row.id);
                                            return next;
                                          });
                                        }}
                                      />
                                    </label>
                                  ) : (
                                    <LockKeyhole
                                      className="size-4 text-muted-foreground"
                                      aria-label="Locked"
                                    />
                                  )}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                  <bdi dir="ltr">{row.fingerprint}</bdi>
                                </TableCell>
                                <TableCell>
                                  {pushPlatformLabel(row.platform)}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    variant={
                                      removable ? "outline" : "secondary"
                                    }
                                  >
                                    {row.reason.replaceAll("_", " ")}
                                  </Badge>
                                  <span className="mt-1 block max-w-52 text-xs capitalize text-muted-foreground">
                                    {pushAuthorityLabel(row)}
                                  </span>
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                  <RelativeTime iso={row.updatedAt} />
                                </TableCell>
                                <TableCell className="tabular-nums">
                                  {row.version}
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex flex-wrap justify-end gap-1.5">
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      aria-label={`Open details for ${row.fingerprint}`}
                                      onClick={(event) => {
                                        detailTriggerRef.current =
                                          event.currentTarget;
                                        setDetailFor({ ...row });
                                      }}
                                    >
                                      Details
                                    </Button>
                                    {removable ? (
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        disabled={
                                          !verifiedRoster ||
                                          writeBusy ||
                                          online !== "online"
                                        }
                                        onClick={(event) => {
                                          reviewReturnFocusRef.current =
                                            event.currentTarget;
                                          setReview({
                                            kind: "remove",
                                            rows: [{ ...row }],
                                          });
                                        }}
                                      >
                                        Remove
                                      </Button>
                                    ) : (
                                      <Badge variant="secondary">Locked</Badge>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </TableContainer>
                    {query.hasNextPage ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={query.isFetchingNextPage || writeBusy}
                        loading={query.isFetchingNextPage}
                        onClick={() =>
                          void loadNextQueryPage(query, query.isEnabled)
                        }
                      >
                        {query.isFetchingNextPage
                          ? "Loading…"
                          : "Load more authorities"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
      </div>

      {detailFor ? (
        <PushSuppressionDetailDialog
          row={detailFor}
          returnFocusRef={detailTriggerRef}
          onClose={() => setDetailFor(null)}
        />
      ) : null}

      {review && confirmation ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setReview(null);
          }}
          title={confirmation.title}
          description={confirmation.description}
          confirmLabel={confirmation.label}
          confirmVariant={review.kind === "remove" ? "destructive" : "default"}
          confirmationToken={confirmation.token}
          returnFocusRef={reviewReturnFocusRef}
          fallbackFocusRef={fallbackFocusRef}
          onConfirm={() => commitReview(review)}
        />
      ) : null}
    </GovernanceSection>
  );
}
