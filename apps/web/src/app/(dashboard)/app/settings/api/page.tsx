// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

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
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyTextButton } from "@/components/copy-text-button";
import { apiErrorMessage } from "@/lib/api";
import {
  ALL_API_KEY_SCOPES,
  type ApiKey,
  type ApiKeyScope,
  createApiKey,
  listApiKeys,
  listApiKeyUsage,
  updateApiKey,
  maskedDisplay,
  revokeApiKey,
  rotateApiKey,
  validateAllowedIp,
} from "@/lib/api-keys-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { qk, STALE } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import { roleCanWrite } from "@/lib/use-admin-gate";

type SortKey = "label" | "createdAt" | "lastUsedAt";
type SortDir = "asc" | "desc";

// The expiry field is an <input type="date">, whose value is a LOCAL calendar
// day. Deriving the floor from a UTC timestamp is off by a day on either side of
// midnight for most of the world, which would either block today or allow
// yesterday.
function localCalendarDay(now: Date): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function DateCell({ value }: { value?: string | null }) {
  if (!value) return <span className="text-muted-foreground">Never</span>;
  const rel = timeAgo(value);
  const abs = absoluteTime(value);
  if (!rel) return <span className="text-muted-foreground">Never</span>;
  return (
    <span className="text-muted-foreground" title={abs || undefined}>
      {rel}
    </span>
  );
}

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const createLabelId = useId();
  const createScopesId = useId();
  const createErrorId = useId();
  const editLabelId = useId();
  const editScopesId = useId();
  const editErrorId = useId();
  const revokeTokenId = useId();
  const revokeErrorId = useId();
  const rotateErrorId = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState("");
  const [stored, setStored] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [usageKeyId, setUsageKeyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editScopes, setEditScopes] = useState<ApiKeyScope[]>([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeToken, setRevokeToken] = useState("");
  const [rotatePending, setRotatePending] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<ApiKeyScope[]>([]);
  const [sandboxOnly, setSandboxOnly] = useState(false);
  const [allowedIps, setAllowedIps] = useState("");
  const [expiresAt, setExpiresAt] = useState(""); // SETC-036 (yyyy-mm-dd)
  // Table controls (SETC-036).
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "createdAt",
    dir: "desc",
  });
  const createPendingRef = useRef(false);
  const editPendingRef = useRef(false);
  const revokePendingRef = useRef(false);
  const rotatePendingRef = useRef(false);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const revealReturnRef = useRef<HTMLButtonElement | null>(null);
  const createErrorRef = useRef<HTMLDivElement>(null);
  const editErrorRef = useRef<HTMLDivElement>(null);
  const revokeErrorRef = useRef<HTMLDivElement>(null);
  const rotateErrorRef = useRef<HTMLDivElement>(null);
  const mutationControllersRef = useRef(new Set<AbortController>());
  const authorityKeyRef = useRef("unverified");
  const previousAuthorityRef = useRef<string | null>(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canWrite = Boolean(
    meQuery.isSuccess &&
      meQuery.data &&
      !meQuery.data.viewer_mode &&
      roleCanWrite(role),
  );
  const authorityKey = canWrite
    ? `${tenantId}:${meQuery.data!.user_id}:${role}:member`
    : "unverified";
  const apiKeysKey = useMemo(
    () => [...qk.settings(tenantId, role, "api-keys"), authorityKey] as const,
    [authorityKey, role, tenantId],
  );
  const apiKeysQuery = useQuery({
    queryKey: apiKeysKey,
    queryFn: ({ signal }) => listApiKeys(signal),
    enabled: canWrite,
    staleTime: STALE.list,
  });
  // Memoised so the `?? []` fallback keeps a stable identity while the query is
  // pending — otherwise every render produced a fresh array and re-ran the
  // visibleKeys sort/filter below.
  const keys = useMemo(
    () => (Array.isArray(apiKeysQuery.data) ? apiKeysQuery.data : []),
    [apiKeysQuery.data],
  );
  const usageQuery = useQuery({
    queryKey: [...apiKeysKey, "usage", usageKeyId],
    queryFn: ({ signal }) => listApiKeyUsage(usageKeyId!, signal),
    enabled: canWrite && Boolean(usageKeyId),
    staleTime: STALE.list,
    retry: false,
  });
  const loading =
    meQuery.isLoading || (apiKeysQuery.isPending && !apiKeysQuery.data);
  const error =
    apiKeysQuery.error instanceof Error
      ? apiKeysQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : apiKeysQuery.isError
          ? "Could not load API keys — this is a failed request, not a workspace without keys."
          : null;

  const visibleKeys = useMemo(
    () => sortKeys(filterKeys(keys, search), sort),
    [keys, search, sort],
  );
  const editingKey = editId ? keys.find((key) => key.id === editId) : null;
  const revokingKey = revokeId ? keys.find((key) => key.id === revokeId) : null;
  const rotatingKey = rotateId ? keys.find((key) => key.id === rotateId) : null;
  const editChanged = editingKey
    ? editingKey.label !== editLabel.trim() ||
      !sameScopes(editingKey.scopes, editScopes)
    : false;

  useEffect(() => {
    authorityKeyRef.current = authorityKey;
    const previous = previousAuthorityRef.current;
    if (previous && previous !== authorityKey) {
      for (const controller of mutationControllersRef.current) controller.abort();
      mutationControllersRef.current.clear();
      createPendingRef.current = false;
      editPendingRef.current = false;
      revokePendingRef.current = false;
      rotatePendingRef.current = false;
      setCreatePending(false);
      setEditSaving(false);
      setRevokePending(false);
      setRotatePending(false);
      setCreateOpen(false);
      setRevealOpen(false);
      setRevealedKey("");
      setStored(false);
      setRevokeId(null);
      setRotateId(null);
      setUsageKeyId(null);
      setEditId(null);
      setEditLabel("");
      setEditScopes([]);
      setRevokeToken("");
      resetCreateDraft();
      void queryClient.cancelQueries({
        predicate: (query) => query.queryKey.includes(previous),
      });
      queryClient.removeQueries({
        predicate: (query) => query.queryKey.includes(previous),
      });
    }
    previousAuthorityRef.current =
      authorityKey === "unverified" ? null : authorityKey;
  }, [authorityKey, queryClient]);

  const beginAdminMutation = () => {
    if (!meQuery.data || !canWrite) return null;
    const controller = new AbortController();
    mutationControllersRef.current.add(controller);
    return { controller, identity: meQuery.data, openedKey: authorityKey };
  };

  const finishAdminMutation = (controller: AbortController) => {
    mutationControllersRef.current.delete(controller);
  };

  const mutationStillCurrent = (openedKey: string, controller: AbortController) =>
    !controller.signal.aborted && authorityKeyRef.current === openedKey;

  useEffect(() => {
    if (apiKeysQuery.error) toast.error("Failed to load API keys.");
  }, [apiKeysQuery.error]);

  useEffect(() => {
    if (createError) createErrorRef.current?.focus();
  }, [createError]);

  useEffect(() => {
    if (editError) editErrorRef.current?.focus();
  }, [editError]);

  useEffect(() => {
    if (revokeError) revokeErrorRef.current?.focus();
  }, [revokeError]);

  useEffect(() => {
    if (rotateError) rotateErrorRef.current?.focus();
  }, [rotateError]);

  const invalidateApiKeys = (): Promise<void> =>
    queryClient
      .invalidateQueries({ queryKey: apiKeysKey, exact: false })
      .then(() => undefined);

  const restoreDialogFocus = (preferred: HTMLButtonElement | null) => {
    const target = preferred?.isConnected
      ? preferred
      : createTriggerRef.current;
    target?.focus();
  };

  const toggleScope = (s: ApiKeyScope) => {
    if (createPendingRef.current) return;
    setCreateError(null);
    setSelectedScopes((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    );
  };

  const resetCreateDraft = () => {
    setLabel("");
    setSelectedScopes([]);
    setSandboxOnly(false);
    setAllowedIps("");
    setExpiresAt("");
    setCreateError(null);
  };

  const handleCreateOpenChange = (next: boolean) => {
    if (!next && createPendingRef.current) return;
    if (next) setCreateError(null);
    else resetCreateDraft();
    setCreateOpen(next);
  };

  const toggleSort = (key: SortKey) =>
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "label" ? "asc" : "desc" },
    );

  const handleCreate = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (createPendingRef.current) return;
    if (!label.trim()) {
      setCreateError("Enter a label for this key.");
      return;
    }
    if (selectedScopes.length === 0) {
      setCreateError("Select at least one scope.");
      return;
    }
    const ipList = allowedIps
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of ipList) {
      const err = validateAllowedIp(entry);
      if (err) {
        setCreateError(err);
        return;
      }
    }
    // The server stores whatever expiry it is handed, so a mistyped year mints a
    // key that is already dead: the reveal dialog hands over plaintext that 401s
    // on its first request and the new row reads "Expired" seconds later. Catch
    // it here, while the operator still has the form open.
    let expiresAtIso: string | null = null;
    if (expiresAt) {
      const expiry = new Date(`${expiresAt}T23:59:59`);
      if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
        setCreateError("Expiry must be a future date.");
        return;
      }
      expiresAtIso = expiry.toISOString();
    }
    const intent = {
      label: label.trim(),
      scopes: [...selectedScopes],
      sandbox_only: sandboxOnly,
      ...(ipList.length > 0 ? { allowed_ips: [...ipList] } : {}),
      ...(expiresAtIso ? { expires_at: expiresAtIso } : {}),
    };
    const operation = beginAdminMutation();
    if (!operation) return;
    createPendingRef.current = true;
    setCreatePending(true);
    setCreateError(null);
    try {
      await verifyFreshAdminAuthority(
        operation.identity,
        operation.controller.signal,
      );
      const res = await createApiKey(intent, operation.controller.signal);
      if (!mutationStillCurrent(operation.openedKey, operation.controller)) return;
      if (!res?.key?.id || !res.plaintext?.trim()) {
        throw new Error(
          "The API returned an invalid key acknowledgement. Retry without changing the form.",
        );
      }
      queryClient.setQueryData<ApiKey[]>(apiKeysKey, (cur) => [
        res.key,
        ...(cur ?? []),
      ]);
      setRevealedKey(res.plaintext);
      setStored(false);
      resetCreateDraft();
      revealReturnRef.current = createTriggerRef.current;
      setCreateOpen(false);
      setRevealOpen(true);
      void invalidateApiKeys();
    } catch (cause) {
      if (!mutationStillCurrent(operation.openedKey, operation.controller)) return;
      setCreateError(apiErrorMessage(cause, "Could not create this API key."));
    } finally {
      finishAdminMutation(operation.controller);
      if (authorityKeyRef.current === operation.openedKey) {
        createPendingRef.current = false;
        setCreatePending(false);
      }
    }
  };

  const handleConfirmRevoke = async () => {
    if (!revokeId || revokePendingRef.current) return;
    if (!revokingKey || revokeToken !== revokingKey.label) {
      setRevokeError(`Type ${revokingKey?.label ?? "the key label"} exactly.`);
      return;
    }
    const intentId = revokeId;
    const operation = beginAdminMutation();
    if (!operation) return;
    revokePendingRef.current = true;
    setRevokePending(true);
    setRevokeError(null);
    try {
      await verifyFreshAdminAuthority(operation.identity, operation.controller.signal);
      const acknowledgement = await revokeApiKey(intentId, operation.controller.signal);
      if (!mutationStillCurrent(operation.openedKey, operation.controller)) return;
      if (acknowledgement?.ok !== true) {
        throw new Error(
          "The API returned an invalid revoke acknowledgement. Retry without changing the confirmation.",
        );
      }
      queryClient.setQueryData<ApiKey[]>(apiKeysKey, (cur) =>
        (cur ?? []).filter((k) => k.id !== intentId),
      );
      toast.success("Key revoked.");
      setRevokeId(null);
      setRevokeToken("");
      void invalidateApiKeys();
    } catch (cause) {
      if (!mutationStillCurrent(operation.openedKey, operation.controller)) return;
      setRevokeError(apiErrorMessage(cause, "Could not revoke this API key."));
    } finally {
      finishAdminMutation(operation.controller);
      if (authorityKeyRef.current === operation.openedKey) {
        revokePendingRef.current = false;
        setRevokePending(false);
      }
    }
  };

  const handleConfirmRotate = async () => {
    if (!rotateId || !canWrite || rotatePendingRef.current) return;
    const intentId = rotateId;
    const operation = beginAdminMutation();
    if (!operation) return;
    rotatePendingRef.current = true;
    setRotatePending(true);
    setRotateError(null);
    try {
      await verifyFreshAdminAuthority(operation.identity, operation.controller.signal);
      const result = await rotateApiKey(intentId, operation.controller.signal);
      if (!mutationStillCurrent(operation.openedKey, operation.controller)) return;
      if (
        !result?.key?.id ||
        !result.plaintext?.trim() ||
        result.revoked_id !== intentId
      ) {
        throw new Error(
          "The API returned an invalid rotation acknowledgement. Retry without closing this dialog.",
        );
      }
      queryClient.setQueryData<ApiKey[]>(apiKeysKey, (cur) => [
        result.key,
        ...(cur ?? []).filter((key) => key.id !== result.revoked_id),
      ]);
      setRevealedKey(result.plaintext);
      setStored(false);
      revealReturnRef.current = actionTriggerRef.current;
      setRotateId(null);
      setRevealOpen(true);
      toast.success("Key rotated. The previous key is now revoked.");
      void invalidateApiKeys();
    } catch (cause) {
      if (!mutationStillCurrent(operation.openedKey, operation.controller)) return;
      setRotateError(apiErrorMessage(cause, "Could not rotate this API key."));
    } finally {
      finishAdminMutation(operation.controller);
      if (authorityKeyRef.current === operation.openedKey) {
        rotatePendingRef.current = false;
        setRotatePending(false);
      }
    }
  };

  // SETC-040: edit a key's label + scopes in place.
  const startEdit = (k: ApiKey, trigger: HTMLButtonElement) => {
    actionTriggerRef.current = trigger;
    setEditId(k.id);
    setEditLabel(k.label);
    setEditScopes(k.scopes);
    setEditError(null);
  };
  const toggleEditScope = (s: ApiKeyScope) => {
    if (editPendingRef.current) return;
    setEditError(null);
    setEditScopes((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    );
  };
  const handleConfirmEdit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!editId || editPendingRef.current) return;
    if (!editLabel.trim()) {
      setEditError("Enter a label for this key.");
      return;
    }
    if (editScopes.length === 0) {
      setEditError("Select at least one scope.");
      return;
    }
    if (!editChanged) {
      setEditError(
        "Nothing changed. Update the label or scopes before saving.",
      );
      return;
    }
    const intentId = editId;
    const intent = { label: editLabel.trim(), scopes: [...editScopes] };
    const operation = beginAdminMutation();
    if (!operation) return;
    editPendingRef.current = true;
    setEditSaving(true);
    setEditError(null);
    try {
      await verifyFreshAdminAuthority(operation.identity, operation.controller.signal);
      const updated = await updateApiKey(
        intentId,
        intent,
        operation.controller.signal,
      );
      if (!mutationStillCurrent(operation.openedKey, operation.controller)) return;
      if (!updated?.id || updated.id !== intentId) {
        throw new Error(
          "The API returned an invalid update acknowledgement. Retry without changing the form.",
        );
      }
      queryClient.setQueryData<ApiKey[]>(apiKeysKey, (cur) =>
        (cur ?? []).map((k) => (k.id === updated.id ? updated : k)),
      );
      toast.success("API key updated.");
      setEditId(null);
      void invalidateApiKeys();
    } catch (cause) {
      if (!mutationStillCurrent(operation.openedKey, operation.controller)) return;
      setEditError(apiErrorMessage(cause, "Could not update this API key."));
    } finally {
      finishAdminMutation(operation.controller);
      if (authorityKeyRef.current === operation.openedKey) {
        editPendingRef.current = false;
        setEditSaving(false);
      }
    }
  };

  const closeEdit = (next: boolean) => {
    if (!next && editPendingRef.current) return;
    if (!next) {
      setEditId(null);
      setEditError(null);
    }
  };

  const openUsage = (keyId: string, trigger: HTMLButtonElement) => {
    actionTriggerRef.current = trigger;
    setUsageKeyId(keyId);
  };

  const openRevoke = (keyId: string, trigger: HTMLButtonElement) => {
    actionTriggerRef.current = trigger;
    setRevokeToken("");
    setRevokeError(null);
    setRevokeId(keyId);
  };

  const closeRevoke = (next: boolean) => {
    if (!next && revokePendingRef.current) return;
    if (!next) {
      setRevokeId(null);
      setRevokeToken("");
      setRevokeError(null);
    }
  };

  const openRotate = (keyId: string, trigger: HTMLButtonElement) => {
    actionTriggerRef.current = trigger;
    setRotateError(null);
    setRotateId(keyId);
  };

  const closeRotate = (next: boolean) => {
    if (!next && rotatePendingRef.current) return;
    if (!next) {
      setRotateId(null);
      setRotateError(null);
    }
  };

  const clearReveal = () => {
    setRevealOpen(false);
    setRevealedKey("");
    setStored(false);
  };

  const handleCloseReveal = (next: boolean) => {
    if (!next && !stored) {
      toast.warning(
        "Confirm you've stored the key before closing — we can't show it again.",
      );
      return;
    }
    if (!next) {
      clearReveal();
      return;
    }
    setRevealOpen(true);
  };

  const handleDoneReveal = () => {
    if (!stored) return;
    clearReveal();
  };

  if (meQuery.isError || (meQuery.isFetched && !meQuery.data)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            API-key administration access could not be verified. No API keys or
            MCP execution records were requested.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            loading={meQuery.isFetching}
            onClick={() => void meQuery.refetch()}
          >
            {meQuery.isFetching ? "Retrying…" : "Retry identity"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (meQuery.isSuccess && !canWrite) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            API keys and MCP execution records require an owner or administrator
            role and are unavailable in viewer mode.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle>API keys</CardTitle>
            <CardDescription>
              Used by SDKs, integrations, and automations. We show the full
              secret once at creation and only the prefix afterwards.
            </CardDescription>
          </div>
          {canWrite ? (
            <Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
              <DialogTrigger asChild>
                <Button
                  ref={createTriggerRef}
                  type="button"
                  className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                >
                  Create new key
                </Button>
              </DialogTrigger>
              <DialogContent
                aria-busy={createPending}
                className="[&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-h-9 sm:[&_input]:min-h-9 sm:[&_input]:text-sm"
                onEscapeKeyDown={(event) => {
                  if (createPendingRef.current) event.preventDefault();
                }}
                onPointerDownOutside={(event) => {
                  if (createPendingRef.current) event.preventDefault();
                }}
                onCloseAutoFocus={(event) => {
                  if (revealOpen) return;
                  event.preventDefault();
                  createTriggerRef.current?.focus();
                }}
              >
                <form onSubmit={handleCreate} className="contents" noValidate>
                  <DialogHeader>
                    <DialogTitle>Create an API key</DialogTitle>
                    <DialogDescription>
                      Give it a label and pick scopes. Narrower scopes are
                      safer.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    <div className="space-y-2">
                      <Label htmlFor={createLabelId}>Label</Label>
                      <Input
                        id={createLabelId}
                        placeholder="Production / Zapier"
                        value={label}
                        disabled={createPending}
                        required
                        autoFocus
                        aria-invalid={Boolean(createError && !label.trim())}
                        aria-describedby={
                          createError ? createErrorId : undefined
                        }
                        onChange={(e) => {
                          setLabel(e.target.value);
                          setCreateError(null);
                        }}
                      />
                    </div>
                    <fieldset
                      className="min-w-0 space-y-2"
                      aria-describedby={createError ? createErrorId : undefined}
                    >
                      <legend
                        id={createScopesId}
                        className="text-sm font-medium"
                      >
                        Scopes
                      </legend>
                      <div className="max-h-56 space-y-2 overflow-auto rounded-md border p-3">
                        {ALL_API_KEY_SCOPES.map((s) => {
                          const checked = selectedScopes.includes(s.value);
                          return (
                            <label
                              key={s.value}
                              className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0"
                            >
                              <Checkbox
                                checked={checked}
                                disabled={createPending}
                                onChange={() => toggleScope(s.value)}
                              />
                              <span className="font-mono text-xs">
                                {s.value}
                              </span>
                              <span className="text-muted-foreground text-xs">
                                — {s.label}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                    <div className="space-y-2">
                      <Label htmlFor="allowed-ips">
                        IP allowlist (optional)
                      </Label>
                      <Input
                        id="allowed-ips"
                        placeholder="203.0.113.0/24, 198.51.100.7"
                        value={allowedIps}
                        disabled={createPending}
                        onChange={(e) => {
                          setAllowedIps(e.target.value);
                          setCreateError(null);
                        }}
                        className="font-mono text-xs"
                      />
                      <p className="text-xs text-muted-foreground">
                        Comma- or space-separated IPs / CIDR blocks. Requests
                        from other addresses are rejected. Leave blank for no
                        restriction.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="expires-at">Expiry (optional)</Label>
                      <Input
                        id="expires-at"
                        type="date"
                        min={localCalendarDay(new Date())}
                        value={expiresAt}
                        disabled={createPending}
                        onChange={(e) => {
                          setExpiresAt(e.target.value);
                          setCreateError(null);
                        }}
                        className="text-xs"
                      />
                      <p className="text-xs text-muted-foreground">
                        After this date the key stops authenticating. Leave
                        blank for a key that never expires (SETC-036).
                      </p>
                    </div>
                    <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
                      <Checkbox
                        className="mt-1"
                        checked={sandboxOnly}
                        disabled={createPending}
                        onChange={(e) => {
                          setSandboxOnly(e.target.checked);
                          setCreateError(null);
                        }}
                      />
                      <span>
                        <span className="block font-medium">
                          Sandbox-only key
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Forces send/test flows into lifecycle simulation so
                          this key can never dispatch live email.
                        </span>
                      </span>
                    </label>
                  </div>
                  {createError ? (
                    <div
                      ref={createErrorRef}
                      id={createErrorId}
                      role="alert"
                      tabIndex={-1}
                      className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {createError}
                    </div>
                  ) : null}
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={createPending}
                      >
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button
                      type="submit"
                      disabled={createPending}
                      loading={createPending}
                    >
                      {createPending ? "Creating…" : "Create"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : null}
        </CardHeader>
        <CardContent>
          {error && keys.length === 0 ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis">
              <p>{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void apiKeysQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : loading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : keys.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No API keys yet"
              description="Create a key to start using the SDKs, integrations, and automations."
            />
          ) : (
            <div className="space-y-3">
              <Input
                type="search"
                placeholder="Filter by label, scope, or mode…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-xs"
                aria-label="Filter API keys"
              />
              <div
                role="region"
                aria-label="API keys"
                tabIndex={0}
                className="border rounded-md overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <SortHeader
                        label="Label"
                        active={sort.key === "label"}
                        dir={sort.dir}
                        onClick={() => toggleSort("label")}
                      />
                      <th
                        scope="col"
                        className="text-left px-3 py-2 font-medium"
                      >
                        Key
                      </th>
                      <th
                        scope="col"
                        className="text-left px-3 py-2 font-medium"
                      >
                        Scopes
                      </th>
                      <th
                        scope="col"
                        className="text-left px-3 py-2 font-medium"
                      >
                        Mode
                      </th>
                      <SortHeader
                        label="Created"
                        active={sort.key === "createdAt"}
                        dir={sort.dir}
                        onClick={() => toggleSort("createdAt")}
                      />
                      <SortHeader
                        label="Last used"
                        active={sort.key === "lastUsedAt"}
                        dir={sort.dir}
                        onClick={() => toggleSort("lastUsedAt")}
                      />
                      <th
                        scope="col"
                        className="text-right px-3 py-2 font-medium"
                      >
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleKeys.length === 0 ? (
                      <tr className="border-t">
                        <td
                          colSpan={7}
                          className="px-3 py-6 text-center text-muted-foreground"
                        >
                          No keys match “{search}”.
                        </td>
                      </tr>
                    ) : (
                      visibleKeys.map((k) => (
                        <tr key={k.id} className="border-t">
                          <td className="px-3 py-2">
                            <div>{k.label}</div>
                            {k.expiresAt ? (
                              <div className="text-[11px] text-muted-foreground">
                                {new Date(k.expiresAt) < new Date()
                                  ? "Expired"
                                  : `Expires ${new Date(k.expiresAt).toLocaleDateString()}`}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs">
                                {maskedDisplay(k)}
                              </span>
                              <CopyTextButton
                                value={k.prefix}
                                label="Copy prefix"
                                copiedLabel="Copied"
                                variant="ghost"
                                size="icon"
                                className="size-11 sm:size-6"
                                toastOnCopy={false}
                              />
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {k.scopes.map((s) => (
                                <Badge
                                  key={s}
                                  variant="secondary"
                                  className="text-[10px] font-mono"
                                >
                                  {s}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <Badge
                              variant={k.sandboxOnly ? "outline" : "secondary"}
                            >
                              {k.sandboxOnly ? "Sandbox" : "Live"}
                            </Badge>
                          </td>
                          <td className="px-3 py-2">
                            <DateCell value={k.createdAt} />
                          </td>
                          <td className="px-3 py-2">
                            <DateCell value={k.lastUsedAt} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              className="min-h-11 sm:min-h-8"
                              onClick={(event) =>
                                openUsage(k.id, event.currentTarget)
                              }
                            >
                              Usage
                            </Button>
                            {canWrite ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  type="button"
                                  className="min-h-11 sm:min-h-8"
                                  onClick={(event) =>
                                    startEdit(k, event.currentTarget)
                                  }
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  type="button"
                                  className="min-h-11 sm:min-h-8"
                                  onClick={(event) =>
                                    openRotate(k.id, event.currentTarget)
                                  }
                                >
                                  Rotate
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  type="button"
                                  className="min-h-11 sm:min-h-8"
                                  onClick={(event) =>
                                    openRevoke(k.id, event.currentTarget)
                                  }
                                >
                                  Revoke
                                </Button>
                              </>
                            ) : null}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={revealOpen} onOpenChange={handleCloseReveal}>
        <DialogContent
          className="[&_button]:min-h-11 sm:[&_button]:min-h-9"
          onEscapeKeyDown={(event) => {
            if (!stored) {
              event.preventDefault();
              toast.warning(
                "Confirm you've stored the key before closing — we can't show it again.",
              );
            }
          }}
          onPointerDownOutside={(event) => {
            if (!stored) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreDialogFocus(revealReturnRef.current);
          }}
        >
          <DialogHeader>
            <DialogTitle>Save this key now</DialogTitle>
            <DialogDescription>
              This is the only time we&apos;ll show the full secret. Copy it
              into a password manager or your CI secret store before closing.
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 py-2">
            <code
              tabIndex={0}
              aria-label="New API key secret"
              className="block break-all rounded-md bg-muted p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {revealedKey}
            </code>
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
            <Checkbox
              checked={stored}
              onChange={(e) => setStored(e.target.checked)}
            />
            I&apos;ve stored it safely.
          </label>
          <DialogFooter>
            <CopyTextButton
              value={revealedKey}
              label="Copy"
              copiedLabel="Copied"
              variant="ghost"
            />
            <Button type="button" disabled={!stored} onClick={handleDoneReveal}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SETC-040: edit label + scopes in place. */}
      <Dialog open={editId !== null} onOpenChange={closeEdit}>
        <DialogContent
          aria-busy={editSaving}
          className="[&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-h-9 sm:[&_input]:min-h-9 sm:[&_input]:text-sm"
          onEscapeKeyDown={(event) => {
            if (editPendingRef.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (editPendingRef.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreDialogFocus(actionTriggerRef.current);
          }}
        >
          <form onSubmit={handleConfirmEdit} className="contents" noValidate>
            <DialogHeader>
              <DialogTitle>Edit API key</DialogTitle>
              <DialogDescription>
                Change the label and scopes without rotating the secret.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor={editLabelId}>Label</Label>
                <Input
                  id={editLabelId}
                  value={editLabel}
                  disabled={editSaving}
                  required
                  autoFocus
                  aria-describedby={editError ? editErrorId : undefined}
                  aria-invalid={Boolean(editError && !editLabel.trim())}
                  onChange={(e) => {
                    setEditLabel(e.target.value);
                    setEditError(null);
                  }}
                />
              </div>
              <fieldset
                className="min-w-0 space-y-2"
                aria-describedby={editError ? editErrorId : undefined}
              >
                <legend id={editScopesId} className="text-sm font-medium">
                  Scopes
                </legend>
                <div className="grid gap-1.5">
                  {ALL_API_KEY_SCOPES.map((s) => (
                    <label
                      key={s.value}
                      className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0"
                    >
                      <Checkbox
                        checked={editScopes.includes(s.value)}
                        disabled={editSaving}
                        onChange={() => toggleEditScope(s.value)}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            {editError ? (
              <div
                ref={editErrorRef}
                id={editErrorId}
                role="alert"
                tabIndex={-1}
                className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {editError}
              </div>
            ) : !editChanged ? (
              <p role="status" className="text-sm text-muted-foreground">
                No changes to save.
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost" type="button" disabled={editSaving}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={editSaving || !editChanged}
                loading={editSaving}
              >
                {editSaving ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* SETC-041: per-key recent-request drill-in. */}
      <Dialog
        open={usageKeyId !== null}
        onOpenChange={(open) => {
          if (!open) setUsageKeyId(null);
        }}
      >
        <DialogContent
          aria-busy={usageQuery.isFetching}
          className="max-w-2xl [&_button]:min-h-11 sm:[&_button]:min-h-9"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreDialogFocus(actionTriggerRef.current);
          }}
        >
          <DialogHeader>
            <DialogTitle>Recent requests</DialogTitle>
            <DialogDescription>
              The 50 most recent requests made with this key.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60dvh] min-w-0 overflow-auto rounded-md border">
            {usageQuery.isPending ? (
              <div
                role="status"
                aria-label="Loading recent API key requests"
                className="space-y-2 p-4"
              >
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <span className="sr-only">Loading recent requests…</span>
              </div>
            ) : usageQuery.isError && (usageQuery.data ?? []).length === 0 ? (
              // A failed lookup used to fall through to "no recorded requests",
              // which reads as a key nobody has used rather than a request that
              // did not answer.
              <div
                role="alert"
                className="m-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
              >
                <p>
                  {apiErrorMessage(
                    usageQuery.error,
                    "Could not load this key's recent requests.",
                  )}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void usageQuery.refetch()}
                >
                  Retry recent requests
                </Button>
              </div>
            ) : (usageQuery.data ?? []).length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No recorded requests for this key yet.
              </p>
            ) : (
              <table className="min-w-[38rem] w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      When
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Method
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Path
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-right font-medium"
                    >
                      Status
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-right font-medium"
                    >
                      Latency
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(Array.isArray(usageQuery.data) ? usageQuery.data : []).map(
                    (c) => (
                      <tr key={c.id}>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          <DateCell value={c.calledAt} />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {c.method}
                        </td>
                        <td className="max-w-[220px] truncate px-3 py-2 font-mono text-xs">
                          {c.toolName || c.path}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span
                            className={
                              c.statusCode >= 400 ? "text-destructive" : ""
                            }
                          >
                            {c.statusCode}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.latencyMs}ms
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeId !== null} onOpenChange={closeRevoke}>
        <DialogContent
          aria-busy={revokePending}
          className="[&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-h-9 sm:[&_input]:min-h-9 sm:[&_input]:text-sm"
          onEscapeKeyDown={(event) => {
            if (revokePendingRef.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (revokePendingRef.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreDialogFocus(actionTriggerRef.current);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleConfirmRevoke();
            }}
            className="contents"
          >
            <DialogHeader>
              <DialogTitle>Revoke this key?</DialogTitle>
              <DialogDescription>
                This is immediate and cannot be undone. Anything still using
                this key will start receiving 401 responses.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor={revokeTokenId}>
                Type{" "}
                <span className="break-all font-mono font-semibold text-foreground">
                  {revokingKey?.label ?? "the key label"}
                </span>{" "}
                to confirm
              </Label>
              <Input
                id={revokeTokenId}
                value={revokeToken}
                disabled={revokePending}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={
                  revokeToken.length > 0 && revokeToken !== revokingKey?.label
                }
                aria-describedby={revokeError ? revokeErrorId : undefined}
                onChange={(event) => {
                  setRevokeToken(event.target.value);
                  setRevokeError(null);
                }}
              />
            </div>
            {revokeError ? (
              <div
                ref={revokeErrorRef}
                id={revokeErrorId}
                role="alert"
                tabIndex={-1}
                className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {revokeError}
              </div>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost" type="button" disabled={revokePending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                variant="destructive"
                disabled={
                  revokePending ||
                  !revokingKey ||
                  revokeToken !== revokingKey.label
                }
                loading={revokePending}
              >
                {revokePending ? "Revoking…" : "Revoke key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={rotateId !== null} onOpenChange={closeRotate}>
        <DialogContent
          aria-busy={rotatePending}
          className="[&_button]:min-h-11 sm:[&_button]:min-h-9"
          onEscapeKeyDown={(event) => {
            if (rotatePendingRef.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (rotatePendingRef.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (revealOpen) return;
            event.preventDefault();
            restoreDialogFocus(actionTriggerRef.current);
          }}
        >
          <DialogHeader>
            <DialogTitle>Rotate this key?</DialogTitle>
            <DialogDescription>
              Rotation revokes {rotatingKey?.label ?? "the current key"}
              immediately and creates a new secret with the same scopes. Update
              every consumer as soon as you copy the replacement.
            </DialogDescription>
          </DialogHeader>
          {rotateError ? (
            <div
              ref={rotateErrorRef}
              id={rotateErrorId}
              role="alert"
              tabIndex={-1}
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {rotateError}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" type="button" disabled={rotatePending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => void handleConfirmRotate()}
              disabled={rotatePending}
              loading={rotatePending}
              aria-describedby={rotateError ? rotateErrorId : undefined}
            >
              {rotatePending ? "Rotating…" : "Rotate and revoke old key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  // aria-sort is only honoured on a columnheader — on the inner button (role
  // button) assistive tech ignores it, so the sort state was never announced.
  return (
    <th
      scope="col"
      className="text-left px-3 py-2 font-medium"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        <span aria-hidden className="text-xs">
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

function filterKeys(keys: ApiKey[], search: string): ApiKey[] {
  const q = search.trim().toLowerCase();
  if (!q) return keys;
  return keys.filter((k) => {
    const mode = k.sandboxOnly ? "sandbox" : "live";
    return (
      k.label.toLowerCase().includes(q) ||
      mode.includes(q) ||
      k.scopes.some((s) => s.toLowerCase().includes(q))
    );
  });
}

function sameScopes(left: ApiKeyScope[], right: ApiKeyScope[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((scope) => expected.has(scope));
}

function sortKeys(
  keys: ApiKey[],
  sort: { key: SortKey; dir: SortDir },
): ApiKey[] {
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...keys].sort((a, b) => {
    if (sort.key === "label") {
      return a.label.localeCompare(b.label) * factor;
    }
    const av = a[sort.key] ? new Date(a[sort.key] as string).getTime() : 0;
    const bv = b[sort.key] ? new Date(b[sort.key] as string).getTime() : 0;
    return (av - bv) * factor;
  });
}
