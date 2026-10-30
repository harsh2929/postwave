// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Data hygiene — what counts as the same person, and what counts as personal.
 *
 * Three `/api/v1/settings/*` paths desktop reached and web did not.
 *
 * MERGING IS DESTRUCTIVE AND THE THRESHOLD DOES NOT LOOK LIKE IT. A merge
 * confidence of 0.95 renders as a tidy "95%", which reads like a quality score
 * rather than the line below which two records are treated as one person and
 * one of them stops existing separately. The page says which direction is
 * riskier rather than presenting the number alone.
 *
 * `built_in_fields` is shown apart from workspace-declared `fields` because
 * email and phone are always personal data — listing them together would make
 * the built-ins look like something you could remove.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Combine, ScanSearch, ShieldCheck } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import {
  DeduplicationThresholdEditor,
  IdentifierTransformsEditor,
  PiiFieldsEditor,
} from "./data-hygiene-controls";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import {
  getDeduplicationSettings,
  getIdentifierTransforms,
  getPiiConfig,
  type DeduplicationSettings,
  type IdentifierTransforms,
  type PiiConfig,
} from "@/lib/data-hygiene-api";
import { base, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

export default function DataHygienePage() {
  const queryClient = useQueryClient();
  const [transformDirty, setTransformDirty] = useState(false);
  const [dedupeDirty, setDedupeDirty] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const effectiveRole = meQuery.data?.viewer_mode
    ? "viewer"
    : meQuery.data
      ? effectiveAuthRole(meQuery.data)
      : null;
  const permissionKnown = meQuery.isSuccess;
  const canWrite = Boolean(
    permissionKnown &&
    !meQuery.data?.viewer_mode &&
    roleCanWrite(effectiveRole),
  );
  const userId = meQuery.data?.user_id ?? "anon";
  const viewerState = meQuery.data?.viewer_mode
    ? "viewer-mode"
    : "durable-mode";
  const keyBase = useMemo(
    () =>
      [
        ...base(
          "data-hygiene",
          meQuery.data?.tenant_id ?? "anon",
          effectiveRole,
        ),
        userId,
        viewerState,
      ] as const,
    [effectiveRole, meQuery.data?.tenant_id, userId, viewerState],
  );
  const previousKeyRef = useRef<readonly unknown[] | null>(null);
  const operationRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const transforms = useQuery({
    queryKey: [...keyBase, "transforms"],
    queryFn: getIdentifierTransforms,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const dedupe = useQuery({
    queryKey: [...keyBase, "dedupe"],
    queryFn: getDeduplicationSettings,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const pii = useQuery({
    queryKey: [...keyBase, "pii"],
    queryFn: getPiiConfig,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });

  const t = transforms.data;
  const builtIn = Array.isArray(pii.data?.built_in_fields)
    ? pii.data.built_in_fields
    : [];
  const declared = Array.isArray(pii.data?.fields)
    ? pii.data.fields.filter(
        (field) => !field.built_in && !builtIn.includes(field.field_name),
      )
    : [];
  const maskedDeclared = declared.filter(
    (field) => field.sensitive === true,
  ).length;
  const unknownDeclared = declared.filter(
    (field) => field.sensitive === null,
  ).length;
  const threshold = dedupe.data?.merge_confidence_threshold;
  const thresholdValid =
    typeof threshold === "number" && threshold >= 0 && threshold <= 1;
  const refreshing =
    meQuery.isFetching ||
    transforms.isFetching ||
    dedupe.isFetching ||
    pii.isFetching;
  const dirty = transformDirty || dedupeDirty;
  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    const previous = previousKeyRef.current;
    if (previous && previous !== keyBase) {
      controllerRef.current?.abort();
      operationRef.current = false;
      void queryClient.cancelQueries({ queryKey: previous });
      queryClient.removeQueries({ queryKey: previous });
      setTransformDirty(false);
      setDedupeDirty(false);
      setResetVersion((version) => version + 1);
    }
    previousKeyRef.current = keyBase;
    if (!meQuery.isSuccess) {
      controllerRef.current?.abort();
      operationRef.current = false;
      void queryClient.cancelQueries({ queryKey: keyBase });
      queryClient.removeQueries({ queryKey: keyBase });
      setTransformDirty(false);
      setDedupeDirty(false);
      setResetVersion((version) => version + 1);
    }
  }, [keyBase, meQuery.isSuccess, queryClient]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const runAdmin = useCallback(
    async <T,>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      if (!canWrite || !meQuery.data || operationRef.current)
        throw new Error(
          "Owner or admin access is required or another data-hygiene action is running.",
        );
      operationRef.current = true;
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        await verifyFreshAdminAuthority(meQuery.data, controller.signal);
        return await operation(controller.signal);
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        operationRef.current = false;
      }
    },
    [canWrite, meQuery.data],
  );

  const saveTransformsToCache = useCallback(
    (saved: IdentifierTransforms) => {
      queryClient.setQueryData([...keyBase, "transforms"], saved);
    },
    [keyBase, queryClient],
  );
  const saveDedupeToCache = useCallback(
    (saved: DeduplicationSettings) => {
      queryClient.setQueryData([...keyBase, "dedupe"], saved);
    },
    [keyBase, queryClient],
  );
  const savePiiToCache = useCallback(
    (saved: PiiConfig) => {
      queryClient.setQueryData([...keyBase, "pii"], saved);
    },
    [keyBase, queryClient],
  );

  function refreshAll() {
    if (
      dirty &&
      typeof window !== "undefined" &&
      !window.confirm("Discard unsaved data-hygiene changes and refresh?")
    ) {
      return;
    }
    if (dirty) {
      setTransformDirty(false);
      setDedupeDirty(false);
      setResetVersion((version) => version + 1);
    }
    void transforms.refetch();
    void dedupe.refetch();
    void pii.refetch();
  }

  if (meQuery.isError) {
    return (
      <PageShell className="max-w-5xl">
        <GovernancePageHeader
          icon={ScanSearch}
          title="Data hygiene"
          description="The identity rules that decide which records are the same person and which fields are treated as personal data."
        />
        <GovernanceError
          message="Workspace identity could not be verified. No data-hygiene policy was requested and editing remains disabled."
          retrying={meQuery.isFetching}
          onRetry={() => void meQuery.refetch()}
        />
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={ScanSearch}
        title="Data hygiene"
        description="The identity rules that decide which records are the same person and which fields are treated as personal data."
        refreshLabel="Refresh hygiene"
        refreshing={refreshing}
        onRefresh={refreshAll}
      />

      <GovernanceSection
        icon={Combine}
        title="Merging"
        description="This is a destructive identity threshold, not a quality score."
      >
        {dedupe.isPending ? (
          <GovernanceLoading label="Loading deduplication settings…" rows={3} />
        ) : dedupe.isError ? (
          <GovernanceError
            message="Could not load deduplication settings. No merge behaviour is being inferred."
            retrying={dedupe.isFetching}
            onRetry={() => void dedupe.refetch()}
          />
        ) : dedupe.data && thresholdValid ? (
          <>
            <GovernanceMetrics
              columns={2}
              items={[
                {
                  label: "Merge threshold",
                  value: `${(threshold * 100).toFixed(0)}%`,
                  detail: "Records at or above this confidence are merged",
                },
                {
                  label: "Risk direction",
                  value: "Lower is broader",
                  detail: "Lowering the threshold merges more aggressively",
                },
              ]}
            />
            {/* The number alone reads like a quality score. Say what moving it
                actually does. */}
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Two records are treated as the same person at or above this
              confidence. Lowering it merges more aggressively—merged records
              stop existing separately, so the risk of a low threshold is losing
              a distinct person, not just a duplicate.
            </p>
            <DeduplicationThresholdEditor
              value={dedupe.data}
              canWrite={canWrite}
              permissionKnown={permissionKnown}
              resetVersion={resetVersion}
              onSaved={saveDedupeToCache}
              onDirtyChange={setDedupeDirty}
              runAdmin={runAdmin}
            />
          </>
        ) : (
          <GovernanceError
            message={`The merge threshold is outside its valid 0–1 range${typeof threshold === "number" ? ` (${threshold})` : ""}. Treat deduplication behaviour as unknown.`}
            retrying={dedupe.isFetching}
            onRetry={() => void dedupe.refetch()}
          />
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={AtSign}
        title="Identifier normalisation"
        description="These rules change which email addresses and phone numbers resolve to the same identity."
      >
        {transforms.isPending ? (
          <GovernanceLoading label="Loading identifier transforms…" rows={3} />
        ) : transforms.isError ? (
          <GovernanceError
            message="Could not load identifier transforms. No rule is being shown as on or off."
            retrying={transforms.isFetching}
            onRetry={() => void transforms.refetch()}
          />
        ) : t ? (
          <IdentifierTransformsEditor
            value={t}
            canWrite={canWrite}
            permissionKnown={permissionKnown}
            resetVersion={resetVersion}
            onSaved={saveTransformsToCache}
            onDirtyChange={setTransformDirty}
            runAdmin={runAdmin}
          />
        ) : (
          <GovernanceEmpty>No identifier transforms reported.</GovernanceEmpty>
        )}
        {t?.phone_e164_format && !t.phone_default_region ? (
          <p className="mt-3 rounded-lg bg-warning-subtle px-3 py-2.5 text-sm leading-5 text-warning-emphasis">
            E.164 formatting is on with no default region set, so numbers
            without a country code cannot be normalised.
          </p>
        ) : null}
      </GovernanceSection>

      <GovernanceSection
        icon={ShieldCheck}
        title="Personal data fields"
        description="Built-in personal fields cannot be removed; workspace declarations are additional."
      >
        {pii.isPending ? (
          <GovernanceLoading
            label="Loading personal-data configuration…"
            rows={3}
          />
        ) : pii.isError ? (
          <GovernanceError
            message="Could not load the PII configuration. No field is being claimed as protected or unprotected."
            retrying={pii.isFetching}
            onRetry={() => void pii.refetch()}
          />
        ) : pii.data ? (
          <>
            {/* Built-ins shown apart: they are always personal data and cannot
                be removed, which a merged list would obscure. */}
            <GovernanceMetrics
              columns={2}
              items={[
                {
                  label: "Always personal",
                  value: builtIn.length.toLocaleString(),
                  detail: builtIn.join(", ") || "No built-ins reported",
                },
                {
                  label: "Workspace fields",
                  value: declared.length.toLocaleString(),
                  detail:
                    declared.length === 0
                      ? "No additional fields declared"
                      : `${maskedDeclared.toLocaleString()} masked${unknownDeclared > 0 ? ` · ${unknownDeclared.toLocaleString()} state not reported` : ""}`,
                },
              ]}
            />
            <PiiFieldsEditor
              value={pii.data}
              canWrite={canWrite}
              permissionKnown={permissionKnown}
              onSaved={savePiiToCache}
              runAdmin={runAdmin}
            />
          </>
        ) : (
          <GovernanceEmpty>
            No personal-data configuration was reported.
          </GovernanceEmpty>
        )}
      </GovernanceSection>
    </PageShell>
  );
}
