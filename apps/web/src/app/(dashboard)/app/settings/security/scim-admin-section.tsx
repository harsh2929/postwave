// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound, Users } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
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
import { ScimTokenPrefixCopy } from "@/components/settings/scim-token-prefix-copy";
import { ScimTokenReveal } from "@/components/settings/scim-token-reveal";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { STALE } from "@/lib/query-keys";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { newUUIDv7 } from "@/lib/http-fetch";
import { useOnline } from "@/lib/use-online";
import {
  deleteRoleMapping,
  isTokenActive,
  listRoleMappings,
  listScimTokens,
  mintScimToken,
  normalizeRoleMappingInput,
  revokeScimToken,
  SCIM_ROLES,
  upsertRoleMapping,
  type MintedToken,
  type RoleMapping,
} from "@/lib/scim-api";
import { useSettingsQueryKey } from "./settings-query-key";

export function ScimAdminSection() {
  return (
    <>
      <ScimTokensCard />
      <RoleMappingsCard />
    </>
  );
}

function ScimTokensCard() {
  const queryClient = useQueryClient();
  const online = useOnline();
  const {
    queryKey: tokensKey,
    enabled: tokensEnabled,
    identityLoading,
    identityError,
    identity,
    authorityKey,
  } = useSettingsQueryKey("security-scim-tokens", { adminOnly: true });
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [description, setDescription] = useState("");
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const authorityKeyRef = useRef(authorityKey);
  authorityKeyRef.current = authorityKey;

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    workingRef.current = false;
    setWorking(false);
    setMinted(null);
    setDescription("");
    return () => {
      controllerRef.current?.abort();
    };
  }, [authorityKey]);

  const tokensQuery = useQuery({
    queryKey: tokensKey,
    queryFn: ({ signal }) => listScimTokens({ signal }),
    enabled: tokensEnabled,
    retry: false,
    staleTime: STALE.list,
  });
  const tokens =
    tokensQuery.data ??
    (identityLoading || (tokensQuery.isPending && !tokensQuery.data)
      ? null
      : []);

  useEffect(() => {
    if (!tokensQuery.error) return;
    toast.error(
      tokensQuery.error instanceof ApiError && tokensQuery.error.status === 403
        ? "SCIM administration access is no longer available."
        : tokensQuery.error instanceof Error
          ? tokensQuery.error.message
          : "Could not load tokens.",
    );
  }, [tokensQuery.error]);

  const invalidateTokens = (): void => {
    void queryClient.invalidateQueries({ queryKey: tokensKey, exact: true });
  };

  async function mint() {
    if (!identity || workingRef.current) return;
    if (online === "offline") {
      toast.error("Reconnect before minting a SCIM token.");
      return;
    }
    const intentDescription = description.trim();
    const openedAuthorityKey = authorityKey;
    const controller = new AbortController();
    workingRef.current = true;
    controllerRef.current = controller;
    setWorking(true);
    try {
      await queryClient.cancelQueries({ queryKey: tokensKey, exact: true });
      await verifyFreshAdminAuthority(identity, controller.signal);
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      const token = await mintScimToken(intentDescription, {
        signal: controller.signal,
        idempotencyKey: newUUIDv7(),
      });
      let readback: Awaited<ReturnType<typeof listScimTokens>> | null = null;
      try {
        readback = await listScimTokens({ signal: controller.signal });
      } catch {
        // The one-shot credential must remain visible even when verification
        // fails; hiding it would create an active token nobody can recover.
      }
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      setMinted(token);
      setDescription("");
      const confirmed = Boolean(
        readback?.some(
          (candidate) =>
            candidate.prefix === token.prefix && isTokenActive(candidate),
        ),
      );
      if (readback) queryClient.setQueryData(tokensKey, readback);
      else invalidateTokens();
      if (!confirmed) {
        toast.warning(
          "The token was minted and is shown below, but the live token list could not confirm it. Store it now, then refresh before minting another.",
        );
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthorityKey
      )
        return;
      toast.error(err instanceof Error ? err.message : "Could not mint token.");
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  async function revoke(tokenId: string) {
    if (!identity || workingRef.current) return;
    if (online === "offline") {
      throw new Error("Reconnect before revoking a SCIM token.");
    }
    const intentId = tokenId;
    const openedAuthorityKey = authorityKey;
    const controller = new AbortController();
    workingRef.current = true;
    controllerRef.current = controller;
    setWorking(true);
    try {
      await queryClient.cancelQueries({ queryKey: tokensKey, exact: true });
      await verifyFreshAdminAuthority(identity, controller.signal);
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      await revokeScimToken(intentId, {
        signal: controller.signal,
        idempotencyKey: newUUIDv7(),
      });
      let readback: Awaited<ReturnType<typeof listScimTokens>> | null = null;
      try {
        readback = await listScimTokens({ signal: controller.signal });
      } catch {
        // A 204 receipt proves the effect; readback failure is reported below.
      }
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      toast.success("Token revoked.");
      const confirmed = Boolean(
        readback &&
        !readback.some(
          (candidate) => candidate.id === intentId && isTokenActive(candidate),
        ),
      );
      if (readback) queryClient.setQueryData(tokensKey, readback);
      else invalidateTokens();
      if (!confirmed) {
        toast.warning(
          "Revocation was accepted, but the live token list could not confirm it. Refresh before relying on this status.",
        );
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthorityKey
      )
        return;
      toast.error(err instanceof Error ? err.message : "Could not revoke.");
      throw err;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>SCIM provisioning tokens</CardTitle>
        <CardDescription>
          Bearer tokens your IdP uses to provision and de-provision users via
          SCIM. The full token is shown once at creation — store it securely.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {identityError || tokensQuery.isError ? (
          <ScimReadError
            message={
              tokensQuery.error instanceof ApiError &&
              tokensQuery.error.status === 403
                ? "SCIM token access was refused. Your role or viewer-mode state may have changed."
                : "Could not verify the SCIM token inventory. This is a failed security read, not an empty token list."
            }
            retrying={tokensQuery.isFetching}
            disabled={online === "offline" || identityError}
            onRetry={() => void tokensQuery.refetch()}
          />
        ) : null}
        {minted && (
          <ScimTokenReveal
            key={minted.prefix}
            minted={minted}
            onDismiss={() => setMinted(null)}
          />
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="scim-desc">Description (optional)</Label>
            <Input
              id="scim-desc"
              value={description}
              maxLength={1_024}
              onChange={(e) => setDescription(e.target.value)}
              disabled={working || online === "offline" || !tokensEnabled}
              placeholder="Okta production"
            />
          </div>
          <Button
            type="button"
            onClick={() => void mint()}
            disabled={
              working ||
              online === "offline" ||
              !tokensEnabled ||
              tokensQuery.isError
            }
          >
            {working ? "Minting…" : "Mint token"}
          </Button>
        </div>

        {identityError || tokensQuery.isError ? null : tokens === null ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : tokens.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No SCIM tokens yet"
            description="Mint a token above to let your identity provider provision users."
          />
        ) : (
          <div
            role="region"
            aria-label="SCIM tokens"
            tabIndex={0}
            className="border rounded-md overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    Prefix
                  </th>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    Description
                  </th>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="text-right px-3 py-2 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{t.prefix}…</td>
                    <td className="px-3 py-2">{t.description || "—"}</td>
                    <td className="px-3 py-2">
                      <Badge
                        variant={isTokenActive(t) ? "success" : "secondary"}
                      >
                        {isTokenActive(t) ? "Active" : "Revoked"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <ScimTokenPrefixCopy
                          prefix={t.prefix}
                          disabled={working || online === "offline"}
                        />
                        {isTokenActive(t) && (
                          <ConfirmDialog
                            trigger={
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                disabled={working || online === "offline"}
                              >
                                Revoke
                              </Button>
                            }
                            title="Revoke this SCIM token?"
                            description="The IdP using this token will lose access immediately. This cannot be undone."
                            confirmLabel="Revoke"
                            onConfirm={() => revoke(t.id)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {online === "offline" ? (
          <p role="note" className="text-sm text-muted-foreground">
            Reconnect to manage SCIM tokens. Credentials and revocations are
            never queued for later replay.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// SETC-011: surface the active SCIM group → role mapping admin without
// implying that the release-held SAML/JIT sign-in path consumes it.
function RoleMappingsCard() {
  const queryClient = useQueryClient();
  const online = useOnline();
  const {
    queryKey: mappingsKey,
    enabled,
    identityLoading,
    identityError,
    identity,
    authorityKey,
  } = useSettingsQueryKey("security-scim-role-mappings", { adminOnly: true });
  const [group, setGroup] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [precedence, setPrecedence] = useState("0");
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const authorityKeyRef = useRef(authorityKey);
  authorityKeyRef.current = authorityKey;

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    workingRef.current = false;
    setWorking(false);
    setGroup("");
    setRole("viewer");
    setPrecedence("0");
    return () => {
      controllerRef.current?.abort();
    };
  }, [authorityKey]);

  const mappingsQuery = useQuery({
    queryKey: mappingsKey,
    queryFn: ({ signal }) => listRoleMappings({ signal }),
    enabled,
    retry: false,
    staleTime: STALE.list,
  });
  const mappings: RoleMapping[] | null =
    mappingsQuery.data ??
    (identityLoading || (mappingsQuery.isPending && !mappingsQuery.data)
      ? null
      : []);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: mappingsKey, exact: true });
  };

  async function upsert() {
    if (!identity || workingRef.current) return;
    if (online === "offline") {
      toast.error("Reconnect before saving a SCIM role mapping.");
      return;
    }
    let input;
    try {
      input = normalizeRoleMappingInput({
        group_name: group,
        role,
        precedence: Number(precedence) || 0,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid mapping.");
      return;
    }
    const openedAuthorityKey = authorityKey;
    const controller = new AbortController();
    workingRef.current = true;
    controllerRef.current = controller;
    setWorking(true);
    try {
      await queryClient.cancelQueries({ queryKey: mappingsKey, exact: true });
      await verifyFreshAdminAuthority(identity, controller.signal);
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      const receipt = await upsertRoleMapping(input, {
        signal: controller.signal,
        idempotencyKey: newUUIDv7(),
      });
      let readback: Awaited<ReturnType<typeof listRoleMappings>> | null = null;
      try {
        readback = await listRoleMappings({ signal: controller.signal });
      } catch {
        // The create/update receipt is still useful; report verification
        // separately and force a scoped refresh.
      }
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      toast.success(`Mapped ${input.group_name} → ${input.role}.`);
      setGroup("");
      setPrecedence("0");
      const confirmed = Boolean(
        readback?.some(
          (candidate) =>
            candidate.id === receipt.id &&
            candidate.group_name === receipt.group_name &&
            candidate.role === receipt.role &&
            candidate.precedence === receipt.precedence,
        ),
      );
      if (readback) queryClient.setQueryData(mappingsKey, readback);
      else invalidate();
      if (!confirmed) {
        toast.warning(
          "The mapping write was accepted, but the live mapping list could not confirm it. Refresh before relying on the displayed mapping.",
        );
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthorityKey
      )
        return;
      toast.error(
        err instanceof Error ? err.message : "Could not save mapping.",
      );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  async function remove(mappingId: string) {
    if (!identity || workingRef.current) return;
    if (online === "offline") {
      throw new Error("Reconnect before deleting a SCIM role mapping.");
    }
    const intentId = mappingId;
    const openedAuthorityKey = authorityKey;
    const controller = new AbortController();
    workingRef.current = true;
    controllerRef.current = controller;
    setWorking(true);
    try {
      await queryClient.cancelQueries({ queryKey: mappingsKey, exact: true });
      await verifyFreshAdminAuthority(identity, controller.signal);
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      await deleteRoleMapping(intentId, {
        signal: controller.signal,
        idempotencyKey: newUUIDv7(),
      });
      let readback: Awaited<ReturnType<typeof listRoleMappings>> | null = null;
      try {
        readback = await listRoleMappings({ signal: controller.signal });
      } catch {
        // The 204 receipt confirms deletion; verification failure is distinct.
      }
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      toast.success("Mapping deleted.");
      const confirmed = Boolean(
        readback && !readback.some((candidate) => candidate.id === intentId),
      );
      if (readback) queryClient.setQueryData(mappingsKey, readback);
      else invalidate();
      if (!confirmed) {
        toast.warning(
          "Deletion was accepted, but the live mapping list could not confirm it. Refresh before relying on this status.",
        );
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthorityKey
      )
        return;
      toast.error(err instanceof Error ? err.message : "Could not delete.");
      throw err;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        workingRef.current = false;
        setWorking(false);
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>SCIM group → role mappings</CardTitle>
        <CardDescription>
          Map an identity-provider SCIM group to a Moosewave role. These mappings
          apply when SCIM provisions or activates a user and when SCIM group
          membership changes. SAML/JIT sign-in remains unavailable; mappings do
          not enable SSO.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {identityError || mappingsQuery.isError ? (
          <ScimReadError
            message={
              mappingsQuery.error instanceof ApiError &&
              mappingsQuery.error.status === 403
                ? "SCIM mapping access was refused. Your role or viewer-mode state may have changed."
                : "Could not verify SCIM role mappings. This is a failed security read, not an empty mapping list."
            }
            retrying={mappingsQuery.isFetching}
            disabled={online === "offline" || identityError}
            onRetry={() => void mappingsQuery.refetch()}
          />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem_8rem_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="rm-group">IdP group</Label>
            <Input
              id="rm-group"
              value={group}
              maxLength={1_024}
              onChange={(e) => setGroup(e.target.value)}
              disabled={
                working ||
                online === "offline" ||
                !enabled ||
                mappingsQuery.isError
              }
              placeholder="okta-admins"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rm-role">Role</Label>
            <select
              id="rm-role"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={
                working ||
                online === "offline" ||
                !enabled ||
                mappingsQuery.isError
              }
            >
              {SCIM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rm-prec">Precedence</Label>
            <Input
              id="rm-prec"
              type="number"
              min={0}
              max={1000}
              value={precedence}
              onChange={(e) => setPrecedence(e.target.value)}
              disabled={
                working ||
                online === "offline" ||
                !enabled ||
                mappingsQuery.isError
              }
            />
          </div>
          <Button
            type="button"
            onClick={() => void upsert()}
            disabled={
              working ||
              online === "offline" ||
              !enabled ||
              mappingsQuery.isError ||
              !group.trim()
            }
          >
            {working ? "Saving…" : "Add mapping"}
          </Button>
        </div>

        {identityError || mappingsQuery.isError ? null : mappings === null ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : mappings.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No group mappings yet"
            description="Add a mapping above so SCIM-provisioned users resolve to Moosewave roles from their group memberships."
          />
        ) : (
          <div
            role="region"
            aria-label="SCIM group mappings"
            tabIndex={0}
            className="border rounded-md overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    IdP group
                  </th>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    Role
                  </th>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    Precedence
                  </th>
                  <th scope="col" className="text-right px-3 py-2 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">
                      {m.group_name}
                    </td>
                    <td className="px-3 py-2 capitalize">{m.role}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {m.precedence}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <ConfirmDialog
                        trigger={
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={working || online === "offline"}
                          >
                            Delete
                          </Button>
                        }
                        title="Delete this mapping?"
                        description={`Users in "${m.group_name}" will no longer be mapped to ${m.role}. Existing sessions are unaffected.`}
                        confirmLabel="Delete"
                        onConfirm={() => remove(m.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {online === "offline" ? (
          <p role="note" className="text-sm text-muted-foreground">
            Reconnect to manage SCIM mappings. Administration writes are never
            queued for later replay.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ScimReadError({
  message,
  retrying,
  disabled,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  disabled: boolean;
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
        disabled={disabled}
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}
